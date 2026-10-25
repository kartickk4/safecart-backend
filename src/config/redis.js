const Redis = require('ioredis');
const logger = require('../utils/logger');

const rawRedisUrl = process.env.REDIS_URL || '';
const cleanRedisUrl = rawRedisUrl.replace(/^["']|["']$/g, '').trim();

let redisClient = null;
let isConnected = false;

if (cleanRedisUrl) {
  try {
    redisClient = new Redis(cleanRedisUrl, {
      maxRetriesPerRequest: 3,
      connectTimeout: 10000,
      enableReadyCheck: true,
      retryStrategy(times) {
        const delay = Math.min(times * 100, 3000);
        return delay;
      }
    });

    redisClient.on('connect', () => {
      isConnected = true;
      logger.info('Central Redis Store connected successfully.');
    });

    redisClient.on('ready', () => {
      isConnected = true;
    });

    redisClient.on('error', (err) => {
      isConnected = false;
      logger.warn({ error: err.message }, 'Central Redis connection warning (falling back gracefully)');
    });

    redisClient.on('close', () => {
      isConnected = false;
    });
  } catch (err) {
    logger.warn({ error: err.message }, 'Failed to initialize Redis client');
  }
} else {
  logger.info('REDIS_URL not configured. Running with in-memory session tracking.');
}

/**
 * Session tracking: Store active session version or payload
 */
const setSession = async (key, value, ttlSeconds = 7 * 24 * 3600) => {
  if (redisClient && isConnected) {
    try {
      const data = typeof value === 'object' ? JSON.stringify(value) : String(value);
      await redisClient.set(key, data, 'EX', ttlSeconds);
      return true;
    } catch (e) {
      logger.warn({ key, error: e.message }, 'Redis setSession warning');
    }
  }
  return false;
};

/**
 * Retrieve session data by key
 */
const getSession = async (key) => {
  if (redisClient && isConnected) {
    try {
      const val = await redisClient.get(key);
      if (!val) return null;
      try {
        return JSON.parse(val);
      } catch {
        return val;
      }
    } catch (e) {
      logger.warn({ key, error: e.message }, 'Redis getSession warning');
    }
  }
  return null;
};

/**
 * Invalidate / revoke session immediately (Logout / Password Change)
 */
const revokeSession = async (key) => {
  if (redisClient && isConnected) {
    try {
      await redisClient.del(key);
      return true;
    } catch (e) {
      logger.warn({ key, error: e.message }, 'Redis revokeSession warning');
    }
  }
  return false;
};

module.exports = {
  redisClient,
  isConnected: () => isConnected,
  setSession,
  getSession,
  revokeSession
};
