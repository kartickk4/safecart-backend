require('dotenv').config();
const app = require('./app');
const connectDB = require('./config/db');
const { initTrackingJob } = require('./jobs/trackingPoll');

const PORT = process.env.PORT || 5000;

// Start Express listener immediately
const server = app.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(` Safecart Secure Backend Server Running on Port ${PORT}`);
  console.log(` Mode: ${process.env.CARRIER_TRACKING_MOCK === 'true' ? 'CARRIER TRACKING MOCKING ACTIVE' : 'CARRIER TRACKING LIVE (TRACKCOURIER.IO)'}`);
  console.log(` Local URL: http://localhost:${PORT}`);
  console.log(`==================================================`);
});

// Connect to MongoDB Atlas in the background
connectDB().then(() => {
  // Start background tracking polling job
  initTrackingJob();
}).catch(err => {
  console.error('Database connection failed on startup. The server is still running on localhost.');
});
