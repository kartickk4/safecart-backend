const path = require('path');
const fs = require('fs');

function loadMod(type, name) {
  const candidates = [
    path.resolve(__dirname, '..', type, name),
    path.resolve(__dirname, type, name),
    path.resolve(__dirname, name),
    path.resolve(process.cwd(), 'src', type, name),
    path.resolve(process.cwd(), type, name),
    path.resolve(process.cwd(), name)
  ];
  for (const c of candidates) {
    if (fs.existsSync(c + '.js')) return require(c + '.js');
    if (fs.existsSync(c)) return require(c);
  }
  try { return require(`../${type}/${name}`); } catch(e) {}
  try { return require(`./${type}/${name}`); } catch(e) {}
  return require(`./${name}`);
}

const User = loadMod('models', 'User');

/**
 * @desc    Get current user profile details
 * @route   GET /api/v1/profile
 * @access  Private
 */
const getProfile = async (req, res) => {
  try {
    // If not pro on this role, check if user is pro on their other role account
    if (req.user && !req.user.isPro && req.user.email) {
      const proSibling = await User.findOne({
        email: req.user.email.toLowerCase().trim(),
        isPro: true
      });
      if (proSibling) {
        req.user.isPro = true;
        req.user.proPlan = proSibling.proPlan || 'Pro';
        req.user.proUpgradedAt = proSibling.proUpgradedAt || new Date();
        await req.user.save();
      }
    }

    // Check if bank details are missing on this account but exist on a sibling account
    if (req.user && (!req.user.bankDetails || !req.user.bankDetails.accountNumber) && req.user.email) {
      const bankSibling = await User.findOne({
        email: req.user.email.toLowerCase().trim(),
        'bankDetails.accountNumber': { $exists: true, $ne: '' }
      });
      if (bankSibling && bankSibling.bankDetails && bankSibling.bankDetails.accountNumber) {
        req.user.bankDetails = {
          accountHolderName: bankSibling.bankDetails.accountHolderName || '',
          accountNumber: bankSibling.bankDetails.accountNumber || '',
          ifscCode: bankSibling.bankDetails.ifscCode || '',
          bankName: bankSibling.bankDetails.bankName || '',
          upiId: bankSibling.bankDetails.upiId || ''
        };
        await req.user.save();
      }
    }
    // req.user has already been populated by protect middleware
    res.json(req.user);
  } catch (error) {
    console.error('Get Profile Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * @desc    Update user profile or payout bank details
 * @route   PUT /api/v1/profile
 * @access  Private
 */
const updateProfile = async (req, res) => {
  const { fullName, avatarUrl, bankDetails, role, phone, email } = req.body;

  try {
    const user = await User.findById(req.user._id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Update basic fields if provided
    if (fullName) user.fullName = fullName.trim();
    if (avatarUrl !== undefined) user.avatarUrl = avatarUrl;
    if (role && ['User', 'Supplier', 'Receiver', 'Admin'].includes(role)) {
      user.role = role === 'User' ? 'Receiver' : role;
    }
    if (req.body.platformType !== undefined) {
      user.platformType = req.body.platformType;
    }
    if (req.body.isPro !== undefined) {
      const proVal = Boolean(req.body.isPro);
      user.isPro = proVal;
      user.proPlan = proVal ? 'Pro' : 'Standard';
      if (proVal && !user.proUpgradedAt) {
        user.proUpgradedAt = new Date();
      }
      if (user.email) {
        await User.updateMany(
          { email: user.email.toLowerCase().trim() },
          { $set: { isPro: proVal, proPlan: user.proPlan, proUpgradedAt: user.proUpgradedAt } }
        );
      }
    }

    if (phone) {
      const normalizedPhone = phone.trim();
      const last10 = normalizedPhone.replace(/\D/g, '').slice(-10);
      const phoneVariants = [
        normalizedPhone,
        last10,
        `+91${last10}`,
        `+91 ${last10}`
      ];

      const existingPhoneUsers = await User.find({
        phone: { $in: phoneVariants },
        _id: { $ne: user._id }
      });

      for (const existingPhone of existingPhoneUsers) {
        const isPlaceholder = existingPhone.email && (
          existingPhone.email.endsWith('@securekaro-otp.in') ||
          existingPhone.email.endsWith('@safecart-otp.in') ||
          existingPhone.email.includes('-otp.in')
        );

        if (isPlaceholder) {
          // Clean up phantom OTP placeholder account
          await User.deleteOne({ _id: existingPhone._id });
        } else if (existingPhone.email && existingPhone.email.toLowerCase().trim() !== user.email?.toLowerCase().trim()) {
          return res.status(400).json({ error: 'This phone number is already registered with another account.' });
        }
      }

      user.phone = normalizedPhone;
      if (req.body.isPhoneVerified !== undefined) {
        user.isPhoneVerified = Boolean(req.body.isPhoneVerified);
      }

      // Sync verified phone to sibling account with same email if exists (e.g. Supplier/Receiver pair)
      if (user.email) {
        await User.updateMany(
          { email: user.email.toLowerCase().trim(), _id: { $ne: user._id } },
          { $set: { phone: normalizedPhone, ...(req.body.isPhoneVerified !== undefined ? { isPhoneVerified: Boolean(req.body.isPhoneVerified) } : {}) } }
        );
      }
    }

    if (email) {
      const normalizedEmail = email.toLowerCase().trim();
      const existingEmail = await User.findOne({ email: normalizedEmail, _id: { $ne: user._id } });
      if (existingEmail) {
        return res.status(400).json({ error: 'This email is already registered with another account.' });
      }
      user.email = normalizedEmail;
    }

    // Update address & pickup location details if provided
    if (req.body.address !== undefined) user.address = (req.body.address || '').trim();
    if (req.body.city !== undefined) user.city = (req.body.city || '').trim();
    if (req.body.state !== undefined) user.state = (req.body.state || '').trim();
    if (req.body.pincode !== undefined) user.pincode = (req.body.pincode || '').trim();

    if (req.body.pickupAddress !== undefined) {
      const pa = req.body.pickupAddress || {};
      user.pickupAddress = {
        street: pa.street !== undefined ? (pa.street || '').trim() : (user.pickupAddress?.street || user.address || ''),
        city: pa.city !== undefined ? (pa.city || '').trim() : (user.pickupAddress?.city || user.city || ''),
        state: pa.state !== undefined ? (pa.state || '').trim() : (user.pickupAddress?.state || user.state || ''),
        pincode: pa.pincode !== undefined ? (pa.pincode || '').trim() : (user.pickupAddress?.pincode || user.pincode || ''),
        landmark: pa.landmark !== undefined ? (pa.landmark || '').trim() : (user.pickupAddress?.landmark || '')
      };
      if (pa.street && !user.address) user.address = (pa.street || '').trim();
      if (pa.city && !user.city) user.city = (pa.city || '').trim();
      if (pa.state && !user.state) user.state = (pa.state || '').trim();
      if (pa.pincode && !user.pincode) user.pincode = (pa.pincode || '').trim();
    } else if (req.body.address || req.body.city || req.body.state || req.body.pincode) {
      user.pickupAddress = {
        street: user.address || '',
        city: user.city || '',
        state: user.state || '',
        pincode: user.pincode || '',
        landmark: user.pickupAddress?.landmark || ''
      };
    }

    // Update bank details if provided
    if (bankDetails) {
      user.bankDetails = {
        accountHolderName: (bankDetails.accountHolderName !== undefined ? bankDetails.accountHolderName : user.bankDetails?.accountHolderName) || '',
        accountNumber: (bankDetails.accountNumber !== undefined ? bankDetails.accountNumber : user.bankDetails?.accountNumber) || '',
        ifscCode: (bankDetails.ifscCode !== undefined ? bankDetails.ifscCode : user.bankDetails?.ifscCode) || '',
        bankName: (bankDetails.bankName !== undefined ? bankDetails.bankName : user.bankDetails?.bankName) || '',
        upiId: (bankDetails.upiId !== undefined ? bankDetails.upiId : user.bankDetails?.upiId) || ''
      };

      // Sync updated bank details across all accounts sharing this user's email or phone
      try {
        const syncConditions = [];
        if (user.email) syncConditions.push({ email: user.email.toLowerCase().trim() });
        if (user.phone) syncConditions.push({ phone: user.phone.trim() });
        if (syncConditions.length > 0) {
          await User.updateMany(
            { $or: syncConditions },
            { $set: { bankDetails: user.bankDetails } }
          );
        }
      } catch (syncErr) {
        console.warn('[PROFILE] Bank details sync warning:', syncErr.message);
      }
    }

    const updatedUser = await user.save();

    // Exclude password hash from response
    const userResponse = updatedUser.toObject();
    delete userResponse.passwordHash;

    res.json(userResponse);
  } catch (error) {
    console.error('Update Profile Error:', error);
    res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
};

/**
 * @desc    Upgrade to Pro plan, applying referral credits as discount
 * @route   POST /api/v1/profile/upgrade-pro
 * @access  Private
 */
const upgradeProPlan = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.isPro) {
      return res.status(400).json({ error: 'You are already on the Pro plan.' });
    }

    const PRO_PRICE = 199; // ₹199/month
    const availableCredits = Number(user.referralCredits) || 0;
    // Apply referral credits as discount (max = PRO_PRICE, cannot go negative)
    const creditsToApply = Math.min(availableCredits, PRO_PRICE);
    const finalPrice = PRO_PRICE - creditsToApply;

    // Deduct credits used
    user.referralCredits = parseFloat((availableCredits - creditsToApply).toFixed(2));
    user.referralCreditUsed = parseFloat(((Number(user.referralCreditUsed) || 0) + creditsToApply).toFixed(2));

    // Upgrade to Pro
    user.isPro = true;
    user.proPlan = 'Pro';
    user.proUpgradedAt = new Date();

    await user.save();

    if (user.email) {
      await User.updateMany(
        { email: user.email.toLowerCase().trim() },
        { $set: { isPro: true, proPlan: 'Pro', proUpgradedAt: user.proUpgradedAt } }
      );
    }

    const userResponse = user.toObject();
    delete userResponse.passwordHash;

    console.log(`[PRO UPGRADE] ${user.fullName} upgraded to Pro. Credits used: ₹${creditsToApply}, Final price: ₹${finalPrice}`);

    res.json({
      success: true,
      message: `Pro plan activated! ${creditsToApply > 0 ? `₹${creditsToApply} referral credit applied.` : ''} ${finalPrice > 0 ? `₹${finalPrice} to be paid.` : 'Fully covered by referral credits!'}`,
      finalPrice,
      creditsApplied: creditsToApply,
      remainingCredits: user.referralCredits,
      user: userResponse
    });
  } catch (error) {
    console.error('Pro Upgrade Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * @desc    Get referral stats for current user
 * @route   GET /api/v1/profile/referral-stats
 * @access  Private
 */
const getReferralStats = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select(
      'referralCode referralCredits totalReferralEarned referralCreditUsed fullName'
    );
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (!user.referralCode) {
      user.referralCode = `SK-${user._id.toString().slice(-6).toUpperCase()}`;
      await user.save();
    }

    // Count how many sellers this user has referred
    const referralCount = await User.countDocuments({ referredBy: user._id });

    // Count how many referred sellers have completed their first shipment
    // (i.e. referral credits were actually earned)
    const earnedReferrals = Math.floor((Number(user.totalReferralEarned) || 0) / 40);

    const baseUrl = process.env.FRONTEND_URL?.split(',').find(u => u.includes('5173') || u.includes('3000')) || 'http://localhost:5173';

    res.json({
      referralCode: user.referralCode,
      referralLink: `${baseUrl}/signup?ref=${user.referralCode}`,
      referralCredits: user.referralCredits,
      totalReferralEarned: user.totalReferralEarned,
      referralCreditUsed: user.referralCreditUsed,
      totalReferred: referralCount,
      earnedReferrals,
      pendingReferrals: referralCount - earnedReferrals,
      rewardPerReferral: 40,
      proPrice: 199,
      proAfterCredit: Math.max(0, 199 - (Number(user.referralCredits) || 0))
    });
  } catch (error) {
    console.error('Referral Stats Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * @desc    Send phone verification OTP to logged-in user
 * @route   POST /api/v1/profile/send-phone-otp
 * @access  Private
 */
const sendPhoneVerificationOtp = async (req, res) => {
  const targetPhone = (req.body?.phone || req.user?.phone || '').toString().trim();

  if (!targetPhone) {
    return res.status(400).json({ error: 'Please enter a valid mobile number.' });
  }

  const normalizedPhone = targetPhone.replace(/\s+/g, '');
  const digits = normalizedPhone.replace(/\D/g, '');

  if (digits.length < 10) {
    return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number.' });
  }

  try {
    const last10 = digits.slice(-10);
    const phoneVariants = [
      normalizedPhone,
      last10,
      `+91${last10}`,
      `+91 ${last10}`
    ];

    // Check if phone already registered to another user with the same role
    const existingUsers = await User.find({
      phone: { $in: phoneVariants },
      role: req.user.role,
      _id: { $ne: req.user._id }
    });

    for (const existing of existingUsers) {
      const isPlaceholder = existing.email && (
        existing.email.endsWith('@securekaro-otp.in') ||
        existing.email.endsWith('@safecart-otp.in') ||
        existing.email.includes('-otp.in')
      );
      if (isPlaceholder) {
        await User.deleteOne({ _id: existing._id });
      } else if (existing.email && existing.email.toLowerCase().trim() !== req.user.email?.toLowerCase().trim()) {
        return res.status(400).json({ error: 'This mobile number is already registered and verified with another account.' });
      }
    }

    const Otp = loadMod('models', 'Otp');
    // Generate 6-digit random OTP
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();

    // Clear older OTPs for this phone and role
    await Otp.deleteMany({ identifier: normalizedPhone, type: 'phone', role: req.user.role });

    // Store OTP
    await Otp.create({
      identifier: normalizedPhone,
      otp: otpCode,
      type: 'phone',
      role: req.user.role
    });

    // Send SMS
    const smsService = loadMod('services', 'smsService');
    try {
      if (smsService && smsService.sendSmsOtp) {
        await smsService.sendSmsOtp(normalizedPhone, otpCode);
      }
    } catch (smsErr) {
      console.warn('[SMS Dispatch Warning]:', smsErr.message);
    }

    return res.json({
      message: `Verification OTP sent to ${normalizedPhone}. Valid for 5 minutes.`,
      ...(process.env.NODE_ENV !== 'production' && { debugOtp: otpCode })
    });
  } catch (error) {
    console.error('Send Phone OTP Error:', error);
    return res.status(500).json({ error: 'Failed to send verification OTP. Please try again.' });
  }
};

/**
 * @desc    Verify phone OTP and mark user.isPhoneVerified = true
 * @route   POST /api/v1/profile/verify-phone-otp
 * @access  Private
 */
const verifyPhoneOtp = async (req, res) => {
  const { phone, otp } = req.body;
  const targetPhone = (phone || req.user?.phone || '').toString().trim();

  if (!targetPhone || !otp) {
    return res.status(400).json({ error: 'Both mobile number and 6-digit OTP code are required.' });
  }

  const normalizedPhone = targetPhone.replace(/\s+/g, '');

  try {
    const Otp = loadMod('models', 'Otp');
    const validOtp = await Otp.findOne({
      identifier: normalizedPhone,
      otp: String(otp).trim(),
      type: 'phone',
      role: req.user.role
    });

    if (!validOtp) {
      return res.status(400).json({ error: 'Invalid or expired OTP. Please check the code or request a new one.' });
    }

    // Delete used OTP
    await Otp.deleteOne({ _id: validOtp._id });

    // Clean up any placeholder accounts holding this phone
    const last10 = normalizedPhone.replace(/\D/g, '').slice(-10);
    const phoneVariants = [
      normalizedPhone,
      last10,
      `+91${last10}`,
      `+91 ${last10}`
    ];
    const placeholders = await User.find({
      phone: { $in: phoneVariants },
      _id: { $ne: req.user._id }
    });
    for (const p of placeholders) {
      if (p.email && (p.email.endsWith('@securekaro-otp.in') || p.email.endsWith('@safecart-otp.in') || p.email.includes('-otp.in'))) {
        await User.deleteOne({ _id: p._id });
      }
    }

    // Update user profile
    const user = await User.findById(req.user._id);
    user.phone = normalizedPhone;
    user.isPhoneVerified = true;
    await user.save();

    // Sync sibling account with same email if exists
    if (user.email) {
      await User.updateMany(
        { email: user.email.toLowerCase().trim(), _id: { $ne: user._id } },
        { $set: { phone: normalizedPhone, isPhoneVerified: true } }
      );
    }

    return res.json({
      message: 'Mobile number verified successfully!',
      isPhoneVerified: true,
      phone: user.phone,
      user
    });
  } catch (error) {
    console.error('Verify Phone OTP Error:', error);
    return res.status(500).json({ error: 'Verification failed. Please try again.' });
  }
};

module.exports = {
  getProfile,
  updateProfile,
  upgradeProPlan,
  getReferralStats,
  sendPhoneVerificationOtp,
  verifyPhoneOtp
};
