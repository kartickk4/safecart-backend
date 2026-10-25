const mongoose = require('mongoose');

const MilestoneSchema = new mongoose.Schema({
  status: { type: String, required: true },
  location: { type: String, required: true },
  detail: { type: String, required: true },
  time: { type: Date, default: Date.now }
});

const CarrierJourneySchema = new mongoose.Schema({
  shipmentId: { 
    type: String, 
    required: true, 
    unique: true,
    uppercase: true,
    trim: true
  }, // Matches Shipment.shipmentId
  courierName: { 
    type: String, 
    default: "Carrier Partner" 
  },
  awbCode: { 
    type: String, 
    required: true,
    trim: true
  },
  milestones: [MilestoneSchema],
  updatedAt: { 
    type: Date, 
    default: Date.now 
  }
});

CarrierJourneySchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

// SPARSE — AWB code lookup for tracking poll and webhook updates.
// Covers: CarrierJourney.findOne({ awbCode })
// Covers: CarrierJourney.findOne({ $or: [{ awbCode }, { shipmentId }] })
// Sparse: skips documents where awbCode is empty/null.
CarrierJourneySchema.index({ awbCode: 1 }, { sparse: true });

module.exports = mongoose.model('CarrierJourney', CarrierJourneySchema);
