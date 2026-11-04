/**
 * addressRtoService.js
 * Intelligent Indian Address Verification & Predictive RTO Risk Engine.
 * Analyzes address completeness, landmark presence, PIN-code tier, and COD risk factors
 * to save merchants thousands of rupees in avoidable RTO freight fees.
 */

const { getPincodeInfo } = require('./carrierRateService');

/**
 * Verify Indian recipient address quality & calculate RTO probability
 * @param {Object} params
 * @param {string} params.address - Full address line
 * @param {string} params.pincode - 6-digit PIN code
 * @param {string} params.paymentMode - 'cod' or 'prepaid'
 * @param {number} params.amount - Order cash value
 * @param {string} [params.phone] - 10-digit mobile number
 * @returns {Object} Comprehensive address & RTO audit report
 */
function verifyAddressAndPredictRto({ address = '', pincode = '', paymentMode = 'cod', amount = 0, phone = '' }) {
  const cleanAddr = String(address || '').trim();
  const cleanPin = String(pincode || '').replace(/\D/g, '').slice(0, 6);
  const isCod = paymentMode?.toLowerCase() === 'cod';
  const orderAmount = Number(amount) || 0;

  // 1. PIN code verification
  const isValidPincode = cleanPin.length === 6 && /^[1-9][0-9]{5}$/.test(cleanPin);
  const pinInfo = isValidPincode ? getPincodeInfo(cleanPin) : { zone: 'unknown', label: 'Unverified Pincode' };

  // 2. Structural address feature detection
  const hasPremise = /\b(flat|house|h\.no|plot|door|room|floor|bldg|building|block|sector|lane|street|road|gali|nagar|colony|apt|apartment|enclave|society|kunj|vihar|phase|cross)\b/i.test(cleanAddr) || /\d+[\/-]\w+/i.test(cleanAddr);
  
  const hasLandmark = /\b(near|opp|opposite|behind|beside|front|next to|circle|chowk|mandir|temple|mosque|masjid|church|hospital|school|college|mall|market|bazaar|station|metro|bridge|petrol|pump|post office|park|stand|gate|corner)\b/i.test(cleanAddr);
  
  const isSufficientLength = cleanAddr.length >= 22;
  const wordCount = cleanAddr.split(/\s+/).filter(Boolean).length;
  const hasEnoughWords = wordCount >= 4;

  // 3. Address Completeness Score (0 - 100)
  let addressScore = 0;
  if (isValidPincode) addressScore += 25;
  if (hasPremise) addressScore += 25;
  if (hasLandmark) addressScore += 25;
  if (isSufficientLength && hasEnoughWords) addressScore += 25;

  // 4. Missing Components List
  const missingElements = [];
  if (!isValidPincode) missingElements.push('Valid 6-digit PIN code');
  if (!hasPremise) missingElements.push('House/Flat/Plot number or street');
  if (!hasLandmark) missingElements.push('Nearby landmark (e.g. Near Temple, Opp Market)');
  if (!isSufficientLength) missingElements.push('Complete area / locality details');

  // 5. Predictive RTO Risk Calculation
  // Base RTO: Prepaid baseline ~4-6%, COD baseline ~16-18%
  let rtoRiskPct = isCod ? 18 : 5;

  if (!hasLandmark) {
    rtoRiskPct += isCod ? 16 : 4; // Delivery riders frequently log fake NDR without landmark
  }
  if (!hasPremise) {
    rtoRiskPct += isCod ? 14 : 3;
  }
  if (!isValidPincode) {
    rtoRiskPct += 35;
  }
  if (isCod && orderAmount > 2000) {
    // High-ticket COD has higher buyer hesitation / refusal rate
    rtoRiskPct += Math.min(15, Math.round((orderAmount - 2000) / 500) * 3);
  }
  if (pinInfo.zone === 'tier3') {
    rtoRiskPct += isCod ? 8 : 2;
  }

  // Cap between 4% and 88%
  rtoRiskPct = Math.max(4, Math.min(88, rtoRiskPct));

  // Risk Classification
  let riskLevel = 'LOW';
  let badgeColor = 'emerald';
  let riskLabel = '🟢 Low RTO Risk (High Delivery Success)';
  let recommendation = 'Address looks solid! Ready for instant 1-click dispatch.';

  if (rtoRiskPct >= 35) {
    riskLevel = 'HIGH';
    badgeColor = 'rose';
    riskLabel = '🔴 High RTO Risk (Action Recommended)';
    if (isCod) {
      recommendation = hasLandmark 
        ? 'High-ticket COD order: Recommend collecting a ₹50-₹100 UPI commitment token before shipping.'
        : 'Missing landmark on COD parcel! Courier riders frequently mark fake rejections here. Nudge customer for landmark or ₹50 advance.';
    } else {
      recommendation = 'Address appears incomplete. Ask customer to verify their street & landmark before carrier pickup.';
    }
  } else if (rtoRiskPct >= 20) {
    riskLevel = 'MEDIUM';
    badgeColor = 'amber';
    riskLabel = '🟡 Moderate RTO Risk';
    recommendation = !hasLandmark
      ? 'Adding a nearby landmark will reduce rider delivery failures by ~40%.'
      : 'Standard parcel. Standard delivery attempt protocols apply.';
  }

  return {
    isValidPincode,
    pincode: cleanPin,
    zone: pinInfo.zone,
    zoneLabel: pinInfo.label,
    addressScore,
    hasLandmark,
    hasPremise,
    missingElements,
    rtoRiskPct,
    riskLevel,
    riskLabel,
    badgeColor,
    recommendation,
    isCod,
    deliveryProbability: 100 - rtoRiskPct
  };
}

module.exports = {
  verifyAddressAndPredictRto
};

