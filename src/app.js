require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { redisClient } = require('./config/redis');

// Helper function to resolve module whether nested in subfolder or flat at root
function loadModule(relSubPath, relRootPath) {
  const p1 = path.resolve(__dirname, relSubPath);
  const p2 = path.resolve(__dirname, relRootPath);
  const p3 = path.resolve(__dirname, '..', relRootPath);
  if (fs.existsSync(p1)) return require(p1);
  if (fs.existsSync(p2)) return require(p2);
  if (fs.existsSync(p3)) return require(p3);
  try { return require(`./${relSubPath}`); } catch(e) {}
  return require(`./${relRootPath}`);
}

let errorHandler;
try {
  errorHandler = loadModule('middleware/error.js', 'error.js').errorHandler;
} catch (e) {
  errorHandler = (err, req, res, next) => {
    console.error(err.stack);
    const statusCode = res.statusCode === 200 ? 500 : res.statusCode;
    res.status(statusCode).json({
      error: err.message || 'Internal Server Error',
      stack: process.env.NODE_ENV === 'production' ? null : err.stack,
    });
  };
}

// Import routers with dual resolution (subfolder or flat root)
const authRoutes = loadModule('routes/authRoutes.js', 'authRoutes.js');
const profileRoutes = loadModule('routes/profileRoutes.js', 'profileRoutes.js');
const shipmentRoutes = loadModule('routes/shipmentRoutes.js', 'shipmentRoutes.js');
const trackingRoutes = loadModule('routes/trackingRoutes.js', 'trackingRoutes.js');
const claimRoutes = loadModule('routes/claimRoutes.js', 'claimRoutes.js');
const notificationRoutes = loadModule('routes/notificationRoutes.js', 'notificationRoutes.js');
const rewardRoutes = loadModule('routes/rewardRoutes.js', 'rewardRoutes.js');
const walletRoutes = loadModule('routes/walletRoutes.js', 'walletRoutes.js');
const { sanitizeInput } = loadModule('middleware/sanitize.js', 'sanitize.js');
const agentRoutes = loadModule('routes/agentRoutes.js', 'agentRoutes.js');
const adminRoutes = loadModule('routes/adminRoutes.js', 'adminRoutes.js');
const whatsappRoutes = loadModule('routes/whatsappRoutes.js', 'whatsappRoutes.js');
const youpiRoutes = loadModule('routes/youpiRoutes.js', 'youpiRoutes.js');
const uploadRoutes = loadModule('routes/uploadRoutes.js', 'uploadRoutes.js');
const { enforcePrivacyHeaders } = loadModule('middleware/cacheMiddleware.js', 'middleware/cacheMiddleware.js');

const app = express();

// 0. Request Correlation ID Middleware (X-Request-ID)
app.use((req, res, next) => {
  const incomingId = req.headers['x-request-id'];
  const requestId = (typeof incomingId === 'string' && incomingId.trim().length > 0)
    ? incomingId.trim()
    : (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'));
  
  req.id = requestId;
  res.setHeader('X-Request-ID', requestId);
  next();
});

// Apply Privacy & Anti-Cache Headers across sensitive routes
app.use(enforcePrivacyHeaders);

// 1. Security Headers Middleware (Helmet Hardening)
const isProd = process.env.NODE_ENV === 'production';

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // SECURITY: 'unsafe-inline' removed — use nonces/hashes in production
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"], // unsafe-inline needed for Tailwind CSS in-browser
      imgSrc: ["'self'", "data:", "https:", "https://i.ibb.co"],
      connectSrc: [
        "'self'",
        "https:",
        ...(isProd ? [] : ["http://localhost:*", "http://127.0.0.1:*"])
      ],
      fontSrc: ["'self'", "https://fonts.googleapis.com", "https://fonts.gstatic.com"],
      objectSrc: ["'none'"],
      ...(isProd ? { 'upgrade-insecure-requests': [] } : {})
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
  dnsPrefetchControl: { allow: false },
  frameguard: { action: "deny" },
  hidePoweredBy: true,
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  ieNoOpen: true,
  noSniff: true,
  originAgentCluster: true,
  permittedCrossDomainPolicies: { permittedPolicies: "none" },
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  xssFilter: true
}));

