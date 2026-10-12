const mongoose = require('mongoose');

/**
 * AgentSession — stores multi-turn AI agent conversation state.
 * Auto-expires after 24 hours via MongoDB TTL index.
 */
const AgentSessionSchema = new mongoose.Schema({
  sessionId: {
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

  // Current step in the conversation state machine
  // 0=greeting,1=name,2=phone,3=address,4=pincode,5=parcel,6=amount,7=mode,8=rto,9=return,10=carrier,11=confirm,12=done
  step: {
    type: Number,
    default: 0
  },

  // Tracks whether the user is currently editing a single field from confirmation
  isEditing: {
    type: Boolean,
    default: false
  },
  editingField: {
    type: String,
    default: ''
  },

  // All data collected from the user during the conversation
  collectedData: {
    receiverName:         { type: String, default: '' },
    receiverPhone:        { type: String, default: '' },
    receiverAddress:      { type: String, default: '' },
    receiverPincode:      { type: String, default: '' },
    senderAddress:        { type: String, default: '' },
    senderPincode:        { type: String, default: '' },
    description:          { type: String, default: '' },
    amount:               { type: Number, default: 0 },
    weightKg:             { type: Number, default: 0.5 },
    heightCm:             { type: Number, default: 15 },
    widthCm:              { type: Number, default: 15 },
    lengthCm:             { type: Number, default: 15 },
    returnAllowed:        { type: Boolean, default: true },
    rtoProtectionEnabled: { type: Boolean, default: false },
    paymentMode:          { type: String, default: 'prepaid' } // 'prepaid' | 'cod'
  },

  // Carrier quotes fetched for this session
  carrierQuotes: [{
    slug:    String,
    name:    String,
    price:   Number,
    eta:     String,
    isLowest: Boolean
  }],

  // Which carrier the user/system selected
  selectedCarrier: {
    slug:  { type: String, default: '' },
    name:  { type: String, default: '' },
    price: { type: Number, default: 0 },
    eta:   { type: String, default: '' }
  },

  // Message history for chat UI display
  messages: [{
    role:      { type: String, enum: ['agent', 'user'] },
    content:   String,
    timestamp: { type: Date, default: Date.now }
  }],

  // Resulting shipment ID after confirmation
  createdShipmentId: { type: String, default: '' },

  // Whether it's bulk mode (from Excel upload)
  isBulkSession: { type: Boolean, default: false },
  bulkJobId:     { type: String, default: '' },

  createdAt: { type: Date, default: Date.now }
}, {
  versionKey: false
});

// Auto-delete sessions after 24 hours
AgentSessionSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 });

module.exports = mongoose.model('AgentSession', AgentSessionSchema);
