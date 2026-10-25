const { Resend } = require('resend');

const apiKey = process.env.RESEND_API_KEY;
const resend = apiKey ? new Resend(apiKey) : null;
const getFromEmail = () => (process.env.RESEND_FROM_EMAIL || 'SecureKaro <support@securekaro.in>').replace(/^"|"$/g, '');
const getLogoUrl = () => process.env.APP_LOGO_URL || 'https://securekaro.in/logo.jpg';

/**
 * Common HTML wrapper for branded SecureKaro emails
 */
const getBrandedHtml = (title, bodyContent) => {
  const logoUrl = getLogoUrl();
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 20px; color: #1e293b; }
      .container { max-width: 540px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05); }
      .header { background: linear-gradient(135deg, #0f172a 0%, #1e3a8a 100%); padding: 28px 24px 22px 24px; text-align: center; color: #ffffff; }
      .brand-title { font-size: 20px; font-weight: 700; letter-spacing: -0.5px; margin-top: 6px; }
      .tagline { font-size: 12px; color: #93c5fd; margin-top: 4px; }
      .content { padding: 32px 24px; }
      .otp-box { background: #f1f5f9; border: 2px dashed #cbd5e1; border-radius: 8px; padding: 16px; text-align: center; margin: 24px 0; }
      .otp-code { font-size: 32px; font-weight: 800; letter-spacing: 6px; color: #2563eb; }
      .footer { background: #f8fafc; border-top: 1px solid #f1f5f9; padding: 16px 24px; font-size: 12px; color: #64748b; text-align: center; }
      .security-note { font-size: 13px; color: #64748b; margin-top: 16px; line-height: 1.5; }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <a href="https://securekaro.in" target="_blank" style="text-decoration:none; display:inline-block;">
          <img src="${logoUrl}" alt="SecureKaro" height="42" style="display:block; margin:0 auto; max-height:46px; width:auto; border-radius:8px; border:0; outline:none;" onerror="this.style.display='none'" />
        </a>
        <div class="brand-title">🛡️ SecureKaro</div>
        <div class="tagline">Sovereign Escrow & Logistics Protection</div>
      </div>
      <div class="content">
        ${bodyContent}
      </div>
      <div class="footer">
        <p>© ${new Date().getFullYear()} SecureKaro Technologies. All rights reserved.</p>
        <p>If you didn't request this email, please secure your account immediately or contact support@securekaro.in</p>
      </div>
    </div>
  </body>
  </html>
  `;
};

/**
 * Send Email Verification OTP
 */
const sendOtpEmail = async (to, otp, role = 'Receiver') => {
  if (!resend) {
    console.warn('[EMAIL SERVICE] Resend API key missing. Skipping email dispatch.');
    return { success: false, reason: 'RESEND_API_KEY_MISSING' };
  }

  try {
    const subject = `Your SecureKaro Verification Code: ${otp}`;
    const body = `
      <h2 style="margin-top:0; color:#0f172a;">Verify Your Email Address</h2>
      <p style="color:#475569; font-size:15px; line-height:1.6;">
        Welcome to SecureKaro (${role} Portal). Use the verification code below to verify your email address:
      </p>
      <div class="otp-box">
        <div class="otp-code">${otp}</div>
        <div style="font-size:12px; color:#64748b; margin-top:6px;">Valid for 5 minutes</div>
      </div>
      <p class="security-note">
        <strong>Security tip:</strong> Never share this OTP with anyone, including SecureKaro representatives. Our team will never ask for your verification code.
      </p>
    `;

    const response = await resend.emails.send({
      from: getFromEmail(),
      to,
      subject,
      html: getBrandedHtml(subject, body),
    });

    console.log(`[EMAIL SERVICE] OTP successfully dispatched to ${to} (ID: ${response?.data?.id || 'OK'})`);
    return { success: true, data: response.data };
  } catch (error) {
    console.error('[EMAIL SERVICE] Failed to send OTP email:', error.message);
    return { success: false, error: error.message };
  }
};

/**
 * Send Password Reset OTP
 */
const sendPasswordResetEmail = async (to, otp, role = 'User') => {
  if (!resend) {
    console.warn('[EMAIL SERVICE] Resend API key missing. Skipping password reset email.');
    return { success: false, reason: 'RESEND_API_KEY_MISSING' };
  }

  try {
    const subject = `Password Reset Request: ${otp}`;
    const body = `
      <h2 style="margin-top:0; color:#0f172a;">Reset Your Password</h2>
      <p style="color:#475569; font-size:15px; line-height:1.6;">
        We received a request to reset your password for your SecureKaro (${role}) account. Use the code below:
      </p>
      <div class="otp-box">
        <div class="otp-code">${otp}</div>
        <div style="font-size:12px; color:#64748b; margin-top:6px;">Expires in 5 minutes</div>
      </div>
      <p class="security-note">
        If you did not request a password reset, you can safely ignore this email. Your password will remain unchanged.
      </p>
    `;

    const response = await resend.emails.send({
      from: getFromEmail(),
      to,
      subject,
      html: getBrandedHtml(subject, body),
    });

    console.log(`[EMAIL SERVICE] Password reset email dispatched to ${to}`);
    return { success: true, data: response.data };
  } catch (error) {
    console.error('[EMAIL SERVICE] Failed to send password reset email:', error.message);
    return { success: false, error: error.message };
  }
};

/**
 * Send Payment / Escrow Confirmation Receipt
 */
const sendEscrowAlertEmail = async (to, { title, message, shipmentId, amount }) => {
  if (!resend) return { success: false, reason: 'RESEND_API_KEY_MISSING' };

  try {
    const subject = `[SecureKaro] ${title}`;
    const body = `
      <h2 style="margin-top:0; color:#0f172a;">${title}</h2>
      <p style="color:#475569; font-size:15px; line-height:1.6;">${message}</p>
      <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:16px; margin:20px 0;">
        ${shipmentId ? `<p style="margin:4px 0;"><strong>Shipment ID:</strong> ${shipmentId}</p>` : ''}
        ${amount ? `<p style="margin:4px 0;"><strong>Escrow Amount:</strong> ₹${Number(amount).toLocaleString('en-IN')}</p>` : ''}
        <p style="margin:4px 0;"><strong>Protection Status:</strong> <span style="color:#16a34a; font-weight:600;">Secured in Escrow</span></p>
      </div>
    `;

    const response = await resend.emails.send({
      from: getFromEmail(),
      to,
      subject,
      html: getBrandedHtml(subject, body),
    });

    return { success: true, data: response.data };
  } catch (error) {
    console.error('[EMAIL SERVICE] Escrow alert email error:', error.message);
    return { success: false, error: error.message };
  }
};

/**
 * Send Password Changed Security Notice
 */
const sendPasswordChangedAlert = async (to, role = 'User') => {
  if (!resend) return { success: false, reason: 'RESEND_API_KEY_MISSING' };

  try {
    const subject = 'Security Notice: Your SecureKaro Password Was Changed';
    const body = `
      <h2 style="margin-top:0; color:#0f172a;">Password Changed Successfully</h2>
      <p style="color:#475569; font-size:15px; line-height:1.6;">
        The password for your SecureKaro (${role}) account was recently updated. All previous login sessions have been revoked for your security.
      </p>
      <div style="background:#fef2f2; border:1px solid #fecaca; border-radius:8px; padding:14px; margin:20px 0;">
        <p style="margin:0; font-size:13px; color:#991b1b; font-weight:500;">
          ⚠️ If you did NOT make this change, your account may be compromised. Please contact support@securekaro.in immediately.
        </p>
      </div>
    `;

    const response = await resend.emails.send({
      from: getFromEmail(),
      to,
      subject,
      html: getBrandedHtml(subject, body),
    });

    return { success: true, data: response.data };
  } catch (error) {
    console.warn('[EMAIL SERVICE] Password changed alert warning:', error.message);
    return { success: false, error: error.message };
  }
};

module.exports = {
  sendOtpEmail,
  sendPasswordResetEmail,
  sendPasswordChangedAlert,
  sendEscrowAlertEmail
};
