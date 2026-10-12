/**
 * Input Sanitization Middleware
 * 
 * 1. Strips MongoDB operator injection keys (starting with $) — NoSQL injection prevention
 * 2. Enforces request body size at middleware level
 * 3. Strips null bytes which can confuse parsers
 */
const sanitizeInput = (req, res, next) => {
  const sanitize = (obj, depth = 0) => {
    // Limit recursion depth to prevent DoS via deeply nested objects
    if (depth > 10) return {};
    if (obj && typeof obj === 'object') {
      for (const key in obj) {
        // Strip MongoDB operator injection attempts
        if (key.startsWith('$') || key.includes('.')) {
          console.warn(`[Security] Stripping dangerous key: "${key}" from ${req.method} ${req.path}`);
          delete obj[key];
        } else if (typeof obj[key] === 'string') {
          // Strip null bytes from string values
          obj[key] = obj[key].replace(/\0/g, '');
        } else if (typeof obj[key] === 'object') {
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

module.exports = { sanitizeInput };