// 2. Strict CORS Security Policy
// SECURITY: LAN IP ranges are only allowed in development — never in production.
const allowedOrigins = process.env.FRONTEND_URL 
  ? process.env.FRONTEND_URL.split(',').map(url => url.trim()).filter(Boolean)
  : ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:5173'];

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (such as mobile native apps, curl, server-to-server)
    if (!origin) {
      return callback(null, true);
    }

    // Always block wildcard (*) in origins list
    if (allowedOrigins.includes('*')) {
      console.error('[SECURITY] Wildcard (*) detected in FRONTEND_URL — blocking all requests.');
      return callback(new Error('Invalid CORS configuration'));
    }

    // Allow Capacitor Mobile App origins (Android & iOS)
    if (
      origin === 'https://localhost' || 
      origin === 'http://localhost' || 
      origin.startsWith('capacitor://') ||
      origin.startsWith('ionic://')
    ) {
      return callback(null, true);
    }

    // Strict domain matching for production domains
    const isExactSecureKaro = /^https:\/\/([a-zA-Z0-9-]+\.)?securekaro\.in$/.test(origin);
    const isConfiguredFrontend = process.env.FRONTEND_URL && origin === process.env.FRONTEND_URL;

    if (
      allowedOrigins.includes(origin) || 
      isExactSecureKaro ||
      isConfiguredFrontend
    ) {
      return callback(null, true);
    }

    // Allow localhost and LAN IPs in development only
    if (!isProd) {
      if (
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ||
        /^https?:\/\/(192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+)(:\d+)?$/.test(origin)
      ) {
        return callback(null, true);
      }
    }

    return callback(new Error('Not allowed by CORS security policy'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Request-ID'],
  exposedHeaders: ['X-Request-ID'],
  maxAge: 86400 // Cache preflight for 24h to reduce OPTIONS requests
};

app.use(cors(corsOptions));

// 3. Global Rate Limiting Middleware
const isLoadTestRequest = () => {
  return process.env.NODE_ENV === 'test';
};

const createRedisLimiterStore = (prefix) => {
  if (redisClient) {
    try {
      return new RedisStore({
        sendCommand: (...args) => redisClient.call(...args),
        prefix: `rl:${prefix}:`
      });
    } catch (e) {
      console.warn(`[RATE LIMITER] RedisStore fallback to memory for ${prefix}:`, e.message);
    }
  }
  return undefined;
};

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisLimiterStore('global'),
  skip: isLoadTestRequest
});

app.use('/api/', globalLimiter);

// Standard Body Parser Middlewares
// Allow up to 15mb payload for parcel and defect photo uploads
app.use(express.json({ 
  limit: '15mb',
  verify: (req, res, buf) => {
    // Preserve raw body buffer for HMAC-SHA256 webhook signatures (YouPI-PG etc)
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Apply global sanitization middleware to prevent NoSQL query injections
app.use(sanitizeInput);

// Basic Welcome & Healthcheck API
app.get('/', (req, res) => {
  res.json({
    message: 'Welcome to the SecureKaro Courier Logistics & Shipping API!',
    status: 'online',
    health: '/health'
  });
});

app.get('/health', (req, res) => {
  const dbStatusMap = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting'
  };
  const dbState = mongoose.connection ? (dbStatusMap[mongoose.connection.readyState] || 'unknown') : 'uninitialized';
  const isHealthy = dbState === 'connected';

  // SECURITY: In production, return minimal info — no internal details exposed
  const responseBody = {
    status: isHealthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString()
  };

  if (!isProd) {
    responseBody.database = dbState;
    responseBody.uptime = Math.floor(process.uptime());
    responseBody.service = 'securekaro-backend';
  }

  res.status(isHealthy ? 200 : 503).json(responseBody);
});

// Network information endpoint for mobile scanning over Wi-Fi
const os = require('os');
const getActiveLocalIp = () => {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('127.')) {
        return net.address;
      }
    }
  }
  return '192.168.237.115';
};

// SECURITY: Network info endpoint disabled in production — internal IP disclosure
app.get(['/api/v1/network-info', '/network-info'], (req, res) => {
  if (isProd) {
    return res.status(404).json({ error: 'Not found.' });
  }
  const localIp = getActiveLocalIp();
  const backendPort = process.env.PORT || 5001;
  res.json({
    localIp,
    frontendPort: 3001,
    backendPort,
    frontendNetworkUrl: `http://${localIp}:3001`,
    backendNetworkUrl: `http://${localIp}:${backendPort}/api/v1`
  });
});

// Auth-specific strict rate limiter backed by central Redis
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20, // SECURITY: Tightened to 20 attempts per 15 mins to defeat distributed brute-force
  message: { error: 'Too many authentication attempts. Please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisLimiterStore('auth'),
  skipSuccessfulRequests: true, // Only count failed attempts toward the limit
  skip: isLoadTestRequest
});

// AI Agent rate limiter backed by central Redis — prevent abuse of LLM-backed endpoints
const agentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30, // 30 messages per minute per IP
  message: { error: 'Too many agent requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisLimiterStore('agent'),
  skip: isLoadTestRequest
});

// App Router Declarations (Standard v1 prefix)
app.use('/api/v1/auth', authLimiter, authRoutes);
app.use('/api/v1/profile', profileRoutes);
app.use('/api/v1/shipments', shipmentRoutes);
app.use('/api/v1/tracking', trackingRoutes);
app.use('/api/v1/claims', claimRoutes);
app.use('/api/v1/notifications', notificationRoutes);
app.use('/api/v1/rewards', rewardRoutes);
app.use('/api/v1/wallet', walletRoutes);
app.use('/api/v1/agent', agentLimiter, agentRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/whatsapp', whatsappRoutes);
app.use('/api/v1/youpi', youpiRoutes);
app.use('/api/v1/upload', uploadRoutes);

// Backward-compatibility and direct-route aliases (prevents 404 if /api/v1 is omitted)
app.use('/auth', authLimiter, authRoutes);
app.use('/profile', profileRoutes);
app.use('/shipments', shipmentRoutes);
app.use('/tracking', trackingRoutes);
app.use('/claims', claimRoutes);
app.use('/notifications', notificationRoutes);
app.use('/rewards', rewardRoutes);
app.use('/wallet', walletRoutes);
app.use('/agent', agentRoutes);
app.use('/admin', adminRoutes);
app.use('/youpi', youpiRoutes);
app.use('/upload', uploadRoutes);

app.use(errorHandler);

module.exports = app;
