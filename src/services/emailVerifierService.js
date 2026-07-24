const axios = require('axios');

/**
 * Validates whether an email address is real, active, and deliverable using MyEmailVerifier API.
 * @param {string} email - Email address to validate
 */
const verifyEmailAddress = async (email) => {
  const apiKey = process.env.EMAIL_VERIFIER_API_KEY;
  if (!apiKey) {
    console.warn('[EMAIL VERIFIER] API key missing in .env. Skipping external email validation.');
    return { isDeliverable: true, reason: 'Missing API Key' };
  }

  try {
    const response = await axios.get('https://api.myemailverifier.com/v1/verifier/validateSingle/', {
      params: {
        apiKey: apiKey,
        email: email.trim()
      },
      timeout: 8000
    });

    const data = response.data;
    console.log(`[EMAIL VERIFIER API] Validation result for ${email}:`, data);

    // MyEmailVerifier returns status fields (e.g. Status: "Valid", "Invalid", "Disposable")
    const status = (data && (data.Status || data.status || '')).toString().toLowerCase();
    const isDisposable = data && (data.disposable === 'true' || data.is_disposable === true);

    if (status === 'invalid' || isDisposable) {
      return {
        isDeliverable: false,
        status: status || 'invalid',
        reason: isDisposable ? 'Disposable email addresses are not allowed' : 'Email address is invalid or undeliverable'
      };
    }

    return {
      isDeliverable: true,
      status: status || 'valid',
      details: data
    };
  } catch (error) {
    console.error('[EMAIL VERIFIER Error] Failed to contact MyEmailVerifier API:', error.response ? error.response.data : error.message);
    // Allow fallback if external API times out so real users are not blocked
    return { isDeliverable: true, reason: 'API Timeout/Fallback' };
  }
};

module.exports = {
  verifyEmailAddress
};
