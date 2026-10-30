const { uploadBufferToR2, uploadBase64ToR2 } = require('../services/r2Service');
const { validateFileBuffer, validateBase64Payload } = require('../middleware/fileSecurity');

/**
 * @desc    Upload file or image directly to Cloudflare R2 with strict security checks
 * @route   POST /api/v1/upload
 * @access  Private
 */
const handleFileUpload = async (req, res) => {
  try {
    const rawFolder = req.body.folder || req.query.folder || 'parcels';
    // Sanitize folder path: allow only safe alphanumeric names, no slashes or dots
    const folder = rawFolder.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 30) || 'parcels';

    // 1. Multipart file upload via Multer
    if (req.file) {
      // Deep validation: extension, double-extension, MIME type, and magic bytes
      const validation = validateFileBuffer(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype
      );

      if (!validation.valid) {
        return res.status(400).json({
          error: validation.error || 'File validation failed security check.'
        });
      }

      const result = await uploadBufferToR2(
        req.file.buffer,
        req.file.originalname,
        validation.detectedMime || req.file.mimetype,
        folder
      );

      return res.status(200).json({
        success: true,
        message: 'File verified and uploaded successfully to Cloudflare R2',
        url: result.url,
        key: result.key,
        size: result.size,
        mime: result.mimetype
      });
    }

    // 2. Base64 payload upload (e.g. captured camera frames or canvas data URIs)
    if (req.body && req.body.dataUri) {
      const base64Validation = validateBase64Payload(req.body.dataUri);
      if (!base64Validation.valid) {
        return res.status(400).json({
          error: base64Validation.error || 'Base64 image validation failed security check.'
        });
      }

      const result = await uploadBase64ToR2(req.body.dataUri, folder);
      return res.status(200).json({
        success: true,
        message: 'Image verified and uploaded successfully to Cloudflare R2',
        url: result.url,
        key: result.key,
        size: result.size,
        mime: result.mimetype
      });
    }

    return res.status(400).json({
      error: 'No file or image data provided. Please attach a valid file or dataUri.'
    });
  } catch (error) {
    console.error('[R2 UPLOAD ERROR]:', error);
    return res.status(500).json({
      error: error.message || 'Failed to upload file to Cloudflare R2'
    });
  }
};

/**
 * @desc    Stream or serve a file stored in Cloudflare R2 with hardened headers
 * @route   GET /api/v1/upload/file/*
 * @access  Public
 */
const handleFileServe = async (req, res) => {
  try {
    const rawKey = req.params[0] || req.params.key;
    if (!rawKey) {
      return res.status(400).json({ error: 'File key is required.' });
    }

    // Strict path traversal defense: strip any relative traversal markers or null bytes
    const safeKey = rawKey
      .replace(/[\0\x00-\x1F\x7F]/g, '')
      .replace(/\.\./g, '')
      .replace(/^\/+/, '');

    const { getObjectFromR2 } = require('../services/r2Service');
    const s3Object = await getObjectFromR2(safeKey);

    if (!s3Object || !s3Object.Body) {
      return res.status(404).json({ error: 'File not found.' });
    }

    // Defensive Security Headers:
    // - X-Content-Type-Options: nosniff prevents browser from interpreting images as executable script
    // - Content-Security-Policy: sandbox restricts any script execution in browser context
    // - X-Frame-Options: DENY prevents clickjacking / embedding inside foreign iframes
    res.set({
      'Content-Type': s3Object.ContentType || 'application/octet-stream',
      'Content-Length': s3Object.ContentLength,
      'ETag': s3Object.ETag,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; sandbox;"
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
