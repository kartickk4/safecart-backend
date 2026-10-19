const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');

// Helper function to resolve module whether nested in subfolder, in src, or flat at root
function loadModule(relSubPath, relRootPath) {
  const p1 = path.resolve(__dirname, relSubPath);
  const pSrc = path.resolve(__dirname, 'src', relSubPath);
  const p2 = path.resolve(__dirname, relRootPath);
  const p3 = path.resolve(__dirname, '..', relRootPath);
  if (fs.existsSync(p1)) return require(p1);
  if (fs.existsSync(pSrc)) return require(pSrc);
  if (fs.existsSync(p2)) return require(p2);
  if (fs.existsSync(p3)) return require(p3);
  try { return require(`./${relSubPath}`); } catch(e) {}
  try { return require(`./src/${relSubPath}`); } catch(e) {}
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
const { sanitizeInput } = loadModule('middleware/sanitize.js', 'sanitize.js');
const agentRoutes = loadModule('routes/agentRoutes.js', 'agentRoutes.js');
const adminRoutes = loadModule('routes/adminRoutes.js', 'adminRoutes.js');

const app = express();

// 1. Security Headers Middleware (Helmet Hardening)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "https:", "http://localhost:*", "http://127.0.0.1:*", "http://192.168.*:*", "http://10.*:*"]
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
  referrerPolicy: { policy: "no-referrer" },
  xssFilter: true
}));

// 2. Strict CORS Security Policy (Permits localhost & local LAN IPs for mobile phone testing)
const allowedOrigins = process.env.FRONTEND_URL 
  ? process.env.FRONTEND_URL.split(',').map(url => url.trim())
  : ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:5173', 'https://securekaro.app'];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (
      allowedOrigins.includes(origin) || 
      allowedOrigins.includes('*') ||
      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ||
      /^https?:\/\/(192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+)(:\d+)?$/.test(origin)
    ) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS security policy'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
};

app.use(cors(corsOptions));

// 3. Global Rate Limiting Middleware
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/api/', globalLimiter);

// Standard Body Parser Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Apply global sanitization middleware to prevent NoSQL query injections
app.use(sanitizeInput);

// Basic Welcome & Healthcheck API
app.get('/', (req, res) => {
  res.json({
    message: 'Welcome to the SecureKaro Secure Escrow Backend API!',
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

  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'healthy' : 'degraded',
    database: dbState,
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    service: 'securekaro-backend',
    env: process.env.NODE_ENV || 'development'
  });
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

app.get(['/api/v1/network-info', '/network-info'], (req, res) => {
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

// Auth-specific strict rate limiter
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 mins
  max: 50, // Limit each IP to 50 auth requests per 15 minutes
  message: { error: 'Too many authentication attempts. Please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false
});

// App Router Declarations (Standard v1 prefix)
app.use('/api/v1/auth', authLimiter, authRoutes);
app.use('/api/v1/profile', profileRoutes);
app.use('/api/v1/shipments', shipmentRoutes);
app.use('/api/v1/tracking', trackingRoutes);
app.use('/api/v1/claims', claimRoutes);
app.use('/api/v1/notifications', notificationRoutes);
app.use('/api/v1/rewards', rewardRoutes);
app.use('/api/v1/agent', agentRoutes);
app.use('/api/v1/admin', adminRoutes);

// Backward-compatibility and direct-route aliases (prevents 404 if /api/v1 is omitted)
app.use('/auth', authLimiter, authRoutes);
app.use('/profile', profileRoutes);
app.use('/shipments', shipmentRoutes);
app.use('/tracking', trackingRoutes);
app.use('/claims', claimRoutes);
app.use('/notifications', notificationRoutes);
app.use('/rewards', rewardRoutes);
app.use('/agent', agentRoutes);
app.use('/admin', adminRoutes);

app.use(errorHandler);

module.exports = app;
