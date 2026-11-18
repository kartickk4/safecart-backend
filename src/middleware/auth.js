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
  try { return require(`./${type}/${name}`); } catch(e) {}
  return require(`./${name}`);
}

const User = loadMod('models', 'User');

// SECURITY: JWT_SECRET MUST be provided via environment variable.
// A missing or weak secret is a critical vulnerability.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('CRITICAL SECURITY ERROR: JWT_SECRET environment variable is not set. Server will not authenticate requests.');
}

const protect = async (req, res, next) => {
  if (!JWT_SECRET) {
    return res.status(500).json({ error: 'Server misconfiguration: authentication service unavailable.' });
  }

  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    try {
      token = req.headers.authorization.split(' ')[1];
      const decoded = jwt.verify(token, JWT_SECRET);

      req.user = await User.findById(decoded.id).select('-passwordHash');

      if (!req.user) {
        return res.status(401).json({ error: 'Not authorized, user not found' });
      }

      // Check token version for instant session revocation (password reset, logout, compromise)
      const currentTokenVersion = req.user.tokenVersion || 0;
      if (decoded.tokenVersion !== undefined && decoded.tokenVersion !== currentTokenVersion) {
        return res.status(401).json({ error: 'Session invalidated. Please log in again.' });
      }

      // Check if user is suspended
      if (req.user.isSuspended) {
        const allowedPaths = ['/profile', '/auth/me', '/auth/switch-role'];
        const isAllowed = allowedPaths.some(p => req.originalUrl.includes(p));
        if (!isAllowed) {
          return res.status(403).json({
            error: 'Your account has been suspended. Please contact support@securekaro.in.',
            isSuspended: true,
            suspendedAt: req.user.suspendedAt
          });
        }
      }

      return next();
    } catch (error) {
      // SECURITY: Do NOT log the token value itself
      console.error('JWT verification error:', error.name);
      if (error.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Session expired. Please log in again.' });
      }
      return res.status(401).json({ error: 'Not authorized, invalid token.' });
    }
  }

  if (!token) {
    return res.status(401).json({ error: 'Not authorized, no token provided.' });
  }
};

const admin = (req, res, next) => {
  // SECURITY: Admin privileges must be confirmed from database records.
  // Supports dual-role accounts where role is 'Supplier'/'Receiver' but user has isAdmin=true or adminRole assigned.
  const isSuperAdminEmail = req.user?.email && (
    req.user.email.toLowerCase().trim() === 'kartickdas6289@gmail.com' ||
    (process.env.ADMIN_EMAIL && req.user.email.toLowerCase().trim() === process.env.ADMIN_EMAIL.toLowerCase().trim()) ||
    (process.env.SUPER_ADMIN_EMAIL && req.user.email.toLowerCase().trim() === process.env.SUPER_ADMIN_EMAIL.toLowerCase().trim())
  );

  const hasAdminPrivileges = req.user && (
    req.user.role === 'Admin' ||
    req.user.role === 'super_admin' ||
    req.user.isAdmin === true ||
    Boolean(req.user.adminRole) ||
    isSuperAdminEmail
  );

  if (hasAdminPrivileges) {
    req.user.isAdmin = true;
    if (!req.user.adminRole) {
      req.user.adminRole = 'super_admin';
    }
    return next();
  }

  return res.status(403).json({ error: 'Access denied: Requires administrative privileges.' });
};

// ─── 2FA Middleware (Admin Only) ──────────────────────────────────────────────
// Place AFTER protect + admin. If 2FA is enabled, the admin must have already
// verified a TOTP code in this request cycle (flag set by twoFAController.verify).
// For non-2FA-enabled admins it passes through transparently.
//
// HOW IT WORKS PER REQUEST:
//   1. Admin logs in → gets JWT (normal flow)
//   2. Admin hits POST /api/v1/auth/admin/2fa/verify with 6-digit TOTP code
//   3. Server validates TOTP → returns a short-lived "2fa-session" token
//   4. Admin sends BOTH Bearer JWT + X-2FA-Token header on sensitive admin calls
//   5. requireAdmin2FA validates the 2fa-session token from the header
const speakeasy = require('speakeasy');

const requireAdmin2FA = async (req, res, next) => {
  // If this admin hasn't enabled 2FA at all — allow through (optional)
  if (!req.user.is2FAEnabled) {
    return next();
  }

  // Check for X-2FA-Token header
  const twoFAToken = req.headers['x-2fa-token'];
  if (!twoFAToken) {
    return res.status(403).json({
      error: '2FA required. Please verify your TOTP code.',
      require2FA: true
    });
  }

  // Validate the 2FA session token (signed with JWT_SECRET + totp suffix)
  try {
    const decoded = jwt.verify(twoFAToken, JWT_SECRET + '_2fa');
    // Must belong to the same user and not be stale (token TTL = 8 hours)
    if (decoded.id !== req.user._id.toString()) {
      return res.status(403).json({ error: '2FA token does not match session user.' });
    }
    // All good — attach 2FA info and continue
    req.user.twoFAVerified = true;
    return next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(403).json({
        error: '2FA session expired. Please re-verify your TOTP code.',
        require2FA: true
      });
    }
    return res.status(403).json({ error: 'Invalid 2FA token.' });
  }
};

module.exports = { protect, admin, requireAdmin2FA };
