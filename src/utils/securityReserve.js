const Shipment = require('../models/Shipment');

const ACTIVE_SHIPMENT_STATUSES = [
  'Awaiting Payment',
  'Pending Pickup',
  'Picked Up',
  'Dispatched',
  'In Transit',
  'Reached Destination Hub',
  'Out for Delivery',
  'Return Requested',
  'Return In Transit',
  'Replacement In Transit'
];

const RESERVE_PER_SHIPMENT = 100;
const MAX_RESERVE_CAP = 1000;

/**
 * Get count of active shipments for a sender
 * @param {string|Object} userId
 * @returns {Promise<number>}
 */
const getActiveShipmentsCount = async (userId) => {
  if (!userId) return 0;
  return await Shipment.countDocuments({
    senderId: userId,
    status: { $in: ACTIVE_SHIPMENT_STATUSES }
  });
};

/**
 * Calculate dynamic reserve required for a given number of active shipments
 * Rule: 1 shipment -> ₹100, 4 -> ₹400, max holding limit ₹1,000
 * @param {number} activeCount
 * @returns {number}
 */
const calculateSecurityReserve = (activeCount) => {
  const count = Math.max(0, parseInt(activeCount, 10) || 0);
  return Math.min(MAX_RESERVE_CAP, count * RESERVE_PER_SHIPMENT);
};

module.exports = {
  ACTIVE_SHIPMENT_STATUSES,
  RESERVE_PER_SHIPMENT,
  MAX_RESERVE_CAP,
  getActiveShipmentsCount,
  calculateSecurityReserve
};

