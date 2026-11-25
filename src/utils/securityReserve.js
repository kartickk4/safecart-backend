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

const RESERVE_PER_SHIPMENT = 0;
const MAX_RESERVE_CAP = 0;

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
 * Standard Negative Balance Model:
 * No artificial wallet lock or holding limit. Security reserve buffer is 0.
 * In line with industry standards (Shiprocket, NimbusPost), sellers have full access to their wallet.
 * Negative balance is permitted for RTO / adjustments and automatically recovered from future remittances.
 * @returns {number}
 */
const calculateSecurityReserve = () => {
  return 0;
};

module.exports = {
  ACTIVE_SHIPMENT_STATUSES,
  RESERVE_PER_SHIPMENT,
  MAX_RESERVE_CAP,
  getActiveShipmentsCount,
  calculateSecurityReserve
};

