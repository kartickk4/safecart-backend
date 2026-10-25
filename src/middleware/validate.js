const { z } = require('zod');

/**
 * Higher-order middleware to validate incoming request data using Zod schema
 * @param {z.ZodSchema} schema - Zod schema to validate against
 * @param {'body' | 'query' | 'params'} source - Request property to validate (default: 'body')
 */
const validate = (schema, source = 'body') => {
  return (req, res, next) => {
    try {
      const parsed = schema.parse(req[source]);
      req[source] = parsed;
      next();
    } catch (err) {
      if (err instanceof z.ZodError) {
        const issues = err.issues.map(issue => ({
          field: issue.path.join('.'),
          message: issue.message
        }));
        return res.status(400).json({
          error: 'Validation failed',
          details: issues,
          requestId: req.id
        });
      }
      next(err);
    }
  };
};

module.exports = { validate, z };
