const Shipment = require('../models/Shipment');
const { deleteFromR2 } = require('./r2Service');

/**
 * Extract Cloudflare R2 object key from public URL or relative path
 * Examples:
 * - "https://media.securekaro.in/parcels/173000-photo.jpg" -> "parcels/173000-photo.jpg"
 * - "/api/v1/upload/file/parcels/173000-photo.jpg" -> "parcels/173000-photo.jpg"
 * - "parcels/173000-photo.jpg" -> "parcels/173000-photo.jpg"
 */
const extractR2KeyFromUrl = (url) => {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  // Don't process Base64 strings or placeholders
  if (trimmed.startsWith('data:') || trimmed.startsWith('DELETED_')) return null;

  const match = trimmed.match(/(parcels|defects|labels|proofs)\/[a-zA-Z0-9_\-\.]+/);
  return match ? match[0] : null;
};

/**
 * Automatically delete user uploaded photos for shipments where:
 * 1. Delivery is completed (or released/cancelled)
 * 2. Return window is 100% closed (no active returns or open dispute claims)
 * 3. Retention buffer (default: 7 days) has passed since delivery
 * 
 * @param {number} retentionDays - Number of days to retain photos after completion (default: 7)
 * @returns {Promise<Object>}
 */
const cleanupCompletedShipmentPhotos = async (retentionDays = 7) => {
  const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  console.log(`[R2 MEDIA CLEANUP] Starting auto-cleanup of completed parcel photos older than ${retentionDays} days (cutoff: ${cutoffDate.toISOString()})...`);

  const query = {
    parcelPhotoCleanedUp: { $ne: true },
    hasActiveClaim: { $ne: true }, // SAFETY GUARD: Never delete photos if there is an active dispute claim!
    $or: [
      {
        // Completed/Delivered orders whose 24-48h return window is closed
        status: { $in: ['Delivered', 'Released', 'Returned & Refunded'] },
        returnWindowClosed: true,
        $or: [
          { deliveredAt: { $lte: cutoffDate } },
          { deliveryConfirmedAt: { $lte: cutoffDate } },
          { updatedAt: { $lte: cutoffDate } }
        ]
      },
      {
        // Cancelled or permanently undelivered orders
        status: { $in: ['Cancelled', 'Undelivered'] },
        updatedAt: { $lte: cutoffDate }
      }
    ]
  };

  const eligibleShipments = await Shipment.find(query).limit(500);

  let deletedPhotosCount = 0;
  let shipmentsCleanedCount = 0;
  let failedDeletionsCount = 0;

  for (const s of eligibleShipments) {
    const urlsToDelete = [
      s.parcelPhotoUrl,
      s.packingScalePhotoUrl,
      s.defectPhotoUrl
    ].filter(Boolean);

    let hadDeletions = false;

    for (const url of urlsToDelete) {
      const key = extractR2KeyFromUrl(url);
      if (key) {
        try {
          await deleteFromR2(key);
          deletedPhotosCount++;
          hadDeletions = true;
          console.log(`[R2 MEDIA CLEANUP] Deleted key "${key}" from Cloudflare R2 for shipment #${s.shipmentId}`);
        } catch (delErr) {
          failedDeletionsCount++;
          console.warn(`[R2 MEDIA CLEANUP] Notice on deleting key "${key}":`, delErr.message);
        }
      }
    }

    // Mark shipment as cleaned up in database so it is never re-scanned
    s.parcelPhotoCleanedUp = true;
    s.parcelPhotoCleanedUpAt = new Date();
    if (s.parcelPhotoUrl && extractR2KeyFromUrl(s.parcelPhotoUrl)) {
      s.parcelPhotoUrl = 'DELETED_STORAGE_RETENTION';
    }
    if (s.packingScalePhotoUrl && extractR2KeyFromUrl(s.packingScalePhotoUrl)) {
      s.packingScalePhotoUrl = 'DELETED_STORAGE_RETENTION';
    }
    await s.save();
    shipmentsCleanedCount++;
  }

  // Assuming average photo size of ~350 KB
  const estimatedStorageSavedMb = parseFloat(((deletedPhotosCount * 350) / 1024).toFixed(2));

  const summary = {
    timestamp: new Date().toISOString(),
    retentionDays,
    eligibleShipmentsFound: eligibleShipments.length,
    shipmentsCleanedCount,
    deletedPhotosCount,
    failedDeletionsCount,
    estimatedStorageSavedMb,
    message: `Cleaned up ${deletedPhotosCount} photo(s) across ${shipmentsCleanedCount} completed shipment(s), saving ~${estimatedStorageSavedMb} MB of Cloudflare R2 storage.`
  };

  console.log(`[R2 MEDIA CLEANUP COMPLETE] ${summary.message}`);
  return summary;
};

module.exports = {
  extractR2KeyFromUrl,
  cleanupCompletedShipmentPhotos
};

