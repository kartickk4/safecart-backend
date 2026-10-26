const logger = require('../utils/logger');

const errorHandler = (err, req, res, next) => {
  const isProd = process.env.NODE_ENV === 'production';
  const statusCode = res.statusCode === 200 ? 500 : res.statusCode;

  // Structured error logging with request ID correlation
  logger.error({
    requestId: req.id,
    method: req.method,
    path: req.path,
    statusCode,
    error: err.message,
    stack: isProd ? undefined : err.stack
  }, `Request error on ${req.method} ${req.path}`);

  let errorMessage = isProd
    ? (err.isOperational ? err.message : 'An internal error occurred.')
    : (err.message || 'Internal Server Error');

  // Detect CORS security policy rejections
  if (err.message && err.message.includes('CORS')) {
    return res.status(403).json({
      error: 'Access blocked by CORS policy',
      requestId: req.id
    });
  }

  // Detect Mongoose buffering timeout / connection drop
  if (err.message && err.message.includes('buffering timed out')) {
    errorMessage = 'Database is currently reconnecting. Please retry in a few seconds.';
  }

  res.status(statusCode).json({
    error: errorMessage,
    requestId: req.id,
    // SECURITY: Never expose stack trace in production
    ...(isProd ? {} : { stack: err.stack })
  });
};

module.exports = { errorHandler };