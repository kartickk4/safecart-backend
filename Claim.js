const mongoose = require('mongoose');

const ClaimSchema = new mongoose.Schema({
  claimId: { 
    type: String, 
    required: true, 
    unique: true,
    uppercase: true,
    trim: true
  }, // Format: CLM-XXXX-X
  shipmentId: { 
    type: String, 
    required: true,
    uppercase: true,
    trim: true
  }, // References Shipment.shipmentId
  filedBy: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true 
  },
  role: { 
    type: String, 
    enum: ['supplier', 'receiver'], 
    required: true 
  },
  reason: { 
    type: String, 
    required: true 
  },
  description: { 
    type: String, 
    required: true 
  },
  evidenceUrls: [{ 
    type: String 
  }], // Photo or video links from claims
  status: { 
    type: String, 
    enum: ['Under Review', 'Approved', 'Rejected'], 
    default: 'Under Review' 
  },
  arbitratorNotes: { 
    type: String, 
    default: "" 
  },
  createdAt: { 
    type: Date, 
    default: Date.now 
  }
});

module.exports = mongoose.model('Claim', ClaimSchema);
