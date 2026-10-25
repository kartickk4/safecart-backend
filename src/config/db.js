const mongoose = require('mongoose');

let isConnecting = false;
let reconnectTimer = null;
let hasMigrated = false;

const scheduleReconnect = (delayMs = 5000) => {
  if (reconnectTimer) return;
  // If mongoose is already connected or currently connecting, do not trigger another connect
  if (mongoose.connection.readyState === 1 || mongoose.connection.readyState === 2) {
    return;
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (mongoose.connection.readyState === 0) {
      console.log('🔄 Reconnecting to MongoDB Atlas...');
      connectDB();
    }
  }, delayMs);
};

const connectDB = async () => {
  // If already connected or connecting, do not call connect again
  if (mongoose.connection.readyState === 1 || mongoose.connection.readyState === 2) {
    return;
  }
  if (isConnecting) {
    return;
  }
  isConnecting = true;

  try {
    const connStr = process.env.MONGODB_URI;
    if (!connStr) {
      console.warn('⚠️ WARNING: MONGODB_URI is not set in environment variables.');
      isConnecting = false;
      return;
    }

    const maxPool = parseInt(process.env.DB_MAX_POOL_SIZE, 10) || 100;
    const minPool = parseInt(process.env.DB_MIN_POOL_SIZE, 10) || 5;

    const conn = await mongoose.connect(connStr, {
      serverSelectionTimeoutMS: 15000,
      heartbeatFrequencyMS: 10000,
      maxPoolSize: maxPool,
      minPoolSize: minPool,
      socketTimeoutMS: 45000,
    });
    isConnecting = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);

    // Execute automated database migration ONLY ONCE on server startup
    if (!hasMigrated) {
      hasMigrated = true;
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
    }
  } catch (error) {
    isConnecting = false;
    console.error(`❌ MongoDB Connection Error: ${error.message}`);
    scheduleReconnect(5000);
  }
};

// Listen to connection lifecycle events
mongoose.connection.on('disconnected', () => {
  // Mongoose 7 automatically retries replica set nodes; only intervene if permanently disconnected
  if (mongoose.connection.readyState === 0) {
    console.warn('⚠️ MongoDB disconnected. Attempting reconnect in 5s...');
    scheduleReconnect(5000);
  }
});

mongoose.connection.on('reconnected', () => {
  console.log('🔄 MongoDB reconnected successfully.');
});

mongoose.connection.on('error', (err) => {
  console.error(`❌ MongoDB connection error: ${err.message}`);
});

module.exports = connectDB;

