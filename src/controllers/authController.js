const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
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
  return require(`./${name}`);
}

const User = loadMod('models', 'User');
const Otp = loadMod('models', 'Otp');
const smsService = loadMod('services', 'smsService');
const emailVerifierService = loadMod('services', 'emailVerifierService');

const JWT_SECRET = process.env.JWT_SECRET || 'securekaro_default_fallback_secret_key_2026';

// Helper: Generate long-lived Access Token (30 days)
const generateAccessToken = (id) => {
  return jwt.sign({ id }, JWT_SECRET, {
    expiresIn: '30d',
  });
};

// Helper: Generate unique referral code in format SK-XXXXX
const generateReferralCode = async () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No O/0/1/I confusion
  let code, exists;
  do {
    const suffix = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    code = `SK-${suffix}`;
    exists = await User.findOne({ referralCode: code });
  } while (exists);
  return code;
};

// Helper: Format standardized user response with all profile & Pro subscription fields
const formatUserResponse = (user, activeRole = null) => {
  return {
    id: user._id,
    _id: user._id,
    email: user.email,
    phone: user.phone,
    fullName: user.fullName,
    avatarUrl: user.avatarUrl,
    role: user.role,
    activeRole: activeRole || user.role,
    isPro: Boolean(user.isPro),
    proPlan: user.proPlan || (user.isPro ? 'Pro' : 'Standard'),
    proUpgradedAt: user.proUpgradedAt || null,
    bankDetails: user.bankDetails,
    walletBalance: user.walletBalance || 0,
    cashbackBalance: user.cashbackBalance || 0,
    escrowBalance: user.escrowBalance || 0,
    address: user.address,
    city: user.city,
    state: user.state,
    pincode: user.pincode,
    pickupAddress: user.pickupAddress,
    platformType: user.platformType || 'independent',
    isEmailVerified: Boolean(user.isEmailVerified),
    isPhoneVerified: Boolean(user.isPhoneVerified),
    referralCode: user.referralCode || '',
    referralCredits: user.referralCredits || 0,
    isAdmin: Boolean(user.isAdmin),
    adminRole: user.adminRole || null
  };
};



/**
 * @desc    Register a new user (Supplier or Receiver)
 * @route   POST /api/v1/auth/signup
 * @access  Public
 */
