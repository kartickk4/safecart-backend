const mongoose = require('mongoose');

const ShipmentSchema = new mongoose.Schema({
  shipmentId: { 
    type: String, 
    required: true, 
    unique: true,
    uppercase: true,
    trim: true
  }, // Format: SPL-XXXX-X
  senderId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true 
  },
  receiverName: { 
    type: String, 
    required: true,
    trim: true
  },
  receiverPhone: { 
    type: String, 
    required: true,
    trim: true
  },
  description: { 
    type: String, 
    required: true 
  },
  amount: { 
    type: Number, 
    required: true 
  }, // In INR (₹)
  city: { 
    type: String, 
    default: "" 
  }, // Route description (e.g., "Mumbai -> Delhi")
  
  // Logistics Integration Fields (TrackCourier)
  carrierSlug: { 
    type: String, 
    default: "" 
  },
  awbCode: { 
    type: String, 
    default: "" 
  },
  shippingLabelUrl: { 
    type: String, 
    default: "" 
  },

  // Reverse Logistics & Return Integration Fields
  returnStatus: {
    type: String,
    enum: ['None', 'Requested', 'Approved', 'In Return Transit', 'Returned & Refunded', 'Rejected'],
    default: 'None'
  },
  returnAwbCode: {
    type: String,
    default: ""
  },
  returnCarrierSlug: {
    type: String,
    default: ""
  },
  returnReason: {
    type: String,
    default: ""
  },
  returnShippingLabelUrl: {
    type: String,
    default: ""
  },

  status: { 
    type: String, 
    enum: [
      'Awaiting Payment', 
      'Pending Pickup', 
      'In Transit', 
      'Reached Destination Hub', 
      'Out for Delivery', 
      'Delivered', 
      'Released', 
      'Locked',
      'Cancelled',
      'Undelivered',
      'Return Requested',
      'Return In Transit',
      'Returned & Refunded'
    ], 
    default: 'Awaiting Payment' 
  },
  escrowStage: { 
    type: Number, 
    enum: [1, 2, 3, 4, 5, 6, -1, -2, -3, -4, -5], 
    default: 1 
  }, 
  createdAt: { 
    type: Date, 
    default: Date.now 
  },
  updatedAt: { 
    type: Date, 
    default: Date.now 
  }
});

// Update timestamps before saving
ShipmentSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('Shipment', ShipmentSchema);
