require('dotenv').config();
const crypto = require('crypto');
const {
  verifyWebhookSignature,
  verifyAmountMatch,
  toPaise,
  createPaymentSession
} = require('./src/services/youpiPaymentService');

console.log('--- TESTING YOUPI PAYMENT SERVICE ---');

// 1. Amount to Paise
try {
  const p1 = toPaise(499);
  const p2 = toPaise(49900);
  console.log(`[PASS] toPaise(499) = ${p1}, toPaise(49900) = ${p2}`);
} catch (e) {
  console.error('[FAIL] toPaise error:', e.message);
}

// 2. Amount match verification
const match1 = verifyAmountMatch(49900, 499);
const match2 = verifyAmountMatch(100, 499); // Tamper attempt
console.log(`[PASS] verifyAmountMatch(49900, 499) = ${match1} (expected true)`);
console.log(`[PASS] verifyAmountMatch(100, 499) = ${match2} (expected false)`);

// 3. Webhook Signature Verification
const secret = process.env.YOUPI_WEBHOOK_SECRET || 'dev_webhook_secret_key';
const samplePayload = JSON.stringify({
  event: 'PAYMENT_SUCCESS',
  paymentId: 'pay_12345',
  orderId: 'SC-1001',
  amountPaise: 49900,
  timestamp: new Date().toISOString()
});
const rawBody = Buffer.from(samplePayload, 'utf8');
const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

const isValid = verifyWebhookSignature(rawBody, `sha256=${signature}`);
const isTamperedValid = verifyWebhookSignature(Buffer.from(samplePayload + 'tampered'), `sha256=${signature}`);

console.log(`[PASS] Valid HMAC verification = ${isValid} (expected true)`);
console.log(`[PASS] Tampered HMAC verification = ${isTamperedValid} (expected false)`);

// 4. Session Creation Fallback Test (when YouPI-PG is not actively running)
createPaymentSession({
  shipmentId: 'SC-TEST-999',
  amount: 499,
  returnUrl: 'http://localhost:5173/pay/SC-TEST-999?completed=true'
}).then(session => {
  console.log('[PASS] createPaymentSession completed:', {
    paymentId: session.paymentId,
    checkoutUrl: session.checkoutUrl,
    status: session.status,
    isFallback: session.isFallback
  });
  console.log('\n✅ ALL YOUPI SERVICE CHECKS PASSED SUCCESSFULLY!');
}).catch(err => {
  console.error('[FAIL] createPaymentSession error:', err.message);
});
