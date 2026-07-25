const axios = require('axios');

/**
 * Validates whether an email address is deliverable.
 * @param {string} email - Email address to validate
 */
const verifyEmailAddress = async (email) => {
  const apiKey = process.env.EMAIL_VERIFIER_API_KEY;
  if (!apiKey) {
    return { isDeliverable: true, reason: 'Missing API Key' };
  }

  try {
    const response = await axios.get('https://api.myemailverifier.com/verifier/validateSingle/', {
      params: {
        apiKey: apiKey,
        email: email.trim()
      },
      timeout: 5000
    });

    const data = response.data;
    const status = (data && (data.Status || data.status || '')).toString().toLowerCase();

    if (status === 'invalid') {
      return {
        isDeliverable: false,
        status: 'invalid',
        reason: 'Email address is invalid'
      };
    }

    return {
      isDeliverable: true,
      status: 'valid'
    };
  } catch (error) {
    console.warn('[EMAIL VERIFIER Warning] External API fallback:', error.message);
    return { isDeliverable: true, reason: 'API Fallback' };
  }
};

module.exports = {
  verifyEmailAddress
};
