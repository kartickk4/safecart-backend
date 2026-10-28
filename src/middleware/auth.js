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
  // SECURITY: Admin privilege must come ONLY from database role fields — never from a hardcoded email.
  if (
    req.user && (
      req.user.role === 'Admin' ||
      req.user.role === 'super_admin' ||
      req.user.isAdmin === true ||
      !!req.user.adminRole
    )
  ) {
    req.user.isAdmin = true;
    if (!req.user.adminRole) {
      req.user.adminRole = 'super_admin';
    }
    next();
  } else {
    res.status(403).json({ error: 'Access denied: Requires administrative privileges.' });
  }
};

module.exports = { protect, admin };
