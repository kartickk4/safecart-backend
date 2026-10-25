const pino = require('pino');

const isProd = process.env.NODE_ENV === 'production';

// Configure Pino with pretty formatting for local dev and fast JSON for production
const logger = pino({
  level: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label.toUpperCase() })
  },
  redact: {
    paths: [
      'req.headers.authorization',
      'password',
      'passwordHash',
      'newPassword',
      'token',
      'secret',
      'creditCard',
      'cvv'
    ],
    censor: '[REDACTED]'
  },
  transport: isProd
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
          ignore: 'pid,hostname'
        }
      }
});

module.exports = logger;
