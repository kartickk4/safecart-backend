/**
 * feeConfig.js
 * SecureKaro Platform Service Fee Rules
 *
 * Fee Structure:
 *  - 0% platform service fee — SecureKaro escrow is completely FREE for all users
 *  - Revenue is earned via courier booking commission margins
 */

const SERVICE_FEE_RATE = 0;       // 0% — platform fee removed
const MINIMUM_FEE_AMOUNT = 0;     // No minimum fee
const LOW_VALUE_THRESHOLD = 0;    // Not applicable

/**
 * Calculate platform service fee for a given order amount.
 * Always returns 0 — escrow is free for users.
 * @param {number} orderAmount - The shipment/order value in INR
 * @returns {{ fee: number, rate: number, note: string }}
 */
const calculateServiceFee = (orderAmount) => {
  return { fee: 0, rate: 0, note: 'SecureKaro delivery protection is 100% free — no platform fee' };
};

/**
 * Calculate how much the seller receives after service fee deduction.
 * Since fee is 0, seller receives full gross amount minus only courier charges.
 * @param {number} orderAmount
 * @returns {{ grossAmount: number, serviceFee: number, netPayout: number, feeNote: string }}
 */
const calculateSellerPayout = (orderAmount) => {
  const grossAmount = parseFloat(orderAmount) || 0;
  const { fee, note } = calculateServiceFee(grossAmount);
  const netPayout = parseFloat(Math.max(0, grossAmount - fee).toFixed(2));

  return {
    grossAmount,
    serviceFee: fee,
    netPayout,
    feeNote: note
  };
};

module.exports = {
  calculateServiceFee,
  calculateSellerPayout,
  SERVICE_FEE_RATE,
  MINIMUM_FEE_AMOUNT,
  LOW_VALUE_THRESHOLD
};
