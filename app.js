const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

function loadModule(relSubPath, relRootPath) {
  const p1 = path.resolve(__dirname, relSubPath);
  const p2 = path.resolve(__dirname, relRootPath);
  const p3 = path.resolve(__dirname, 'src', relSubPath);
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

// Import routers with dual resolution
const authRoutes = loadModule('routes/authRoutes.js', 'authRoutes.js');
const profileRoutes = loadModule('routes/profileRoutes.js', 'profileRoutes.js');
const shipmentRoutes = loadModule('routes/shipmentRoutes.js', 'shipmentRoutes.js');
const trackingRoutes = loadModule('routes/trackingRoutes.js', 'trackingRoutes.js');
const claimRoutes = loadModule('routes/claimRoutes.js', 'claimRoutes.js');

const app = express();

app.use(helmet());

const allowedOrigins = process.env.FRONTEND_URL 
  ? process.env.FRONTEND_URL.split(',').map(url => url.trim())
  : ['*'];

const corsOptions = {
  origin: (origin, callback) => callback(null, true),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
};

app.use(cors(corsOptions));

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/api/', globalLimiter);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.json({
    message: 'Welcome to the Safecart Secure Escrow Backend API!',
    status: 'online',
    health: '/health'
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date(),
    service: 'safecart-backend'
  });
});

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/profile', profileRoutes);
app.use('/api/v1/shipments', shipmentRoutes);
app.use('/api/v1/tracking', trackingRoutes);
app.use('/api/v1/claims', claimRoutes);

app.use(errorHandler);

module.exports = app;
