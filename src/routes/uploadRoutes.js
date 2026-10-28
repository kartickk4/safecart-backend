const express = require('express');
const multer = require('multer');
const { protect } = require('../middleware/auth');
const { handleFileUpload } = require('../controllers/uploadController');

const router = express.Router();

// Configure Multer for memory buffer storage (max 15MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024 // 15 MB
  }
});

// POST /api/v1/upload
router.post('/', protect, upload.single('file'), handleFileUpload);

module.exports = router;
