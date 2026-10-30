/**
 * Enterprise File Upload Security Guard
 * 
 * Implements strict defense-in-depth file validation:
 * 1. Allowlist-only MIME types and file extensions.
 * 2. Deep binary magic bytes inspection (prevents extension spoofing / polyglot attacks).
 * 3. Double-extension and dangerous extension blocking (.php.png, .exe, .svg, .html).
 * 4. Path traversal and null-byte filename sanitization.
 * 5. Strict Base64 data-URI payload validation.
 */
const path = require('path');
const crypto = require('crypto');

// Strict Allowlist
const ALLOWED_MIME_TYPES = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf'
]);

const ALLOWED_EXTENSIONS = Object.freeze([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.heic',
  '.pdf'
]);

// Explicit Dangerous Executable / Script Extensions Denylist
const DANGEROUS_EXTENSIONS = Object.freeze([
  '.exe', '.dll', '.bat', '.cmd', '.sh', '.bash', '.php', '.php3', '.php4', '.php5',
  '.phtml', '.phar', '.pl', '.cgi', '.js', '.vbs', '.msi', '.jar', '.html', '.htm',
  '.svg', '.xml', '.xhtml', '.asp', '.aspx', '.jsp', '.jspx', '.py', '.ps1', '.htaccess'
]);

const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15 MB

/**
 * Inspect raw binary buffer magic bytes to accurately detect file format
 * @param {Buffer} buffer
 * @returns {string|null} Detected MIME type or null if unrecognized
 */
function detectMagicBytes(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 4) {
    return null;
  }

  // JPEG / JPG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return 'image/jpeg';
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return 'image/png';
  }

  // PDF: 25 50 44 46 (%PDF)
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x4E || (
      buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46)) {
    return 'application/pdf';
  }

  // WEBP: RIFF (bytes 0-3) + WEBP (bytes 8-11)
  if (buffer.length >= 12 &&
      buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    return 'image/webp';
  }

  // HEIC / HEIF: byte 4-7 = 'ftyp', bytes 8-11 in ['heic', 'heix', 'hevc', 'mif1', 'msf1']
  if (buffer.length >= 12 &&
      buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) {
    const brand = buffer.toString('utf8', 8, 12).toLowerCase();
    if (['heic', 'heix', 'hevc', 'mif1', 'msf1'].includes(brand)) {
      return 'image/heic';
    }
  }

  return null;
}

/**
 * Validate raw filename for dangerous patterns, double-extensions, and null-bytes
 * @param {string} originalname
 * @returns {{ valid: boolean, error?: string, safeExt?: string }}
 */
function validateFilename(originalname) {
  if (!originalname || typeof originalname !== 'string') {
    return { valid: false, error: 'Filename is missing or invalid' };
  }

  // Strip null bytes and control chars
  const sanitized = originalname.replace(/[\0\x00-\x1F\x7F]/g, '').trim();
  if (!sanitized) {
    return { valid: false, error: 'Filename contains forbidden control characters' };
  }

  const ext = path.extname(sanitized).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return { 
      valid: false, 
      error: `Unsupported file extension (${ext || 'none'}). Only JPG, PNG, WEBP, HEIC, and PDF are permitted.` 
    };
  }

  // Check for dangerous double extensions (e.g. "payload.php.png", "script.exe.jpg")
  const parts = sanitized.toLowerCase().split('.');
  if (parts.length > 2) {
    for (let i = 1; i < parts.length - 1; i++) {
      const subExt = `.${parts[i]}`;
      if (DANGEROUS_EXTENSIONS.includes(subExt)) {
        return { 
          valid: false, 
          error: `Malicious double-extension detected: "${subExt}". Upload rejected.` 
        };
      }
    }
  }

  return { valid: true, safeExt: ext };
}

/**
 * Full deep validation of an uploaded file buffer
 * @param {Buffer} buffer - Binary content
 * @param {string} originalname - Client filename
 * @param {string} declaredMimetype - Content-Type header
 * @returns {{ valid: boolean, error?: string, detectedMime?: string }}
 */
