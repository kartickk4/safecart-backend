/**
 * Safe Caching & Security Headers Middleware
 * Secure Cargo Logistics Platform
 *
 * Enforces:
 * 1. Strict Privacy Guardrails: Never publicly caches private shipment details,
 *    PII, payment data, auth credentials, or user-specific payloads.
 * 2. Injects standard Cache-Control headers across all responses.
 * 3. Route-level caching for safe, public, or slowly-changing endpoints.
 * 4. Transparent X-Cache hit/miss telemetry headers.
 */

const { cacheManager } = require('../services/cacheManager');

// Blacklist of URL patterns that MUST NEVER be cached
const STRICT_NO_CACHE_PATTERNS = [
  /\/api\/v[0-9]+\/auth/,
  /\/auth\//,
  /\/api\/v[0-9]+\/profile/,
  /\/profile\//,
  /\/api\/v[0-9]+\/wallet/,
  /\/wallet\//,
  /\/api\/v[0-9]+\/claims/,
  /\/claims\//,
  /\/api\/v[0-9]+\/youpi/,
  /\/youpi\//,
  /\/webhook\//,
  /\/pay\//,
  /\/fund/,
  /\/send-otp/,
  /\/verify-otp/,
  /\/reset-password/,
  /\/switch-role/
];

/**
 * Global Security Middleware:
 * Injects anti-caching headers on all private / sensitive routes to prevent
 * browser or proxy leakage of PII, payments, and auth tokens.
 */
const enforcePrivacyHeaders = (req, res, next) => {
  const url = req.originalUrl || req.url;

  const isSensitive = STRICT_NO_CACHE_PATTERNS.some(pattern => pattern.test(url));
  const isStateChanging = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method);

  if (isSensitive || isStateChanging) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }

  next();
};

/**
 * Route-Level Safe Caching Middleware
 *
 * @param {object} options
 * @param {number} options.ttlSeconds - Time-to-live in seconds
 * @param {string} options.namespace - Cache namespace (e.g. 'logistics:rates', 'admin:analytics')
 * @param {boolean} options.isUserSpecific - If true, isolates cache key by authenticated user/tenant ID
 * @param {string[]} options.tags - Invalidation tags
 */
const routeCache = (options = {}) => {
  const {
    ttlSeconds = 300,
    namespace = 'routes',
    isUserSpecific = false,
    tags = []
  } = options;

  return async (req, res, next) => {
    // Only cache GET or idempotent POST rate calculation requests
    if (req.method !== 'GET' && req.method !== 'POST') {
      return next();
    }

    const url = req.originalUrl || req.url;

    // Safety check: Never cache sensitive blacklisted endpoints
    if (STRICT_NO_CACHE_PATTERNS.some(pattern => pattern.test(url))) {
      return next();
    }

    // Build deterministic cache key
    const keyParams = {
      url: req.baseUrl + req.path,
      query: req.query || {}
    };

    if (req.method === 'POST') {
      keyParams.body = req.body || {};
    }

    // Enforce tenant/user separation if marked user-specific
    if (isUserSpecific) {
      const userId = req.user?._id || req.user?.id || 'anonymous';
      const tenantId = req.user?.tenantId || 'default_tenant';
      keyParams.tenantId = String(tenantId);
      keyParams.userId = String(userId);
    }

    const cacheKey = cacheManager.generateKey(namespace, keyParams);

    try {
      // 1. Attempt cache retrieval
      const cached = await cacheManager.get(cacheKey);

      if (cached) {
        res.setHeader('X-Cache', 'HIT');
        res.setHeader('X-Cache-Key', cacheKey);
        res.setHeader('Cache-Control', isUserSpecific ? `private, max-age=${ttlSeconds}` : `public, max-age=${ttlSeconds}`);
        return res.status(200).json(cached);
      }

      // 2. Cache Miss: Intercept res.json to capture response
      res.setHeader('X-Cache', 'MISS');
      res.setHeader('X-Cache-Key', cacheKey);
      res.setHeader('Cache-Control', isUserSpecific ? `private, max-age=${ttlSeconds}` : `public, max-age=${ttlSeconds}`);

      const originalJson = res.json.bind(res);
      res.json = (body) => {
        // Only cache successful 200 OK responses
        if (res.statusCode >= 200 && res.statusCode < 300 && body !== undefined && body !== null) {
          // Asynchronously write to cache without blocking HTTP response
          cacheManager.set(cacheKey, body, ttlSeconds, tags).catch(err => {
            console.warn('[CacheMiddleware Write Warning]:', err.message);
          });
        }
        return originalJson(body);
      };

      next();
    } catch (err) {
      console.warn('[CacheMiddleware Fallback to Origin]:', err.message);
      // Seamless fallback to original handler
      next();
    }
  };
};

module.exports = {
  enforcePrivacyHeaders,
  routeCache,
  STRICT_NO_CACHE_PATTERNS
};
