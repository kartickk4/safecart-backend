const {
  validateFilename,
  validateFileBuffer,
  validateBase64Payload,
  detectMagicBytes
} = require('../src/middleware/fileSecurity');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ PASS: ${message}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    failed++;
  }
}

console.log('\n🔒 Running File Upload Security Tests...\n');

// 1. Double extension attacks
console.log('Test Suite 1: Double Extension & Malicious Filename Defense');
const res1 = validateFilename('invoice.php.png');
assert(!res1.valid && res1.error.includes('double-extension'), 'Blocks invoice.php.png double extension');

const res2 = validateFilename('data.exe.jpg');
assert(!res2.valid && res2.error.includes('double-extension'), 'Blocks data.exe.jpg double extension');

const res3 = validateFilename('normal_photo.jpg');
assert(res3.valid, 'Allows legitimate normal_photo.jpg');

const res4 = validateFilename('document.pdf');
assert(res4.valid, 'Allows legitimate document.pdf');

const res5 = validateFilename('vector.svg');
assert(!res5.valid && res5.error.includes('Unsupported file extension'), 'Blocks executable SVG format');

// 2. Binary Magic Bytes Tests (Spoofed Extension Prevention)
console.log('\nTest Suite 2: Magic Bytes Content Verification');
const fakeJpg = Buffer.from('Plain text file masquerading as a JPEG image');
const res6 = validateFileBuffer(fakeJpg, 'avatar.jpg', 'image/jpeg');
assert(!res6.valid && res6.error.includes('signature verification failed'), 'Rejects non-binary text disguised as avatar.jpg');

const fakePng = Buffer.from('Random binary bytes without PNG header');
const res7 = validateFileBuffer(fakePng, 'badge.png', 'image/png');
assert(!res7.valid && res7.error.includes('signature verification failed'), 'Rejects invalid binary stream disguised as badge.png');

const validPngBuffer = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D]);
const res8 = validateFileBuffer(validPngBuffer, 'valid.png', 'image/png');
assert(res8.valid && res8.detectedMime === 'image/png', 'Accepts genuine PNG binary buffer');

const validJpgBuffer = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46]);
const res9 = validateFileBuffer(validJpgBuffer, 'photo.jpeg', 'image/jpeg');
assert(res9.valid && res9.detectedMime === 'image/jpeg', 'Accepts genuine JPEG binary buffer');

const validPdfBuffer = Buffer.from('%PDF-1.4\n1 0 obj\n');
const res10 = validateFileBuffer(validPdfBuffer, 'invoice.pdf', 'application/pdf');
assert(res10.valid && res10.detectedMime === 'application/pdf', 'Accepts genuine PDF binary buffer');

// 3. Base64 Data URI Payload Hardening
console.log('\nTest Suite 3: Base64 Payload Hardening');
const validPngBase64 = 'data:image/png;base64,' + validPngBuffer.toString('base64');
const res11 = validateBase64Payload(validPngBase64);
assert(res11.valid && res11.detectedMime === 'image/png', 'Accepts verified Base64 PNG image');

const maliciousHtmlBase64 = 'data:text/html;base64,' + Buffer.from('<h1>Hello World</h1>').toString('base64');
const res12 = validateBase64Payload(maliciousHtmlBase64);
assert(!res12.valid && res12.error.includes('Unsupported Base64 format'), 'Rejects Base64 HTML / Script payload');

const spoofedJpgBase64 = 'data:image/jpeg;base64,' + Buffer.from('invalid text payload').toString('base64');
const res13 = validateBase64Payload(spoofedJpgBase64);
assert(!res13.valid && res13.error.includes('signature verification failed'), 'Rejects Base64 payload with invalid magic bytes');

console.log(`\n========================================`);
console.log(`Results: ${passed} Passed, ${failed} Failed`);
console.log(`========================================\n`);

if (failed > 0) process.exit(1);