function validateFileBuffer(buffer, originalname, declaredMimetype) {
  if (!buffer || !Buffer.isBuffer(buffer)) {
    return { valid: false, error: 'Empty or invalid file buffer' };
  }

  if (buffer.length === 0) {
    return { valid: false, error: 'File is empty (0 bytes)' };
  }

  if (buffer.length > MAX_FILE_SIZE) {
    return { valid: false, error: `File size (${(buffer.length / (1024 * 1024)).toFixed(1)}MB) exceeds 15MB limit.` };
  }

  // 1. Filename checks
  const nameCheck = validateFilename(originalname);
  if (!nameCheck.valid) {
    return nameCheck;
  }

  // 2. MIME type allowlist check
  const declared = (declaredMimetype || '').toLowerCase().trim();
  if (!ALLOWED_MIME_TYPES.includes(declared)) {
    return { valid: false, error: `Disallowed MIME type: "${declared}". Only JPG, PNG, WEBP, HEIC, and PDF are allowed.` };
  }

  // 3. Binary Magic Bytes inspection
  const detected = detectMagicBytes(buffer);
  if (!detected) {
    return { 
      valid: false, 
      error: 'File content does not match permitted image/PDF format (signature verification failed).' 
    };
  }

  // Ensure detected format matches declared type family
  const isJpegMatch = detected === 'image/jpeg' && (declared === 'image/jpeg' || declared === 'image/jpg');
  const isPngMatch = detected === 'image/png' && declared === 'image/png';
  const isWebpMatch = detected === 'image/webp' && declared === 'image/webp';
  const isPdfMatch = detected === 'application/pdf' && declared === 'application/pdf';
  const isHeicMatch = detected === 'image/heic' && (declared === 'image/heic' || declared === 'image/heif');

  if (!isJpegMatch && !isPngMatch && !isWebpMatch && !isPdfMatch && !isHeicMatch) {
    return { 
      valid: false, 
      error: `File signature mismatch: header claimed "${declared}" but content binary is "${detected}".` 
    };
  }

  return { valid: true, detectedMime: detected, safeExt: nameCheck.safeExt };
}

/**
 * Validate a Base64 dataUri payload
 * @param {string} dataUri - e.g. "data:image/jpeg;base64,..."
 * @returns {{ valid: boolean, error?: string, buffer?: Buffer, detectedMime?: string }}
 */
function validateBase64Payload(dataUri) {
  if (!dataUri || typeof dataUri !== 'string') {
    return { valid: false, error: 'Base64 dataUri is required' };
  }

  const matches = dataUri.match(/^data:([A-Za-z0-9-+\/]+);base64,(.+)$/);
  if (!matches || matches.length !== 3) {
    return { valid: false, error: 'Malformed Base64 data URI format' };
  }

  const declaredMime = matches[1].toLowerCase().trim();
  if (!ALLOWED_MIME_TYPES.includes(declaredMime)) {
    return { valid: false, error: `Unsupported Base64 format: "${declaredMime}". Allowed: JPG, PNG, WEBP, HEIC, PDF.` };
  }

  const base64Data = matches[2];
  let buffer;
  try {
    buffer = Buffer.from(base64Data, 'base64');
  } catch (e) {
    return { valid: false, error: 'Invalid Base64 binary encoding' };
  }

  if (buffer.length === 0) {
    return { valid: false, error: 'Base64 payload decoded to 0 bytes' };
  }

  if (buffer.length > MAX_FILE_SIZE) {
    return { valid: false, error: `Base64 image size exceeds maximum 15MB limit.` };
  }

  // Binary magic bytes inspection on decoded buffer
  const detected = detectMagicBytes(buffer);
  if (!detected || detected !== declaredMime) {
    return { 
      valid: false, 
      error: `Base64 binary signature verification failed: content does not match ${declaredMime}.` 
    };
  }

  return { valid: true, buffer, detectedMime: detected };
}

/**
 * Express Multer fileFilter callback for early stream rejection
 */
function multerFileFilter(req, file, cb) {
  const nameCheck = validateFilename(file.originalname);
  if (!nameCheck.valid) {
    return cb(new Error(nameCheck.error), false);
  }

  const declared = (file.mimetype || '').toLowerCase().trim();
  if (!ALLOWED_MIME_TYPES.includes(declared)) {
    return cb(new Error(`Unsupported file type: ${declared}. Only JPG, PNG, WEBP, HEIC, and PDF allowed.`), false);
  }

  cb(null, true);
}

module.exports = {
  ALLOWED_MIME_TYPES,
  ALLOWED_EXTENSIONS,
  DANGEROUS_EXTENSIONS,
  MAX_FILE_SIZE,
  detectMagicBytes,
  validateFilename,
  validateFileBuffer,
  validateBase64Payload,
  multerFileFilter
};

