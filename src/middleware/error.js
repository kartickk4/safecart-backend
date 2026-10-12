const errorHandler = (err, req, res, next) => {
  // SECURITY: Never log full error stacks in production — they reveal internal paths and logic
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    console.error(`[ERROR] ${req.method} ${req.path}:`, err.stack);
  } else {
    // In production, log minimal info (no stack trace)
    console.error(`[ERROR] ${req.method} ${req.path}: ${err.message}`);
  }

  const statusCode = res.statusCode === 200 ? 500 : res.statusCode;

  let errorMessage = isProd
    ? (err.isOperational ? err.message : 'An internal error occurred.')
    : (err.message || 'Internal Server Error');

  // Detect Mongoose buffering timeout / connection drop
  if (err.message && err.message.includes('buffering timed out')) {
    errorMessage = 'Database is currently reconnecting. Please retry in a few seconds.';
  }

  res.status(statusCode).json({
    error: errorMessage,
    // SECURITY: Never expose stack trace in production
    ...(isProd ? {} : { stack: err.stack })
  });
};

module.exports = { errorHandler };