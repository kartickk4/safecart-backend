const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    const connStr = process.env.MONGODB_URI;
    if (!connStr) {
      console.warn('⚠️ WARNING: MONGODB_URI is not set in environment variables. Database operations will fail until MONGODB_URI is provided.');
      return;
    }
    const conn = await mongoose.connect(connStr, {
      serverSelectionTimeoutMS: 5000,
    });
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);

    // Clean up legacy empty string phone entries to prevent E11000 duplicate key errors
    try {
      const User = require('../models/User');
      await User.updateMany({ phone: "" }, { $unset: { phone: 1 } });
    } catch (e) {
      console.warn('Phone index cleanup note:', e.message);
    }
  } catch (error) {
    console.error(`❌ MongoDB Connection Error: ${error.message}`);
    // Do not crash the entire process so health checks can still respond
  }
};

module.exports = connectDB;
