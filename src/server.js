require('dotenv').config();
const path = require('path');
const app = require(path.join(__dirname, 'app'));
const connectDB = require(path.join(__dirname, 'config', 'db'));
const { initTrackingJob } = require(path.join(__dirname, 'jobs', 'trackingPoll'));
const { initReturnWindowCron } = require(path.join(__dirname, 'jobs', 'returnWindowAutoClose'));

const logger = require(path.join(__dirname, 'utils', 'logger'));

const PORT = process.env.PORT || 5000;
const HOST = '0.0.0.0';

// Start Express listener on 0.0.0.0 for container compatibility (Render/Docker)
const server = app.listen(PORT, HOST, () => {
  logger.info({
    port: PORT,
    host: HOST,
    mode: process.env.CARRIER_TRACKING_MOCK === 'true' ? 'MOCKING' : 'LIVE',
    env: process.env.NODE_ENV || 'development'
  }, `SecureKaro Escrow Backend Server listening on ${HOST}:${PORT}`);
});

// Connect to MongoDB Atlas
connectDB().then(() => {
  initTrackingJob();
  initReturnWindowCron();
}).catch(err => {
  logger.warn({ error: err.message }, 'Database initialization warning');
});

// Graceful shutdown handling for container deployments (Render/K8s/Docker)
let isShuttingDown = false;
const gracefulShutdown = (signal, exitCode = 0) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info({ signal, exitCode }, `Received ${signal}. Shutting down gracefully...`);
  server.close(() => {
    logger.info('HTTP server closed cleanly.');
    process.exit(exitCode);
  });

  // Force shutdown after 10s if connections fail to close
  setTimeout(() => {
    logger.error('Forcing shutdown after 10s timeout.');
    process.exit(exitCode || 1);
  }, 10000).unref();
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM', 0));
process.on('SIGINT', () => gracefulShutdown('SIGINT', 0));

// Catch unhandled Promise rejections (e.g. unawaited network requests / database timeouts)
process.on('unhandledRejection', (reason, promise) => {
  logger.fatal({ reason: String(reason) }, 'Unhandled Promise Rejection detected');
  gracefulShutdown('unhandledRejection', 1);
});

// Catch synchronous exceptions not caught in try/catch
process.on('uncaughtException', (err) => {
  logger.fatal({ error: err.message, stack: err.stack }, 'Uncaught Exception thrown');
  gracefulShutdown('uncaughtException', 1);
});

