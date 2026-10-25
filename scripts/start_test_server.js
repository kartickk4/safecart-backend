/**
 * Dedicated Sandbox Server for Safe Load Testing
 * Forces mock carrier tracking, test rate limit bypass, and expanded db pool
 */
process.env.NODE_ENV = 'test';
process.env.LOAD_TEST_MODE = 'true';
process.env.CARRIER_TRACKING_MOCK = 'true';
process.env.PORT = '5001';
process.env.DB_MAX_POOL_SIZE = '100';
process.env.DB_MIN_POOL_SIZE = '5';
process.env.ENABLE_TRACKING_CRON = 'false'; // Don't run periodic background cron during load tests

require('dotenv').config();
const http = require('http');
const app = require('../src/app');
const connectDB = require('../src/config/db');

const PORT = process.env.PORT || 5001;
const server = http.createServer(app);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`========================================================`);
  console.log(`  SAFE LOAD TEST SANDBOX SERVER RUNNING on http://127.0.0.1:${PORT}`);
  console.log(`  Mode: CARRIER_TRACKING_MOCK=true | LOAD_TEST_MODE=true`);
  console.log(`  Database Pool: maxPoolSize=100, minPoolSize=5`);
  console.log(`========================================================`);
});

// Connect to MongoDB Atlas
connectDB().catch(err => {
  console.warn('Note: DB connection notice (in-memory caching remains operational):', err.message);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