const signup = async (req, res) => {
  const { email, password, phone, fullName, referralCode: usedReferralCode } = req.body;
  const role = req.body.role === 'Supplier' ? 'Supplier' : 'Receiver';

  try {
    if (!email || !password || !phone || !fullName) {
      return res.status(400).json({ error: 'All fields (email, password, phone, fullName) are required' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const normalizedPhone = phone.trim().replace(/\s+/g, '');

    // Check if user account with this exact { email, role } or { phone, role } already exists
    const userExists = await User.findOne({ 
      $or: [
        { email: normalizedEmail, role },
        { phone: normalizedPhone, role }
      ]
    });

    if (userExists) {
      return res.status(400).json({ error: `A ${role} account with this email or phone number already exists` });
    }

    // Look up referrer if a referral code was provided
    let referrer = null;
    if (usedReferralCode && usedReferralCode.trim()) {
      referrer = await User.findOne({ referralCode: usedReferralCode.trim().toUpperCase() });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // Generate unique referral code for this new user
    const newReferralCode = await generateReferralCode();

    const address = req.body.address || req.body.pickupAddress?.street || '';
    const city = req.body.city || req.body.pickupAddress?.city || '';
    const state = req.body.state || req.body.pickupAddress?.state || '';
    const pincode = req.body.pincode || req.body.pickupAddress?.pincode || '';
    const pickupAddress = req.body.pickupAddress || {
      street: address,
      city,
      state,
      pincode,
      landmark: req.body.landmark || ''
    };

    // Create user with explicit role, referral code, and optional referredBy
    const user = await User.create({
      email: normalizedEmail,
      passwordHash,
      phone: normalizedPhone,
      fullName,
      role,
      address,
      city,
      state,
      pincode,
      pickupAddress,
      referralCode: newReferralCode,
      referredBy: referrer ? referrer._id : null
    });

    if (user) {
      const accessToken = generateAccessToken(user._id);

      res.status(201).json({
        accessToken,
        user: formatUserResponse(user)
      });
    } else {
      res.status(400).json({ error: 'Invalid user data' });
    }
  } catch (error) {
    console.error('Signup Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * @desc    Authenticate user & get token (Role Scoped)
 * @route   POST /api/v1/auth/login
 * @access  Public
 */
const login = async (req, res) => {
  const { email, password } = req.body;
  const role = req.body.role === 'Supplier' ? 'Supplier' : 'Receiver';

  try {
    if (!email || !password) {
      return res.status(400).json({ error: 'Please enter both email and password' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Check for user email matching specific role
    let user = await User.findOne({ email: normalizedEmail, role });

    // If not found with specified role, check if account exists under another role for clear feedback
    if (!user) {
      const alternateUser = await User.findOne({ email: normalizedEmail });
      if (alternateUser) {
        return res.status(401).json({ 
          error: `No ${role} account registered for this email. Found a ${alternateUser.role} account. Please select the correct portal.` 
        });
      }
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (user && (await bcrypt.compare(password, user.passwordHash))) {
      // Sync Pro status from sibling account under same email if needed
      if (!user.isPro) {
        const proSibling = await User.findOne({ email: normalizedEmail, isPro: true });
        if (proSibling) {
          user.isPro = true;
          user.proPlan = proSibling.proPlan || 'Pro';
          user.proUpgradedAt = proSibling.proUpgradedAt || new Date();
          await user.save();
        }
      }

      const accessToken = generateAccessToken(user._id);

      res.json({
        accessToken,
        user: formatUserResponse(user)
      });
    } else {
      res.status(401).json({ error: 'Invalid email or password' });
    }
  } catch (error) {
    console.error('Login Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * @desc    Send Dynamic Phone SMS OTP (Saved in MongoDB with 5-min TTL and Role Scope)
 * @route   POST /api/v1/auth/send-otp
 * @access  Public
 */
const sendOtp = async (req, res) => {
  let { phone, email, role } = req.body;
  if (typeof phone === 'object' && phone !== null) {
    email = phone.email || email;
    role = phone.role || role;
    phone = phone.phone;
  }
  role = role === 'Supplier' ? 'Supplier' : 'Receiver';

  if (!phone || typeof phone !== 'string') {
    return res.status(400).json({ error: 'Phone number is required' });
  }

  try {
    const normalizedPhone = phone.trim().replace(/\s+/g, '');

    const last10 = normalizedPhone.replace(/\D/g, '').slice(-10);
    const phoneVariants = [
      normalizedPhone,
      last10,
      `+91${last10}`
    ];

    // Check if user with this phone or email already exists for this specific role
    const existingUsers = await User.find({
      $or: [
        { phone: { $in: phoneVariants }, role },
        ...(email ? [{ email: email.toLowerCase().trim(), role }] : [])
      ]
    });

    for (const existingUser of existingUsers) {
      const isPlaceholder = existingUser.email && (
        existingUser.email.endsWith('@securekaro-otp.in') ||
        existingUser.email.endsWith('@safecart-otp.in') ||
        existingUser.email.includes('-otp.in')
      );
      if (isPlaceholder) {
        // Automatically delete stale placeholder user so it doesn't cause collision
        await User.deleteOne({ _id: existingUser._id });
      } else {
        return res.status(400).json({ error: `A ${role} account with this phone number or email already exists. Please sign in instead.` });
      }
    }

    // Generate 6-digit random OTP
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();

    // Delete previous OTPs for this phone and role
    await Otp.deleteMany({ identifier: normalizedPhone, type: 'phone', role });

    // Save new OTP in MongoDB
    await Otp.create({
      identifier: normalizedPhone,
      otp: otpCode,
      type: 'phone',
      role
    });

    try {
      await smsService.sendSmsOtp(normalizedPhone, otpCode);
    } catch (smsErr) {
      console.warn('[SMS SERVICE Dispatch Warning]:', smsErr.message);
    }

    res.json({
      message: `Verification code sent to ${normalizedPhone} (${role} Portal). Valid for 5 minutes.`,
      ...(process.env.NODE_ENV !== 'production' && { debugCode: otpCode })
    });
  } catch (error) {
    console.error('Send Phone OTP Error:', error);
    res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
};

/**
 * @desc    Verify Dynamic Phone OTP against MongoDB
 * @route   POST /api/v1/auth/verify-otp
 * @access  Public
 */
const verifyOtp = async (req, res) => {
  let { phone, code, role, purpose, createIfNotFound } = req.body;
  if (typeof phone === 'object' && phone !== null) {
    code = phone.code || code;
    role = phone.role || role;
    purpose = phone.purpose || purpose;
    createIfNotFound = phone.createIfNotFound !== undefined ? phone.createIfNotFound : createIfNotFound;
    phone = phone.phone;
  }
  role = role === 'Supplier' ? 'Supplier' : 'Receiver';

  if (!phone || !code) {
    return res.status(400).json({ error: 'Phone and OTP code are required' });
  }

  try {
    const normalizedPhone = (phone || '').toString().trim().replace(/\s+/g, '');

    // Query MongoDB for valid OTP matching phone and role
    const validOtp = await Otp.findOne({
      identifier: normalizedPhone,
      otp: code.trim(),
      type: 'phone',
      role
    });

    if (!validOtp) {
      return res.status(400).json({ error: 'Invalid or expired verification code' });
    }

    // OTP is valid! Delete to prevent reuse
    await Otp.deleteOne({ _id: validOtp._id });

    // Check if verification-only (e.g. verifying phone during profile update or Google sign-in)
    const isVerificationOnly = purpose === 'verification' || 
                               createIfNotFound === false || 
                               Boolean(req.headers.authorization);

    const last10 = normalizedPhone.replace(/\D/g, '').slice(-10);
    const phoneVariants = [
      normalizedPhone,
      last10,
      `+91${last10}`
    ];

    // Find user matching phone and role
    let user = await User.findOne({ phone: { $in: phoneVariants }, role });
    let isNew = false;

    if (!user) {
      if (isVerificationOnly) {
        return res.json({
          message: 'Phone verification code verified successfully',
          verified: true,
          phone: normalizedPhone
        });
      }

      isNew = true;
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash('otp-default-password', salt);
      const newReferralCode = await generateReferralCode();
      let referrer = null;
      if (req.body.referralCode && req.body.referralCode.trim()) {
        referrer = await User.findOne({ referralCode: req.body.referralCode.trim().toUpperCase() });
      }
      user = await User.create({
        phone: normalizedPhone,
        email: `${normalizedPhone.replace(/[^0-9]/g, '')}_${role.toLowerCase()}@securekaro-otp.in`,
        passwordHash,
        fullName: `${role} ${normalizedPhone.slice(-4)}`,
        role,
        referralCode: newReferralCode,
        referredBy: referrer ? referrer._id : null,
        isPhoneVerified: true
      });
    } else {
      user.isPhoneVerified = true;
      await user.save();
    }

    // Sync Pro status from sibling account under same email or phone if needed
    if (!user.isPro && (user.email || user.phone)) {
      const proSibling = await User.findOne({
        $or: [
          ...(user.email ? [{ email: user.email.toLowerCase().trim() }] : []),
          { phone: user.phone }
        ],
        isPro: true
      });
      if (proSibling) {
        user.isPro = true;
        user.proPlan = proSibling.proPlan || 'Pro';
        user.proUpgradedAt = proSibling.proUpgradedAt || new Date();
        await user.save();
      }
    }

    const accessToken = generateAccessToken(user._id);

    res.json({
      accessToken,
      isNewUser: isNew,
      user: formatUserResponse(user)
    });
  } catch (error) {
    console.error('Verify Phone OTP Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * @desc    Send Dynamic Email OTP (Saved in MongoDB with 5-min TTL and Role Scope)
 * @route   POST /api/v1/auth/send-email-otp
 * @access  Public
 */
const sendEmailOtp = async (req, res) => {
  const { email } = req.body;
  const role = req.body.role === 'Supplier' ? 'Supplier' : 'Receiver';

  if (!email) {
    return res.status(400).json({ error: 'Email address is required' });
  }

  try {
    const normalizedEmail = email.toLowerCase().trim();

    // Verify email deliverability
    const validation = await emailVerifierService.verifyEmailAddress(normalizedEmail);
    if (!validation.isDeliverable) {
      return res.status(400).json({
        error: 'Email verification failed',
        message: validation.reason || 'Provided email address is invalid or undeliverable'
      });
    }

    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();

    // Delete previous email OTPs for this role
    await Otp.deleteMany({ identifier: normalizedEmail, type: 'email', role });

    // Save new OTP in MongoDB
    await Otp.create({
      identifier: normalizedEmail,
      otp: otpCode,
      type: 'email',
      role
    });

    res.json({
      message: `Email verification code sent to ${normalizedEmail} (${role} Portal). Valid for 5 minutes.`,
      emailStatus: validation.status || 'valid',
      ...(process.env.NODE_ENV !== 'production' && { debugCode: otpCode })
    });
  } catch (error) {
    console.error('Send Email OTP Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * @desc    Verify Dynamic Email OTP against MongoDB
 * @route   POST /api/v1/auth/verify-email-otp
 * @access  Public
 */
const verifyEmailOtp = async (req, res) => {
  const { email, code } = req.body;
  const role = req.body.role === 'Supplier' ? 'Supplier' : 'Receiver';

  if (!email || !code) {
    return res.status(400).json({ error: 'Email and OTP code are required' });
  }

  try {
    const normalizedEmail = email.toLowerCase().trim();

    const validOtp = await Otp.findOne({
      identifier: normalizedEmail,
      otp: code.trim(),
      type: 'email',
      role
    });

    if (!validOtp) {
      return res.status(400).json({ error: 'Invalid or expired email verification code' });
    }

    await Otp.deleteOne({ _id: validOtp._id });

    // Mark email verified for user matching email and role
    const user = await User.findOne({ email: normalizedEmail, role });
    if (user) {
      user.isEmailVerified = true;
      await user.save();
    }

    res.json({
      message: 'Email address successfully verified!',
      email: normalizedEmail,
      role,
      isEmailVerified: true
    });
  } catch (error) {
    console.error('Verify Email OTP Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * @desc    Logout user
 * @route   POST /api/v1/auth/logout
 * @access  Public
 */
const logout = async (req, res) => {
  res.json({ message: 'Successfully logged out' });
};

/**
 * @desc    Forgot Password - Send OTP to email or phone
 * @route   POST /api/v1/auth/forgot-password
 * @access  Public
 */
const forgotPassword = async (req, res) => {
  let { email, phone, role } = req.body;
  if (typeof email === 'object' && email !== null) {
    role = email.role || role;
    phone = email.phone || phone;
    email = email.email;
  }
  role = role === 'Supplier' ? 'Supplier' : 'Receiver';

  const rawPhone = (phone || '').toString().trim().replace(/\s+/g, '');
  const rawEmail = (email || '').toString().toLowerCase().trim();

  if (!rawEmail && !rawPhone) {
    return res.status(400).json({ error: 'Email address or mobile number is required' });
  }

  try {
    let user = null;
    let identifier = '';

    if (rawPhone) {
      const last10 = rawPhone.replace(/\D/g, '').slice(-10);
      user = await User.findOne({
        $or: [
          { phone: rawPhone, role },
          { phone: last10, role },
          { phone: `+91${last10}`, role }
        ]
      });
      identifier = rawPhone;
    } else {
      user = await User.findOne({ email: rawEmail, role });
      identifier = rawEmail;
    }

    if (!user) {
      return res.status(404).json({ error: `No ${role} account registered with this ${rawPhone ? 'phone number' : 'email address'}.` });
    }

    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();

    // Store OTP under identifier and user.phone/email
    await Otp.deleteMany({ identifier, type: 'password_reset', role });
    if (user.phone && user.phone !== identifier) {
      await Otp.deleteMany({ identifier: user.phone, type: 'password_reset', role });
    }

    await Otp.create({
      identifier,
      otp: otpCode,
      type: 'password_reset',
      role
    });

    // If user has a mobile phone, send SMS OTP (Allowed per policy: Forgot Password OTP)
    const phoneToSendSms = user.phone || rawPhone;
    let smsDispatched = false;
    if (phoneToSendSms) {
      try {
        await smsService.sendSmsOtp(phoneToSendSms, otpCode);
        smsDispatched = true;
      } catch (smsErr) {
        console.warn('[FORGOT PASSWORD] SMS OTP dispatch warning:', smsErr.message);
      }
    }

    res.json({
      message: `Password reset OTP sent to ${smsDispatched ? phoneToSendSms : identifier} (${role} Portal). Valid for 5 minutes.`,
      smsDispatched,
      identifier,
      ...(process.env.NODE_ENV !== 'production' && { debugCode: otpCode })
    });
  } catch (error) {
    console.error('Forgot Password Error:', error);
    res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
};

/**
 * @desc    Reset Password with OTP verification
 * @route   POST /api/v1/auth/reset-password
 * @access  Public
 */
const resetPassword = async (req, res) => {
  let { email, phone, code, newPassword, role } = req.body;
  if (typeof email === 'object' && email !== null) {
    code = email.code || code;
    newPassword = email.newPassword || newPassword;
    role = email.role || role;
    phone = email.phone || phone;
    email = email.email;
  }
  role = role === 'Supplier' ? 'Supplier' : 'Receiver';

  const rawPhone = (phone || '').toString().trim().replace(/\s+/g, '');
  const rawEmail = (email || '').toString().toLowerCase().trim();
  const cleanCode = (code || '').toString().trim();

  if ((!rawEmail && !rawPhone) || !cleanCode || !newPassword) {
    return res.status(400).json({ error: 'Email or phone, OTP code, and new password are required' });
  }

  try {
    const identifiersToCheck = [];
    if (rawEmail) identifiersToCheck.push(rawEmail);
    if (rawPhone) {
      identifiersToCheck.push(rawPhone);
      const last10 = rawPhone.replace(/\D/g, '').slice(-10);
      identifiersToCheck.push(last10, `+91${last10}`);
    }

    const validOtp = await Otp.findOne({
      identifier: { $in: identifiersToCheck },
      otp: cleanCode,
      type: 'password_reset',
      role
    });

    if (!validOtp) {
      return res.status(400).json({ error: 'Invalid or expired password reset OTP code' });
    }

    await Otp.deleteMany({ identifier: { $in: identifiersToCheck }, type: 'password_reset', role });

    let user = null;
    if (rawEmail) {
      user = await User.findOne({ email: rawEmail, role });
    }
    if (!user && rawPhone) {
      const last10 = rawPhone.replace(/\D/g, '').slice(-10);
      user = await User.findOne({
        $or: [
          { phone: rawPhone, role },
          { phone: last10, role },
          { phone: `+91${last10}`, role }
        ]
      });
    }

    if (!user) {
      return res.status(404).json({ error: `No ${role} account found matching this identifier.` });
    }

    const salt = await bcrypt.genSalt(10);
    user.passwordHash = await bcrypt.hash(newPassword, salt);
    await user.save();

    res.json({
      message: `Password successfully reset for ${role} account! You can now log in.`,
      success: true
    });
  } catch (error) {
    console.error('Reset Password Error:', error);
    res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
};

/**
 * @desc    Authenticate or Register via Google OAuth
 * @route   POST /api/v1/auth/google
 * @access  Public
 */
const googleAuth = async (req, res) => {
  const { email, fullName, avatarUrl, googleId, referralCode: usedReferralCode } = req.body;
  const requestedRole = req.body.role === 'Supplier' ? 'Supplier' : (req.body.role === 'Receiver' ? 'Receiver' : null);

  try {
    if (!email) {
      return res.status(400).json({ error: 'Email is required for Google Sign-In' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    
    // Check if user already exists: prefer requestedRole if provided, otherwise find any account with this email
    let user = null;
    if (requestedRole) {
      user = await User.findOne({ email: normalizedEmail, role: requestedRole });
    }
    if (!user) {
      user = await User.findOne({ email: normalizedEmail });
    }

    let isNewUser = false;

    if (!user) {
      isNewUser = true;
      const salt = await bcrypt.genSalt(10);
      const dummyPassword = await bcrypt.hash(`google-auth-${Date.now()}-${Math.random()}`, salt);

      // Check for referrer if referral code provided
      let referrer = null;
      if (usedReferralCode && usedReferralCode.trim()) {
        referrer = await User.findOne({ referralCode: usedReferralCode.trim().toUpperCase() });
      }

      const newReferralCode = await generateReferralCode();

      user = await User.create({
        email: normalizedEmail,
        fullName: fullName || normalizedEmail.split('@')[0],
        avatarUrl: avatarUrl || '',
        googleId: googleId || '',
        passwordHash: dummyPassword,
        role: requestedRole || 'Receiver',
        isEmailVerified: true,
        referralCode: newReferralCode,
        referredBy: referrer ? referrer._id : null
      });
    } else {
      if (!user.googleId && googleId) user.googleId = googleId;
      if (!user.avatarUrl && avatarUrl) user.avatarUrl = avatarUrl;
      user.isEmailVerified = true;
      if (!user.referralCode) {
        user.referralCode = await generateReferralCode();
      }
      await user.save();
    }

    // Sync Pro status from sibling account under same email if needed
    if (!user.isPro) {
      const proSibling = await User.findOne({ email: normalizedEmail, isPro: true });
      if (proSibling) {
        user.isPro = true;
        user.proPlan = proSibling.proPlan || 'Pro';
        user.proUpgradedAt = proSibling.proUpgradedAt || new Date();
        await user.save();
      }
    }

    const accessToken = generateAccessToken(user._id);

    res.json({
      accessToken,
      isNewUser,
      user: formatUserResponse(user)
    });
  } catch (error) {
    console.error('Google Auth Error:', error);
    res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
};

/**
 * @desc    Switch active user role between Supplier and Receiver
 * @route   POST /api/v1/auth/switch-role
 * @access  Private
 */
const switchRole = async (req, res) => {
  const { targetRole } = req.body;
  const role = targetRole === 'Supplier' ? 'Supplier' : 'Receiver';

  try {
    const currentUser = req.user;
    if (!currentUser) {
      return res.status(401).json({ error: 'Not authorized' });
    }

    if (currentUser.role === role) {
      return res.json({
        accessToken: generateAccessToken(currentUser._id),
        isNewAccount: false,
        user: formatUserResponse(currentUser, role)
      });
    }

    // Check if user has an existing alternate account with target role under same email
    const alternateUser = await User.findOne({
      email: currentUser.email.toLowerCase().trim(),
      role: role
    });

    if (alternateUser) {
      if (!alternateUser.phone && currentUser.phone) {
        alternateUser.phone = currentUser.phone;
      }
      // Ensure alternate account inherits Pro status if currentUser is Pro
      if (currentUser.isPro && !alternateUser.isPro) {
        alternateUser.isPro = true;
        alternateUser.proPlan = currentUser.proPlan || 'Pro';
        alternateUser.proUpgradedAt = currentUser.proUpgradedAt || new Date();
      }
      await alternateUser.save();
      const accessToken = generateAccessToken(alternateUser._id);
      return res.json({
        accessToken,
        isNewAccount: false,
        user: formatUserResponse(alternateUser, role)
      });
    }

    // ── TRUE DUAL-ACCOUNT ISOLATION ─────────────────────────────────────────
    // No alternate account exists — auto-create a NEW isolated document for
    // the target role. The original account is NEVER mutated or deleted.
    //
    // What is CLONED   → identity: name, avatar, phone, bankDetails, credentials, Pro status
    // What starts FRESH → wallet, cashback, escrow interest, withdrawals (all 0)
    let newAccount;
    try {
      newAccount = await User.create({
        email: currentUser.email,
        passwordHash: currentUser.passwordHash,
        phone: currentUser.phone || undefined,
        fullName: currentUser.fullName,
        avatarUrl: currentUser.avatarUrl || '',
        googleId: currentUser.googleId || '',
        role,
        bankDetails: {
          accountHolderName: currentUser.bankDetails?.accountHolderName || '',
          accountNumber: currentUser.bankDetails?.accountNumber || '',
          ifscCode: currentUser.bankDetails?.ifscCode || '',
          bankName: currentUser.bankDetails?.bankName || '',
          upiId: currentUser.bankDetails?.upiId || ''
        },
        isEmailVerified: currentUser.isEmailVerified || false,
        isPhoneVerified: currentUser.isPhoneVerified || false,
        walletBalance: 0,
        cashbackBalance: 0,
        totalEscrowInterestEarned: 0,
        totalCashbackEarned: 0,
        totalWithdrawn: 0,
        isPro: Boolean(currentUser.isPro),
        proPlan: currentUser.proPlan || (currentUser.isPro ? 'Pro' : 'Standard'),
        proUpgradedAt: currentUser.proUpgradedAt || (currentUser.isPro ? new Date() : null)
      });
    } catch (createErr) {
      // Race condition: another concurrent request already created this account
      if (createErr.code === 11000) {
        const raceAccount = await User.findOne({
          email: currentUser.email.toLowerCase().trim(),
          role
        });
        if (raceAccount) {
          if (currentUser.isPro && !raceAccount.isPro) {
            raceAccount.isPro = true;
            raceAccount.proPlan = currentUser.proPlan || 'Pro';
            raceAccount.proUpgradedAt = currentUser.proUpgradedAt || new Date();
            await raceAccount.save();
          }
          return res.json({
            accessToken: generateAccessToken(raceAccount._id),
            isNewAccount: false,
            user: formatUserResponse(raceAccount, role)
          });
        }
      }
      throw createErr;
    }

    const accessToken = generateAccessToken(newAccount._id);
    return res.json({
      accessToken,
      isNewAccount: true,
      user: formatUserResponse(newAccount, role)
    });
  } catch (error) {
    console.error('Switch Role Error:', error);
    res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
};

module.exports = {
  signup,
  login,
  sendOtp,
  verifyOtp,
  sendEmailOtp,
  verifyEmailOtp,
  forgotPassword,
  resetPassword,
  googleAuth,
  switchRole,
  logout
};


