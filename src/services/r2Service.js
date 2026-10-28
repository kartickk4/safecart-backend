const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');
const path = require('path');

const R2_ACCOUNT_ID = process.env.CLOUDFLARE_R2_ACCOUNT_ID || '07f17b1d03d298ffdb300c3509e37497';
const R2_ACCESS_KEY_ID = process.env.CLOUDFLARE_R2_ACCESS_KEY_ID || '657d0792ab51c1c02427ec154fb329be';
const R2_SECRET_ACCESS_KEY = process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY || 'd1ad7f16d2035276ebd16f0abf401e73dc5a8f2de0e03d5e4af3e6efe24a7053';
const R2_BUCKET_NAME = process.env.CLOUDFLARE_R2_BUCKET_NAME || 'securekaro-proofs';
const R2_PUBLIC_URL = process.env.CLOUDFLARE_R2_PUBLIC_URL || '';

// Initialize AWS S3 Client targeting Cloudflare R2
const r2Client = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY
  }
});

/**
 * Upload a binary buffer to Cloudflare R2
 * @param {Buffer} buffer - File buffer
 * @param {string} originalname - Original file name
 * @param {string} mimetype - Content-Type / MIME type
 * @param {string} folder - Destination folder (parcels, defects, labels)
 * @returns {Promise<{ key: string, url: string, size: number }>}
 */
const uploadBufferToR2 = async (buffer, originalname = 'upload.jpg', mimetype = 'image/jpeg', folder = 'parcels') => {
  const ext = path.extname(originalname) || (mimetype.includes('png') ? '.png' : mimetype.includes('webp') ? '.webp' : mimetype.includes('pdf') ? '.pdf' : '.jpg');
  const safeBase = path.basename(originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 30) || 'file';
  const uniqueKey = `${folder}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${safeBase}${ext}`;

  const command = new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: uniqueKey,
    Body: buffer,
    ContentType: mimetype,
    ContentLength: buffer.length
  });

  await r2Client.send(command);

  // Determine public URL
  let publicUrl;
  if (R2_PUBLIC_URL && R2_PUBLIC_URL.trim()) {
    const base = R2_PUBLIC_URL.replace(/\/+$/, '');
    publicUrl = `${base}/${uniqueKey}`;
  } else {
    // Standard R2 public dev bucket URL format
    publicUrl = `https://${R2_BUCKET_NAME}.${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${uniqueKey}`;
  }

  return {
    key: uniqueKey,
    url: publicUrl,
    size: buffer.length,
    mimetype
  };
};

/**
 * Convert Base64 Data URI to Buffer and upload to Cloudflare R2
 * @param {string} dataUri - e.g. "data:image/jpeg;base64,..."
 * @param {string} folder - Destination folder
 * @returns {Promise<{ key: string, url: string }>}
 */
const uploadBase64ToR2 = async (dataUri, folder = 'parcels') => {
  if (!dataUri || !dataUri.startsWith('data:')) {
    throw new Error('Invalid Base64 Data URI format');
  }

  const matches = dataUri.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
  if (!matches || matches.length !== 3) {
    throw new Error('Malformed Base64 image string');
  }

  const mimetype = matches[1];
  const buffer = Buffer.from(matches[2], 'base64');
  return uploadBufferToR2(buffer, `photo.${mimetype.split('/')[1] || 'jpg'}`, mimetype, folder);
};

/**
 * Delete an object from Cloudflare R2 by key
 * @param {string} key 
 */
const deleteFromR2 = async (key) => {
  if (!key) return;
  const command = new DeleteObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key
  });
  return r2Client.send(command);
};

module.exports = {
  r2Client,
  uploadBufferToR2,
  uploadBase64ToR2,
  deleteFromR2,
  R2_BUCKET_NAME,
  R2_ACCOUNT_ID
};
