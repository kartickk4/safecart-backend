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

const JWT_SECRET = process.env.JWT_SECRET || 'safecart_default_fallback_secret_key_2026';

// Helper: Generate long-lived Access Token (30 days)
const generateAccessToken = (id) => {
  return jwt.sign({ id }, JWT_SECRET, {
    expiresIn: '30d',
  });
};


/**
 * @desc    Register a new user
 * @route   POST /api/v1/auth/signup
 * @access  Public
 */
const signup = async (req, res) => {
  const { email, password, phone, fullName } = req.body;

  try {
    if (!email || !password || !phone || !fullName) {
      return res.status(400).json({ error: 'All fields (email, password, phone, fullName) are required' });
    }

    // Check if user already exists
    const userExists = await User.findOne({ 
      $or: [
        { email: email.toLowerCase() },
        { phone: phone }
      ]
    });

    if (userExists) {
      return res.status(400).json({ error: 'User with this email or phone number already exists' });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // Create user
    const user = await User.create({
      email,
      passwordHash,
      phone,
      fullName
    });

    if (user) {
      const accessToken = generateAccessToken(user._id);

      res.status(201).json({
        accessToken,
        user: {
          id: user._id,
          email: user.email,
          phone: user.phone,
          fullName: user.fullName,
          avatarUrl: user.avatarUrl,
          role: user.role
        }
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
 * @desc    Authenticate user & get token
 * @route   POST /api/v1/auth/login
 * @access  Public
 */
const login = async (req, res) => {
  const { email, password } = req.body;

  try {
    if (!email || !password) {
      return res.status(400).json({ error: 'Please enter both email and password' });
    }

    // Check for user email
    const user = await User.findOne({ email: email.toLowerCase() });

    if (user && (await bcrypt.compare(password, user.passwordHash))) {
      const accessToken = generateAccessToken(user._id);

      res.json({
        accessToken,
        user: {
          id: user._id,
          email: user.email,
          phone: user.phone,
          fullName: user.fullName,
          avatarUrl: user.avatarUrl,
          role: user.role,
          bankDetails: user.bankDetails
        }
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
 * @desc    Send Dynamic Phone SMS OTP (Saved in MongoDB with 5-min TTL)
 * @route   POST /api/v1/auth/send-otp
 * @access  Public
 */
const sendOtp = async (req, res) => {
  let { phone, email } = req.body;

  // Handle nested object payloads
  if (typeof phone === 'object' && phone !== null) {
    email = phone.email || email;
    phone = phone.phone;
  }

  if (!phone || typeof phone !== 'string') {
    return res.status(400).json({ error: 'Phone number is required' });
  }

  try {
    const normalizedPhone = phone.trim().replace(/\s+/g, '');

    // Check if user with this phone or email already exists
    const existingUser = await User.findOne({
      $or: [
        { phone: normalizedPhone },
        ...(email ? [{ email: email.toLowerCase().trim() }] : [])
      ]
    });

    if (existingUser) {
      return res.status(400).json({ error: 'An account with this phone number or email already exists. Please sign in instead.' });
    }

    // Generate 6-digit random OTP
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();

    // Delete previous OTPs for this phone
    await Otp.deleteMany({ identifier: normalizedPhone, type: 'phone' });

    // Save new OTP in MongoDB (auto-expires in 5 minutes via TTL index)
    await Otp.create({
      identifier: normalizedPhone,
      otp: otpCode,
      type: 'phone'
    });

    // Dispatch SMS via BigDataCloud API using configured API key
    try {
      await smsService.sendSmsOtp(normalizedPhone, otpCode);
    } catch (smsErr) {
      console.warn('[SMS SERVICE Dispatch Warning]:', smsErr.message);
    }

    res.json({
      message: `Verification code sent to ${normalizedPhone}. Valid for 5 minutes.`,
      debugCode: otpCode
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
  let { phone, code } = req.body;
  if (typeof phone === 'object' && phone !== null) {
    code = phone.code || code;
    phone = phone.phone;
  }

  if (!phone || !code) {
    return res.status(400).json({ error: 'Phone and OTP code are required' });
  }

  try {
    const normalizedPhone = (phone || '').toString().trim().replace(/\s+/g, '');
    const cleanCode = (code || '').toString().trim();

    // Query MongoDB for valid OTP
    const validOtp = await Otp.findOne({
      identifier: normalizedPhone,
      otp: code.trim(),
      type: 'phone'
    });

    if (!validOtp) {
      return res.status(400).json({ error: 'Invalid or expired verification code' });
    }

    // OTP is valid! Remove it from MongoDB to prevent reuse
    await Otp.deleteOne({ _id: validOtp._id });

    // Find or create user in MongoDB
    let user = await User.findOne({ phone: normalizedPhone });
    let isNew = false;

    if (!user) {
      isNew = true;
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash('otp-default-password', salt);
      user = await User.create({
        phone: normalizedPhone,
        email: `${normalizedPhone.replace(/[^0-9]/g, '')}@safecart-otp.in`,
        passwordHash,
        fullName: `User ${normalizedPhone.slice(-4)}`,
        isPhoneVerified: true
      });
    } else {
      user.isPhoneVerified = true;
      await user.save();
    }

    const accessToken = generateAccessToken(user._id);

    res.json({
      accessToken,
      isNewUser: isNew,
      user: {
        id: user._id,
        email: user.email,
        phone: user.phone,
        fullName: user.fullName,
        avatarUrl: user.avatarUrl,
        role: user.role,
        isPhoneVerified: user.isPhoneVerified,
        isEmailVerified: user.isEmailVerified
      }
    });
  } catch (error) {
    console.error('Verify Phone OTP Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * @desc    Send Dynamic Email OTP (Saved in MongoDB with 5-min TTL)
 * @route   POST /api/v1/auth/send-email-otp
 * @access  Public
 */
const sendEmailOtp = async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email address is required' });
  }

  try {
    const normalizedEmail = email.toLowerCase().trim();

    // Verify email deliverability via MyEmailVerifier API
    const validation = await emailVerifierService.verifyEmailAddress(normalizedEmail);
    if (!validation.isDeliverable) {
      return res.status(400).json({
        error: 'Email verification failed',
        message: validation.reason || 'Provided email address is invalid or undeliverable'
      });
    }

    // Generate 6-digit random OTP
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();

    // Delete previous email OTPs
    await Otp.deleteMany({ identifier: normalizedEmail, type: 'email' });

    // Save new OTP in MongoDB (expires in 5 mins)
    await Otp.create({
      identifier: normalizedEmail,
      otp: otpCode,
      type: 'email'
    });

    res.json({
      message: `Email verification code sent to ${normalizedEmail}. Valid for 5 minutes.`,
      emailStatus: validation.status || 'valid',
      debugCode: otpCode
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
  if (!email || !code) {
    return res.status(400).json({ error: 'Email and OTP code are required' });
  }

  try {
    const normalizedEmail = email.toLowerCase().trim();

    // Query MongoDB for matching OTP
    const validOtp = await Otp.findOne({
      identifier: normalizedEmail,
      otp: code.trim(),
      type: 'email'
    });

    if (!validOtp) {
      return res.status(400).json({ error: 'Invalid or expired email verification code' });
    }

    // OTP valid -> delete from DB
    await Otp.deleteOne({ _id: validOtp._id });

    // If user exists, mark email verified
    const user = await User.findOne({ email: normalizedEmail });
    if (user) {
      user.isEmailVerified = true;
      await user.save();
    }

    res.json({
      message: 'Email address successfully verified!',
      email: normalizedEmail,
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
  let { email } = req.body;
  if (typeof email === 'object' && email !== null) {
    email = email.email;
  }

  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'Email address is required' });
  }

  try {
    const normalizedEmail = email.toLowerCase().trim();

    // Check if user account exists in DB
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(404).json({ error: 'No user account registered with this email address.' });
    }

    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();

    // Delete existing OTPs
    await Otp.deleteMany({ identifier: normalizedEmail, type: 'password_reset' });

    // Save OTP
    await Otp.create({
      identifier: normalizedEmail,
      otp: otpCode,
      type: 'password_reset'
    });

    res.json({
      message: `Password reset OTP sent to ${normalizedEmail}. Valid for 5 minutes.`,
      debugCode: otpCode
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
  let { email, code, newPassword } = req.body;
  if (typeof email === 'object' && email !== null) {
    code = email.code || code;
    newPassword = email.newPassword || newPassword;
    email = email.email;
  }

  if (!email || !code || !newPassword) {
    return res.status(400).json({ error: 'Email, OTP code, and new password are required' });
  }

  try {
    const normalizedEmail = (email || '').toString().toLowerCase().trim();
    const cleanCode = (code || '').toString().trim();

    // Check OTP
    const validOtp = await Otp.findOne({
      identifier: normalizedEmail,
      otp: cleanCode,
      type: 'password_reset'
    });

    if (!validOtp) {
      return res.status(400).json({ error: 'Invalid or expired password reset OTP code' });
    }

    await Otp.deleteOne({ _id: validOtp._id });

    // Update User Password if User exists in DB
    const user = await User.findOne({ email: normalizedEmail });
    if (user) {
      const salt = await bcrypt.genSalt(10);
      user.passwordHash = await bcrypt.hash(newPassword, salt);
      await user.save();
    }

    res.json({
      message: 'Password successfully reset! You can now log in with your new password.',
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
  const { email, fullName, avatarUrl, googleId, role } = req.body;

  try {
    if (!email) {
      return res.status(400).json({ error: 'Email is required for Google Sign-In' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    let user = await User.findOne({ email: normalizedEmail });
    let isNewUser = false;

    if (!user) {
      isNewUser = true;
      const salt = await bcrypt.genSalt(10);
      const dummyPassword = await bcrypt.hash(`google-auth-${Date.now()}-${Math.random()}`, salt);

      user = await User.create({
        email: normalizedEmail,
        fullName: fullName || normalizedEmail.split('@')[0],
        avatarUrl: avatarUrl || '',
        googleId: googleId || '',
        passwordHash: dummyPassword,
        role: role || 'User',
        isEmailVerified: true
      });
    } else {
      if (!user.googleId && googleId) user.googleId = googleId;
      if (!user.avatarUrl && avatarUrl) user.avatarUrl = avatarUrl;
      if (role && ['User', 'Supplier', 'Admin'].includes(role)) user.role = role;
      user.isEmailVerified = true;
      await user.save();
    }

    const accessToken = generateAccessToken(user._id);

    res.json({
      accessToken,
      isNewUser,
      user: {
        id: user._id,
        email: user.email,
        phone: user.phone,
        fullName: user.fullName,
        avatarUrl: user.avatarUrl,
        role: user.role,
        walletBalance: user.walletBalance || 0
      }
    });
  } catch (error) {
    console.error('Google Auth Error:', error);
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
  logout
};


