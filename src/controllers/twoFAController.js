/**
 * twoFAController.js
 * Handles TOTP-based 2FA for admin accounts.
 *
 * FLOW:
 *   1. POST /api/v1/auth/admin/2fa/setup   → generates a TOTP secret + QR code URI
 *   2. POST /api/v1/auth/admin/2fa/enable  → verifies first TOTP code, marks is2FAEnabled=true
 *   3. POST /api/v1/auth/admin/2fa/verify  → verifies TOTP, returns short-lived 2FA session token
 *   4. POST /api/v1/auth/admin/2fa/disable → disables 2FA (requires valid TOTP to prevent lock-out)
 *   5. GET  /api/v1/auth/admin/2fa/status  → returns is2FAEnabled flag for the current admin
 */

const speakeasy = require('speakeasy');
const QRCode    = require('qrcode');
const jwt       = require('jsonwebtoken');
const path      = require('path');
const fs        = require('fs');

// ─── Shared loader (same pattern as rest of codebase) ─────────────────────────
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

const JWT_SECRET = process.env.JWT_SECRET;
// 2FA session tokens last 8 hours; admin must re-verify after 8 h
const TWO_FA_TOKEN_TTL = '8h';
// TOTP window: allow ±1 step (30-sec steps) = ±30 seconds of clock drift
const TOTP_WINDOW = 1;

// ─── 1. SETUP ─────────────────────────────────────────────────────────────────
// Generates a new TOTP secret + QR code for the admin to scan.
// Does NOT activate 2FA yet — admin must verify one code via /enable.
const setup2FA = async (req, res) => {
  try {
    // Generate a new Base32 secret
    const secret = speakeasy.generateSecret({
      name: `SafeCart Admin (${req.user.email})`,
      issuer: 'SafeCart / SecureKaro',
      length: 32
    });

    // Save the UNACTIVATED secret — is2FAEnabled remains false until /enable
    await User.findByIdAndUpdate(req.user._id, { totpSecret: secret.base32 });

    // Build the QR code as a data URI (no file storage needed)
    const qrDataUrl = await QRCode.toDataURL(secret.otpauth_url);

    return res.status(200).json({
      message: 'Scan the QR code with Google Authenticator (or any TOTP app). ' +
               'Then call POST /api/v1/auth/admin/2fa/enable with the 6-digit code to activate.',
      secret: secret.base32,          // show once — user can type it manually if QR fails
      otpauthUrl: secret.otpauth_url, // for apps that accept the URL directly
      qrCodeDataUrl: qrDataUrl         // base64 PNG: <img src="..."> in frontend
    });
  } catch (err) {
    console.error('2FA setup error:', err.message);
    return res.status(500).json({ error: 'Failed to generate 2FA secret.' });
  }
};

// ─── 2. ENABLE ────────────────────────────────────────────────────────────────
// Admin scanned the QR, got a 6-digit code from their app → verify it once.
// If valid, set is2FAEnabled = true. From now on, sensitive admin routes require
// the X-2FA-Token header on every request.
const enable2FA = async (req, res) => {
  try {
    const { token } = req.body;
    if (!token || typeof token !== 'string' || !/^\d{6}$/.test(token)) {
      return res.status(400).json({ error: 'token must be a 6-digit string.' });
    }

    // Load the user WITH the secret (normally excluded via select: false)
    const user = await User.findById(req.user._id).select('+totpSecret');
    if (!user || !user.totpSecret) {
      return res.status(400).json({
        error: 'No TOTP secret found. Please call /setup first.'
      });
    }

    if (user.is2FAEnabled) {
      return res.status(400).json({ error: '2FA is already enabled for this account.' });
    }

    // Verify the code from Google Authenticator
    const isValid = speakeasy.totp.verify({
      secret:   user.totpSecret,
      encoding: 'base32',
      token,
      window:   TOTP_WINDOW
    });

    if (!isValid) {
      return res.status(400).json({ error: 'Invalid TOTP code. Check your authenticator app clock.' });
    }

    // Activate 2FA
    await User.findByIdAndUpdate(req.user._id, { is2FAEnabled: true });

    return res.status(200).json({
      message: '2FA successfully enabled. Future admin requests to protected routes ' +
               'require an X-2FA-Token header obtained from POST /verify.'
    });
  } catch (err) {
    console.error('2FA enable error:', err.message);
    return res.status(500).json({ error: 'Failed to enable 2FA.' });
  }
};

