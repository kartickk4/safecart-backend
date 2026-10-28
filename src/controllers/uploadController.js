const { uploadBufferToR2, uploadBase64ToR2 } = require('../services/r2Service');

/**
 * @desc    Upload file or image directly to Cloudflare R2
 * @route   POST /api/v1/upload
 * @access  Private
 */
const handleFileUpload = async (req, res) => {
  try {
    const folder = req.body.folder || req.query.folder || 'parcels';

    // 1. Multipart file upload via Multer
    if (req.file) {
      const allowedMimes = [
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/heic',
        'application/pdf'
      ];

      if (!allowedMimes.includes(req.file.mimetype)) {
        return res.status(400).json({
          error: 'Unsupported file format. Please upload JPG, PNG, WEBP, or PDF.'
        });
      }

      const result = await uploadBufferToR2(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype,
        folder
      );

      return res.status(200).json({
        success: true,
        message: 'File uploaded successfully to Cloudflare R2',
        url: result.url,
        key: result.key,
        size: result.size
      });
    }

    // 2. Base64 payload upload (e.g. captured camera frames or canvas data URIs)
    if (req.body && req.body.dataUri) {
      const result = await uploadBase64ToR2(req.body.dataUri, folder);
      return res.status(200).json({
        success: true,
        message: 'Image uploaded successfully to Cloudflare R2',
        url: result.url,
        key: result.key,
        size: result.size
      });
    }

    return res.status(400).json({
      error: 'No file or image data provided. Please attach a file or dataUri.'
    });
  } catch (error) {
    console.error('[R2 UPLOAD ERROR]:', error);
    return res.status(500).json({
      error: error.message || 'Failed to upload file to Cloudflare R2'
    });
  }
};

/**
 * @desc    Stream or serve a file stored in Cloudflare R2
 * @route   GET /api/v1/upload/file/*
 * @access  Public
 */
const handleFileServe = async (req, res) => {
  try {
    const rawKey = req.params[0] || req.params.key;
    if (!rawKey) {
      return res.status(400).json({ error: 'File key is required.' });
    }

    // Sanitize path traversal attempts
    const safeKey = rawKey.replace(/\.\./g, '').replace(/^\/+/, '');
    const { getObjectFromR2 } = require('../services/r2Service');

    const s3Object = await getObjectFromR2(safeKey);

    if (!s3Object || !s3Object.Body) {
      return res.status(404).json({ error: 'File not found.' });
    }

    res.set({
      'Content-Type': s3Object.ContentType || 'application/octet-stream',
      'Content-Length': s3Object.ContentLength,
      'ETag': s3Object.ETag,
      'Cache-Control': 'public, max-age=31536000, immutable'
    });

    s3Object.Body.pipe(res);
  } catch (error) {
    if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
      return res.status(404).json({ error: 'File not found on Cloudflare R2.' });
    }
    console.error('[R2 FILE SERVE ERROR]:', error);
    return res.status(500).json({ error: 'Unable to retrieve file.' });
  }
};

module.exports = {
  handleFileUpload,
  handleFileServe
};

