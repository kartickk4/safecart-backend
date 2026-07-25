require('dotenv').config();
const path = require('path');
const app = require(path.join(__dirname, 'app'));
const connectDB = require(path.join(__dirname, 'config', 'db'));
const { initTrackingJob } = require(path.join(__dirname, 'jobs', 'trackingPoll'));

const PORT = process.env.PORT || 5000;
const HOST = '0.0.0.0';

// Start Express listener on 0.0.0.0 for container compatibility (Render/Docker)
const server = app.listen(PORT, HOST, () => {
  console.log(`==================================================`);
  console.log(` Safecart Escrow Backend Server Running on ${HOST}:${PORT}`);
  console.log(` Mode: ${process.env.CARRIER_TRACKING_MOCK === 'true' ? 'MOCKING ACTIVE' : 'LIVE API'}`);
  console.log(` Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`==================================================`);
});

// Connect to MongoDB Atlas
connectDB().then(() => {
  initTrackingJob();
}).catch(err => {
  console.error('Database initialization warning:', err.message);
});

// Graceful shutdown handling for container deployments (Render/K8s/Docker)
const gracefulShutdown = (signal) => {
  console.log(`Received ${signal}. Shutting down gracefully...`);
  server.close(() => {
    console.log('HTTP server closed.');
    process.exit(0);
  });
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
