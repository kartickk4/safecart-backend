const mongoose = require('mongoose');

let isConnecting = false;
let reconnectTimer = null;

const scheduleReconnect = (delayMs = 5000) => {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    console.log('🔄 Retrying MongoDB connection...');
    connectDB();
  }, delayMs);
};

const connectDB = async () => {
  // If already connected, nothing to do
  if (mongoose.connection.readyState === 1) {
    return;
  }
  if (isConnecting) {
    return;
  }
  isConnecting = true;

  try {
    const connStr = process.env.MONGODB_URI;
    if (!connStr) {
      console.warn('⚠️ WARNING: MONGODB_URI is not set in environment variables. Database operations will fail until MONGODB_URI is provided.');
      isConnecting = false;
      return;
    }

    const conn = await mongoose.connect(connStr, {
      serverSelectionTimeoutMS: 10000,
      heartbeatFrequencyMS: 10000,
      maxPoolSize: 10,
      minPoolSize: 2,
      socketTimeoutMS: 45000,
    });
    isConnecting = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);

    // Execute automated database migration, index creation, and data backfills
    try {
      const { runDatabaseMigrations } = require('../utils/dbMigration');
      const indexes = await conn.connection.db.collection('users').indexes();
      if (indexes.some(idx => idx.name === 'email_1')) {
        await conn.connection.db.collection('users').dropIndex('email_1');
        console.log('✅ Legacy email_1 index dropped.');
      }
      await runDatabaseMigrations(conn.connection.db);
    } catch (e) {
      console.warn('Database migration note:', e.message);
    }
  } catch (error) {
    isConnecting = false;
    console.error(`❌ MongoDB Connection Error: ${error.message}`);
    // Auto-retry connection after 5 seconds instead of remaining disconnected
    scheduleReconnect(5000);
  }
};

// Listen to connection lifecycle events for self-healing
mongoose.connection.on('disconnected', () => {
  console.warn('⚠️ MongoDB connection lost! Scheduling auto-reconnect in 3s...');
  scheduleReconnect(3000);
});

mongoose.connection.on('error', (err) => {
  console.error(`❌ MongoDB connection error: ${err.message}`);
});

module.exports = connectDB;

