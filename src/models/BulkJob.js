const mongoose = require('mongoose');

/**
 * BulkJob — tracks the status of bulk Excel shipment booking jobs.
 * Extended schema to support the rich per-row fields from the v2 template.
 */
const BulkJobSchema = new mongoose.Schema({
  jobId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },

  status: {
    type: String,
    enum: ['analyzing', 'awaiting_confirmation', 'processing', 'completed', 'failed'],
    default: 'analyzing'
  },

  // Row analysis results (before user confirms)
  totalRows:      { type: Number, default: 0 },
  validRows:      { type: Number, default: 0 },
  invalidRows:    { type: Number, default: 0 },

  // Processing results (after user confirms)
  processedRows:  { type: Number, default: 0 },
  successCount:   { type: Number, default: 0 },
  failCount:      { type: Number, default: 0 },

  // Parsed row data stored for confirmation step (v2 rich schema)
  parsedRows: [{
    rowNumber:         Number,

    // Receiver info
    receiverName:      String,
    receiverPhone:     String,
    receiverEmail:     { type: String, default: '' },
    receiverAddress:   String,
    receiverCity:      { type: String, default: '' },
    receiverState:     { type: String, default: '' },
    pincode:           String,

    // Parcel details
    description:       String,
    category:          { type: String, default: 'General' },   // Electronics, Clothing, etc.
    weightKg:          Number,
    heightCm:          { type: Number, default: 15 },
    widthCm:           { type: Number, default: 15 },
    lengthCm:          { type: Number, default: 15 },
    quantity:          { type: Number, default: 1 },

    // Financial
    amount:            Number,
    paymentMode:       { type: String, default: 'prepaid' },   // prepaid | cod
    codAmount:         { type: Number, default: 0 },
    insuranceRequired: { type: Boolean, default: false },

    // Seller preferences
    returnAllowed:     { type: Boolean, default: true },
    preferredCarrier:  { type: String, default: 'auto' },      // auto | delhivery | bluedart | etc.
    specialInstructions: { type: String, default: '' },

    // Seller reference
    sellerOrderId:     { type: String, default: '' },          // seller's own order/invoice no

    // Validation
    isValid:           Boolean,
    errors:            [String],

    // Post-booking (set after successful booking)
    shipmentId:        String,
    awbCode:           String,
    paymentLink:       String,
    carrierAssigned:   String,
    carrierPrice:      Number,
    bookingError:      String
  }],

  // Created shipment IDs for successfully booked rows
  createdShipmentIds: [String],

  originalFileName:  { type: String, default: '' },
  templateVersion:   { type: String, default: 'v2' },
  createdAt:         { type: Date, default: Date.now },
  completedAt:       { type: Date }
});

// Auto-delete bulk jobs after 7 days
BulkJobSchema.index({ createdAt: 1 }, { expireAfterSeconds: 604800 });

module.exports = mongoose.model('BulkJob', BulkJobSchema);
