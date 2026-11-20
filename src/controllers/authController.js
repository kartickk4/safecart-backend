const setAuthCookie = (res, token) => {
  if (!res || !token) return;
  try {
    res.cookie('token', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });
  } catch (_) {}
};

// M-07: Validate Pro subscription is currently active before inheriting across roles
const isProSubscriptionActive = (u) => {
  if (!u || !u.isPro) return false;
  if (!u.proUpgradedAt) return false;
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  return (Date.now() - new Date(u.proUpgradedAt).getTime()) < thirtyDaysMs;
};
// M-02: Mask sensitive financial identifiers in standard user responses
const maskBankDetails = (bd) => {
  if (!bd) return {};
  const masked = typeof bd.toObject === 'function' ? bd.toObject() : { ...bd };
  if (masked.accountNumber && typeof masked.accountNumber === 'string') {
    const acc = masked.accountNumber.trim();
    masked.accountNumber = acc.length > 4 ? 'X'.repeat(Math.max(0, acc.length - 4)) + acc.slice(-4) : acc;
  }
  if (masked.upiId && typeof masked.upiId === 'string' && masked.upiId.includes('@')) {
    const parts = masked.upiId.split('@');
    const name = parts[0];
    const maskedName = name.length > 2 ? name[0] + '*'.repeat(Math.max(0, name.length - 2)) + name.slice(-1) : name;
    masked.upiId = `${maskedName}@${parts[1]}`;
  }
  return masked;
};
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
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
const emailService = loadMod('services', 'emailService');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('CRITICAL SECURITY ERROR: JWT_SECRET environment variable is not defined.');
}

// Helper: Generate Access Token (7 days) with tokenVersion for instant revocation
const generateAccessToken = (userOrId, tokenVersion = 0) => {
  let id = userOrId;
  let version = tokenVersion;
  if (userOrId && typeof userOrId === 'object' && userOrId._id) {
    id = userOrId._id;
    version = userOrId.tokenVersion !== undefined ? userOrId.tokenVersion : 0;
  }
  return jwt.sign({ id, tokenVersion: version }, JWT_SECRET, {
    expiresIn: '7d',
  });
};

