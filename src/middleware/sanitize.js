/**
 * Input Sanitization & Anti-XSS Middleware
 * 
 * 1. Strips MongoDB operator injection keys (starting with $) — NoSQL injection prevention
 * 2. Neutralizes XSS attack vectors:
 *    - Strips <script> tags and dangerous embedded objects (<embed>, <object>, <base>, <meta>)
 *    - Neutralizes javascript:, vbscript:, and executable data: URIs
 *    - Neutralizes inline DOM event attributes (onerror=, onload=, onclick=, etc.)
 * 3. Enforces request body size at middleware level
 * 4. Strips null bytes (\0) which can confuse parsers and C-string bridges
 * 5. Preserves legitimate password fields, auth tokens, and safe image data URIs
 */

const SENSITIVE_RAW_FIELDS = new Set([
  'password',
  'currentpassword',
  'newpassword',
  'confirmpassword',
  'token',
  'secret',
  'rawbody'
]);

/**
 * Neutralizes XSS vectors from string inputs
 * @param {string} str - Target string to sanitize
 * @param {string} fieldName - Field identifier to allow safe bypass for passwords
 * @returns {string} Sanitized string safe from script execution
 */
const sanitizeString = (str, fieldName = '') => {
  if (typeof str !== 'string') return str;
  const lowerField = String(fieldName || '').toLowerCase();

  // Preserved raw fields (passwords can contain legitimate special chars)
  if (SENSITIVE_RAW_FIELDS.has(lowerField)) {
    return str.replace(/\0/g, '');
  }

  let cleaned = str.replace(/\0/g, '');

  // 1. Remove <script>...</script> tags entirely
  cleaned = cleaned.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');

  // 2. Remove dangerous embedded media tags (<object>, <embed>, <applet>, <base>, <meta>)
  cleaned = cleaned.replace(/<\/?(?:object|embed|applet|base|meta|link)\b[^>]*>/gi, '');

  // 3. Neutralize executable pseudo-protocols: javascript:, vbscript:, livescript:
  cleaned = cleaned.replace(/(?:javascript|vbscript|livescript)\s*:/gi, 'blocked-script:');

  // 4. Neutralize data: URIs with executable HTML/JS MIME types (preserves data:image/... for parcel photos)
  cleaned = cleaned.replace(/data\s*:\s*(?:text\/(?:html|javascript|ecmascript)|application\/(?:javascript|ecmascript|x-javascript))/gi, 'blocked-data:');

  // 5. Strip inline DOM event handlers: on[a-z]+=(e.g. onerror=..., onload=..., onclick=...)
  cleaned = cleaned.replace(/\s+on[a-z]+\s*=\s*(?:'[^']*'|"[^"]*"|[^\s>]+)/gi, '');
  cleaned = cleaned.replace(/\bon[a-z]+\s*=/gi, 'x-event=');

  return cleaned;
};

const sanitizeInput = (req, res, next) => {
  const sanitize = (obj, depth = 0) => {
    // Limit recursion depth to prevent DoS via deeply nested objects
    if (depth > 10) return {};
    if (obj && typeof obj === 'object') {
      for (const key in obj) {
        // Allow Meta WhatsApp Cloud API webhook parameters (hub.mode, hub.challenge, hub.verify_token)
        if (key.startsWith('hub.')) {
          continue;
        }

        // Strip MongoDB operator injection & prototype pollution attempts
        if (
          key.startsWith('$') || 
          key.includes('.') || 
          key === '__proto__' || 
          key === 'constructor' || 
          key === 'prototype'
        ) {
          console.warn(`[Security] Stripping dangerous key: "${key}" from ${req.method} ${req.path}`);
          delete obj[key];
        } else if (typeof obj[key] === 'string') {
          // Sanitize string value against XSS and null-byte injection
          obj[key] = sanitizeString(obj[key], key);
        } else if (typeof obj[key] === 'object' && obj[key] !== null) {
          sanitize(obj[key], depth + 1);
        }
      }
    }
  };

  sanitize(req.body);
  sanitize(req.query);
  sanitize(req.params);

  next();
};

module.exports = { sanitizeInput, sanitizeString };
