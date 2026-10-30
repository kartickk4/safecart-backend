const express = require('express');
const multer = require('multer');
const { protect } = require('../middleware/auth');
const { handleFileUpload, handleFileServe } = require('../controllers/uploadController');
const { multerFileFilter, MAX_FILE_SIZE } = require('../middleware/fileSecurity');

const router = express.Router();

// Configure Multer for memory buffer storage with early rejection filter
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE // 15 MB
  },
  fileFilter: multerFileFilter
});

// Middleware to catch multer-specific validation errors cleanly as 400 Bad Request
const handleMulterErrors = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File size exceeds maximum allowed limit of 15MB.' });
    }
    return res.status(400).json({ error: `File upload error: ${err.message}` });
  } else if (err) {
    return res.status(400).json({ error: err.message || 'File upload rejected by security policy.' });
  }
  next();
};

// POST /api/v1/upload (protected upload)
router.post('/', protect, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) return handleMulterErrors(err, req, res, next);
    next();
  });
}, handleFileUpload);

// GET /api/v1/upload/file/* (public direct streaming of R2 assets)
router.get('/file/*', handleFileServe);

module.exports = router;