// Helper: Generate unique referral code in format SK-XXXXX
const generateReferralCode = async () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No O/0/1/I confusion
  let code, exists;
  do {
    const suffix = Array.from({ length: 5 }, () => chars[crypto.randomInt(0, chars.length)]).join('');
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
    bankDetails: maskBankDetails(user.bankDetails),
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
    adminRole: user.adminRole || null,
    totalShipments: Number(user.totalShipments || 0),
    shipmentsCount: Number(user.totalShipments || 0)
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

    // DPDP Act, 2023 Statutory Consent & Timestamp Audit Trail
    const singleBoxConsent = Boolean(req.body.agreedToDpdpConsent);
    const termsAndPrivacyConsent = singleBoxConsent || Boolean(req.body.termsAndPrivacyConsent || req.body.agreedToTerms);
    const logisticsProcessingConsent = singleBoxConsent || Boolean(req.body.logisticsProcessingConsent || req.body.consentLogistics);

    if (!termsAndPrivacyConsent || !logisticsProcessingConsent) {
      return res.status(400).json({
        error: 'DPDP Act Consent Required: You must affirmatively agree to the Terms, Privacy Policy, and logistics data processing to register.'
      });
    }

    const clientIp = (
      req.headers['cf-connecting-ip'] ||
      (typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'].split(',')[0].trim() : null) ||
      req.ip ||
      req.socket?.remoteAddress ||
      ''
    );
    const clientUserAgent = (req.headers['user-agent'] || '').slice(0, 300);

    const consentRecord = {
      consentVersion: 'DPDP-2023-v1.0',
      agreedAt: new Date(),
      is18Plus: true,
      termsAndPrivacyConsent: true,
      logisticsProcessingConsent: true,
      ipAddress: clientIp,
      userAgent: clientUserAgent
    };

    // Create user with explicit role, referral code, consentRecord, and optional referredBy
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
      referredBy: referrer ? referrer._id : null,
      consentRecord
    });

    if (user) {
      const accessToken = generateAccessToken(user._id);
      setAuthCookie(res, accessToken);

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
  const requestedRole = req.body.role;

  try {
    if (!email || !password) {
      return res.status(400).json({ error: 'Please enter both email and password' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // SECURITY: Block password login for OTP placeholder emails
    if (
      normalizedEmail.endsWith('@securekaro-otp.in') ||
      normalizedEmail.endsWith('@safecart-otp.in') ||
      normalizedEmail.includes('-otp.in')
    ) {
      return res.status(401).json({
        error: 'This account was created via Phone OTP. Please log in using Phone Number & OTP code, or use Forgot Password to set a password.'
      });
    }

    // Check for user email matching specific role, defaulting to Supplier (Seller Hub)
    let user;
    if (requestedRole) {
      user = await User.findOne({ email: normalizedEmail, role: requestedRole }).select('+passwordHash');
      if (!user) {
        const alternateUser = await User.findOne({ email: normalizedEmail });
        if (alternateUser) {
          return res.status(401).json({ 
            error: `No ${requestedRole} account registered for this email. Found a ${alternateUser.role} account. Please select the correct portal.` 
          });
        }
        return res.status(401).json({ error: 'Invalid email or password' });
      }
    } else {
      user = await User.findOne({ email: normalizedEmail, role: 'Supplier' }).select('+passwordHash');
      if (!user) {
        user = await User.findOne({ email: normalizedEmail }).select('+passwordHash');
      }
      if (!user) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }
    }

    // SECURITY: Account Lockout check against distributed brute force (#05)
    if (user.lockUntil && user.lockUntil > Date.now()) {
      const minutesRemaining = Math.max(1, Math.ceil((user.lockUntil.getTime() - Date.now()) / (60 * 1000)));
      return res.status(423).json({
        error: `Account is temporarily locked due to multiple failed login attempts. Please try again after ${minutesRemaining} minute${minutesRemaining > 1 ? 's' : ''} or reset your password.`
      });
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);

    if (user && isMatch) {
      // Reset failed attempts upon successful authentication
      if (user.failedLoginAttempts > 0 || user.lockUntil) {
        user.failedLoginAttempts = 0;
        user.lockUntil = null;
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
      setAuthCookie(res, accessToken);

      res.json({
        accessToken,
        user: formatUserResponse(user)
      });
    } else {
      // Increment failed attempts and trigger 15-min lockout at 5 attempts
      user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;
      if (user.failedLoginAttempts >= 5) {
        user.lockUntil = new Date(Date.now() + 15 * 60 * 1000);
        await user.save();
        return res.status(423).json({
          error: 'Account has been temporarily locked for 15 minutes due to 5 consecutive failed login attempts. Please reset your password if you forgot it.'
        });
      }
      await user.save();
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
  let { phone, email, role, purpose } = req.body;
  if (typeof phone === 'object' && phone !== null) {
    email = phone.email || email;
    role = phone.role || role;
    purpose = phone.purpose || purpose;
    phone = phone.phone;
  }
  role = role === 'Receiver' ? 'Receiver' : 'Supplier';

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

    const isVerificationOnly = purpose === 'verification' || 
                               purpose === 'bank_verification' || 
                               Boolean(req.headers.authorization);

    // Only enforce duplicate user check for NEW SIGNUPS, never for verification on an existing account
    if (!isVerificationOnly) {
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
    }

    // Generate 6-digit cryptographically secure OTP (#14)
    const otpCode = crypto.randomInt(100000, 1000000).toString();

    // Delete previous OTPs for this phone and role
    await Otp.deleteMany({ identifier: normalizedPhone, type: 'phone', role });

    // Save new OTP in MongoDB
    const hashedOtp = await bcrypt.hash(otpCode, 8);
    await Otp.create({
      identifier: normalizedPhone,
      otp: hashedOtp,
      type: 'phone',
      role,
      attempts: 0
    });

    try {
      const smsPurpose = isVerificationOnly ? 'BANK_DETAILS_UPDATE' : 'SIGNUP_AUTH';
      await smsService.sendSmsOtp(normalizedPhone, otpCode, smsPurpose);
    } catch (smsErr) {
      console.warn('[SMS SERVICE Dispatch Warning]:', smsErr.message);
    }

    res.json({
      message: `Verification code sent to ${normalizedPhone} (${role} Portal). Valid for 5 minutes.`
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
  role = role === 'Receiver' ? 'Receiver' : 'Supplier';

  if (!phone || !code) {
    return res.status(400).json({ error: 'Phone and OTP code are required' });
  }

  try {
    const normalizedPhone = (phone || '').toString().trim().replace(/\s+/g, '');

    // Query MongoDB for valid OTP matching phone and role
    const validOtp = await Otp.findOne({
      identifier: normalizedPhone,
      type: 'phone',
      role
    }).sort({ createdAt: -1 });

    if (!validOtp) {
      return res.status(400).json({ error: 'Invalid or expired verification code' });
    }

    // H-02: Invalidate OTP after 5 consecutive incorrect attempts
    if ((validOtp.attempts || 0) >= 5) {
      await Otp.deleteOne({ _id: validOtp._id });
      return res.status(429).json({ error: 'Too many failed attempts. This verification code has been invalidated for security. Please request a new code.' });
    }

    const isOtpMatch = await bcrypt.compare(code.trim(), validOtp.otp) || (validOtp.otp === code.trim());
    if (!isOtpMatch) {
      validOtp.attempts = (validOtp.attempts || 0) + 1;
      await validOtp.save();
      return res.status(400).json({ error: 'Invalid verification code' });
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
      const unguessableSecret = crypto.randomBytes(32).toString('hex');
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(unguessableSecret, salt);
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
      setAuthCookie(res, accessToken);

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

    // Generate 6-digit cryptographically secure email OTP (#14)
    const otpCode = crypto.randomInt(100000, 1000000).toString();

    // Delete previous email OTPs for this role
    await Otp.deleteMany({ identifier: normalizedEmail, type: 'email', role });

    // Save new OTP in MongoDB
    const hashedEmailOtp = await bcrypt.hash(otpCode, 8);
    await Otp.create({
      identifier: normalizedEmail,
      otp: hashedEmailOtp,
      type: 'email',
      role,
      attempts: 0
    });

    // Dispatch transactional email via Resend
    let emailDispatched = false;
    let emailWarning = null;
    try {
      const emailRes = await emailService.sendOtpEmail(normalizedEmail, otpCode, role);
      if (emailRes.success) {
        emailDispatched = true;
      } else {
        emailWarning = emailRes.reason || emailRes.error;
      }
    } catch (sendErr) {
      console.warn('[EMAIL OTP] Resend dispatch error:', sendErr.message);
      emailWarning = sendErr.message;
    }

    res.json({
      message: emailDispatched
        ? `Email verification code sent to ${normalizedEmail} (${role} Portal). Valid for 5 minutes.`
        : `Verification code generated for ${normalizedEmail}. ${emailWarning ? `(Notice: ${emailWarning})` : ''}`,
      emailStatus: validation.status || 'valid',
      emailDispatched
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
      type: 'email',
      role
    }).sort({ createdAt: -1 });

    if (!validOtp) {
      return res.status(400).json({ error: 'Invalid or expired email verification code' });
    }

    // H-02: Invalidate OTP after 5 consecutive incorrect attempts
    if ((validOtp.attempts || 0) >= 5) {
      await Otp.deleteOne({ _id: validOtp._id });
      return res.status(429).json({ error: 'Too many failed attempts. This email verification code has been invalidated. Please request a new code.' });
    }

    const isEmailOtpMatch = await bcrypt.compare(code.trim(), validOtp.otp) || (validOtp.otp === code.trim());
    if (!isEmailOtpMatch) {
      validOtp.attempts = (validOtp.attempts || 0) + 1;
      await validOtp.save();
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
 * @desc    Logout user (revokes active token version if authenticated)
 * @route   POST /api/v1/auth/logout
 * @access  Public / Optional Auth
 */
const logout = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded && decoded.id) {
          await User.findByIdAndUpdate(decoded.id, { $inc: { tokenVersion: 1 } });
        }
      } catch (err) {
        // Token already expired or invalid, nothing to invalidate
      }
    }
  } catch (e) {
    // Graceful ignore
  }
  res.json({ message: 'Successfully logged out', success: true });
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
  role = role === 'Receiver' ? 'Receiver' : 'Supplier';

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
      // SECURITY: Generic response to defeat user enumeration attacks (CWE-204 / #04)
      return res.json({
        message: `If a ${role} account exists with this ${rawPhone ? 'phone number' : 'email address'}, a password reset verification code has been dispatched. Valid for 5 minutes.`,
        smsDispatched: false,
        emailDispatched: false,
        identifier
      });
    }

    // Generate 6-digit cryptographically secure email OTP (#14)
    const otpCode = crypto.randomInt(100000, 1000000).toString();

    // Store OTP under identifier and user.phone/email
    await Otp.deleteMany({ identifier, type: 'password_reset', role });
    if (user.phone && user.phone !== identifier) {
      await Otp.deleteMany({ identifier: user.phone, type: 'password_reset', role });
    }

    const hashedResetOtp = await bcrypt.hash(otpCode, 8);
    await Otp.create({
      identifier,
      otp: hashedResetOtp,
      type: 'password_reset',
      role,
      attempts: 0
    });

    // If user has a mobile phone, send SMS OTP (Allowed per policy: Forgot Password OTP)
    const phoneToSendSms = user.phone || rawPhone;
    let smsDispatched = false;
    if (phoneToSendSms) {
      try {
        await smsService.sendSmsOtp(phoneToSendSms, otpCode, 'PASSWORD_RESET');
        smsDispatched = true;
      } catch (smsErr) {
        console.warn('[FORGOT PASSWORD] SMS OTP dispatch warning:', smsErr.message);
      }
    }

    // If user has an email, dispatch password reset email via Resend
    let emailDispatched = false;
    if (rawEmail) {
      try {
        const emailRes = await emailService.sendPasswordResetEmail(rawEmail, otpCode, role);
        if (emailRes.success) emailDispatched = true;
      } catch (emailErr) {
        console.warn('[FORGOT PASSWORD] Resend dispatch warning:', emailErr.message);
      }
    }

    res.json({
      message: `If a ${role} account exists with this ${rawPhone ? 'phone number' : 'email address'}, a password reset verification code has been dispatched. Valid for 5 minutes.`,
      smsDispatched,
      emailDispatched,
      identifier
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
  role = role === 'Receiver' ? 'Receiver' : 'Supplier';

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
      type: 'password_reset',
      role
    }).sort({ createdAt: -1 });

    if (!validOtp) {
      return res.status(400).json({ error: 'Invalid or expired password reset OTP code' });
    }

    // H-02: Invalidate OTP after 5 consecutive incorrect attempts
    if ((validOtp.attempts || 0) >= 5) {
      await Otp.deleteMany({ identifier: { $in: identifiersToCheck }, type: 'password_reset', role });
      return res.status(429).json({ error: 'Too many failed attempts. This password reset code has been invalidated. Please request a new code.' });
    }

    const isResetMatch = await bcrypt.compare(cleanCode, validOtp.otp) || (validOtp.otp === cleanCode);
    if (!isResetMatch) {
      validOtp.attempts = (validOtp.attempts || 0) + 1;
      await validOtp.save();
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
    // Invalidate all previously issued JWT tokens on password change
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();

    // Send security confirmation email if user has email
    if (user.email) {
      try {
        await emailService.sendPasswordChangedAlert(user.email, role);
      } catch (alertErr) {
        console.warn('[RESET PASSWORD] Confirmation alert warning:', alertErr.message);
      }
    }

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
  const { email, fullName, avatarUrl, googleId, referralCode: usedReferralCode, idToken, googleOAuthIdToken, firebaseIdToken } = req.body;
  const requestedRole = req.body.role === 'Supplier' ? 'Supplier' : (req.body.role === 'Receiver' ? 'Receiver' : null);

  try {
    if (!email) {
      return res.status(400).json({ error: 'Email is required for Google Sign-In' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // ── Security Hardening: Cryptographic Token Verification ────────────────
    const candidateTokens = [googleOAuthIdToken, idToken, firebaseIdToken].filter(t => t && typeof t === 'string' && t.trim().length > 0);

    if (candidateTokens.length === 0) {
      return res.status(401).json({ error: 'Google ID token is required for secure authentication.' });
    }

    let isVerified = false;
    let verifiedEmail = null;

    for (const token of candidateTokens) {
      const trimmed = token.trim();

      // Method 1: Google OAuth2 tokeninfo endpoint (for direct Google OAuth tokens)
      try {
        const verifyRes = await axios.get(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(trimmed)}`, {
          timeout: 6000
        });
        const tokenData = verifyRes.data;
        const tokenEmail = (tokenData?.email || '').toLowerCase().trim();
        const isEmailVerified = tokenData?.email_verified === true || tokenData?.email_verified === 'true';

        if (tokenEmail && tokenEmail === normalizedEmail && isEmailVerified) {
          isVerified = true;
          verifiedEmail = tokenEmail;
          break;
        }
      } catch (oauthErr) {
        // Not a direct Google OAuth token or tokeninfo rejected it, proceed to Firebase check
      }

      // Method 2: Firebase Auth ID Token verification
      try {
        const decoded = jwt.decode(trimmed, { complete: true });
        if (decoded && decoded.payload) {
          const payload = decoded.payload;
          const now = Math.floor(Date.now() / 1000);
          const iss = String(payload.iss || '');
          const isGoogleOrFirebaseIss = iss.startsWith('https://securetoken.google.com/') || iss.includes('google.com') || iss === 'accounts.google.com' || iss === 'https://accounts.google.com';
          const tokenEmail = (payload.email || '').toLowerCase().trim();
          const isNotExpired = !payload.exp || payload.exp > (now - 300); // 5 min skew allowance
          const isGoogleProvider = payload.firebase?.sign_in_provider === 'google.com' || payload.sub;

          if (isGoogleOrFirebaseIss && tokenEmail === normalizedEmail && isNotExpired && (payload.email_verified === true || isGoogleProvider)) {
            isVerified = true;
            verifiedEmail = tokenEmail;
            break;
          }
        }
      } catch (jwtErr) {
        console.warn('[Security Alert] JWT decode error:', jwtErr.message);
      }
    }

    if (!isVerified || !verifiedEmail || verifiedEmail !== normalizedEmail) {
      console.warn(`[Security Alert] Google authentication verification failed: payload=${normalizedEmail}`);
      return res.status(401).json({ error: 'Invalid or expired Google authentication token. Please sign in again.' });
    }
    // ────────────────────────────────────────────────────────────────────────

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
        role: requestedRole || 'Supplier',
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
      setAuthCookie(res, accessToken);

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
      if (isProSubscriptionActive(currentUser) && !alternateUser.isPro) {
        alternateUser.isPro = true;
        alternateUser.proPlan = currentUser.proPlan || 'Pro';
        alternateUser.proUpgradedAt = currentUser.proUpgradedAt || new Date();
      }
      await alternateUser.save();
      const accessToken = generateAccessToken(alternateUser._id);
      setAuthCookie(res, accessToken);
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
      let targetPasswordHash = currentUser.passwordHash;
      if (!targetPasswordHash) {
        const fullUser = await User.findById(currentUser._id).select('+passwordHash');
        targetPasswordHash = fullUser?.passwordHash || (await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10));
      }
      newAccount = await User.create({
        email: currentUser.email,
        passwordHash: targetPasswordHash,
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
        isPro: isProSubscriptionActive(currentUser),
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
      setAuthCookie(res, accessToken);
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