// ─── 3. VERIFY (per session) ──────────────────────────────────────────────────
// Admin provides a 6-digit TOTP code → server returns a short-lived 2FA token.
// The frontend stores this and sends it as X-2FA-Token on every admin API call.
const verify2FA = async (req, res) => {
  try {
    const { token } = req.body;
    if (!token || typeof token !== 'string' || !/^\d{6}$/.test(token)) {
      return res.status(400).json({ error: 'token must be a 6-digit string.' });
    }

    if (!req.user.is2FAEnabled) {
      return res.status(400).json({
        error: '2FA is not enabled on this account. Call /setup then /enable first.'
      });
    }

    const user = await User.findById(req.user._id).select('+totpSecret');
    if (!user || !user.totpSecret) {
      return res.status(400).json({ error: 'No TOTP secret on file. Please contact support.' });
    }

    const isValid = speakeasy.totp.verify({
      secret:   user.totpSecret,
      encoding: 'base32',
      token,
      window:   TOTP_WINDOW
    });

    if (!isValid) {
      return res.status(400).json({ error: 'Invalid or expired TOTP code.' });
    }

    // Issue a short-lived 2FA session token (separate from the main JWT)
    const twoFASessionToken = jwt.sign(
      {
        id:   req.user._id.toString(),
        type: '2fa_session'
      },
      JWT_SECRET + '_2fa',
      { expiresIn: TWO_FA_TOKEN_TTL }
    );

    return res.status(200).json({
      message: '2FA verified. Send X-2FA-Token header with this value on admin API calls.',
      twoFAToken: twoFASessionToken,
      expiresIn:  TWO_FA_TOKEN_TTL
    });
  } catch (err) {
    console.error('2FA verify error:', err.message);
    return res.status(500).json({ error: 'Failed to verify 2FA token.' });
  }
};

// ─── 4. DISABLE ───────────────────────────────────────────────────────────────
// Requires a valid TOTP code to prevent an attacker who stole the JWT from
// trivially disabling 2FA.
const disable2FA = async (req, res) => {
  try {
    const { token } = req.body;
    if (!token || typeof token !== 'string' || !/^\d{6}$/.test(token)) {
      return res.status(400).json({ error: 'token must be a 6-digit string.' });
    }

    const user = await User.findById(req.user._id).select('+totpSecret');
    if (!user || !user.is2FAEnabled) {
      return res.status(400).json({ error: '2FA is not enabled on this account.' });
    }

    const isValid = speakeasy.totp.verify({
      secret:   user.totpSecret,
      encoding: 'base32',
      token,
      window:   TOTP_WINDOW
    });

    if (!isValid) {
      return res.status(400).json({ error: 'Invalid TOTP code. Cannot disable 2FA.' });
    }

    await User.findByIdAndUpdate(req.user._id, {
      is2FAEnabled: false,
      totpSecret:   null
    });

    return res.status(200).json({ message: '2FA has been disabled. Secret has been erased.' });
  } catch (err) {
    console.error('2FA disable error:', err.message);
    return res.status(500).json({ error: 'Failed to disable 2FA.' });
  }
};

// ─── 5. STATUS ────────────────────────────────────────────────────────────────
const status2FA = async (req, res) => {
  return res.status(200).json({
    is2FAEnabled: req.user.is2FAEnabled || false,
    email:        req.user.email
  });
};

module.exports = { setup2FA, enable2FA, verify2FA, disable2FA, status2FA };
