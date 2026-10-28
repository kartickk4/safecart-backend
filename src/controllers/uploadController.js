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

module.exports = {
  handleFileUpload
};
