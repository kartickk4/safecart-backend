const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

let errorHandler;
try {
  errorHandler = require('./middleware/error.js').errorHandler;
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

// Import routers with explicit .js extension
const authRoutes = require('./routes/authRoutes.js');
const profileRoutes = require('./routes/profileRoutes.js');
const shipmentRoutes = require('./routes/shipmentRoutes.js');
const trackingRoutes = require('./routes/trackingRoutes.js');
const claimRoutes = require('./routes/claimRoutes.js');

const app = express();

// 1. Security Headers Middleware (Helmet)
app.use(helmet());

// 2. Strict CORS Security Policy (Restricted to Authorized Domains)
const allowedOrigins = process.env.FRONTEND_URL 
  ? process.env.FRONTEND_URL.split(',').map(url => url.trim())
  : ['http://localhost:3000', 'http://localhost:5173', 'https://safecart.app'];

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps, curl, Postman, or server-to-server)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    
    return callback(new Error(`CORS Security Policy: Access from origin ${origin} is unauthorized.`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
};

app.use(cors(corsOptions));

// 3. Rate Limiting Middleware (Brute-Force & Spam Prevention)
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes window
  max: 200, // Max 200 requests per 15 minutes for general API endpoints
  message: { error: 'Too many requests from this IP, please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes window
  max: 15, // Max 15 sensitive auth/OTP attempts per IP per 15 minutes
  message: { error: 'Too many authentication or OTP attempts from this IP. Please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Apply global rate limiting to all API routes
app.use('/api/', globalLimiter);

// Apply strict rate limiting to sensitive authentication & OTP endpoints
app.use('/api/v1/auth/login', authLimiter);
app.use('/api/v1/auth/signup', authLimiter);
app.use('/api/v1/auth/send-otp', authLimiter);
app.use('/api/v1/auth/send-email-otp', authLimiter);

// Standard Body Parser Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Basic Welcome & Healthcheck API
app.get('/', (req, res) => {
  res.json({
    message: 'Welcome to the Safecart Secure Escrow Backend API!',
    documentation: 'See README.md for endpoint specifications.',
    health: '/health',
    status: 'online',
    cors: 'restricted'
  });
});

app.get('/health', (req, res) => {
  const isConnected = mongoose.connection.readyState === 1;
  res.json({
    status: isConnected ? 'healthy' : 'degraded',
    database: isConnected ? 'connected' : 'disconnected',
    timestamp: new Date(),
    service: 'safecart-backend',
    message: isConnected 
      ? 'Service is running normally.' 
      : 'Database connection failed. Please make sure your current IP address is whitelisted in your MongoDB Atlas dashboard.'
  });
});

// App Router Declarations
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/profile', profileRoutes);
app.use('/api/v1/shipments', shipmentRoutes);
app.use('/api/v1/tracking', trackingRoutes);
app.use('/api/v1/claims', claimRoutes);

// Global Error Handler
app.use(errorHandler);

module.exports = app;
