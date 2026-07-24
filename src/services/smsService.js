const axios = require('axios');

/**
 * Sends a real SMS with OTP code via BigDataCloud API.
 * @param {string} phone - Target phone number
 * @param {string} otpCode - 6-digit OTP code
 */
const sendSmsOtp = async (phone, otpCode) => {
  const apiKey = process.env.BIGDATACLOUD_API_KEY;
  if (!apiKey) {
    console.warn('[SMS SERVICE] BigDataCloud API key missing in .env. Skipping live SMS send.');
    return { success: false, reason: 'Missing API Key' };
  }

  try {
    const message = `Your Safecart verification code is: ${otpCode}. Valid for 5 minutes.`;

    // BigDataCloud Phone Verification & SMS Dispatch Endpoint
    const response = await axios.get('https://api.bigdatacloud.net/data/phone-number-verification', {
      params: {
        key: apiKey,
        phoneNumber: phone,
        code: otpCode,
        text: message
      },
      timeout: 8000
    });

    console.log(`[SMS SERVICE] BigDataCloud SMS API dispatch to ${phone}:`, response.data);
    return { success: true, data: response.data };
  } catch (error) {
    // If endpoint variation or account quota response occurs, log and handle safely
    console.error(`[SMS SERVICE Error] Failed to send SMS via BigDataCloud:`, error.response ? error.response.data : error.message);
    return { success: false, error: error.message };
  }
};

module.exports = {
  sendSmsOtp
};
