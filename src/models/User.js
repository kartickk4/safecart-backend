const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  email: { 
    type: String, 
    required: true, 
    lowercase: true,
    trim: true
  },
  passwordHash: { 
    type: String, 
    required: true 
  },
  phone: { 
    type: String, 
    sparse: true,
    trim: true,
    set: v => (!v || (typeof v === 'string' && v.trim() === '') ? undefined : v)
  },
  fullName: { 
    type: String, 
    required: true,
    trim: true
  },
  avatarUrl: { 
    type: String, 
    default: "" 
  },
  googleId: {
    type: String,
    default: ""
  },
  address: { 
    type: String, 
    default: "" 
  },
  city: { 
    type: String, 
    default: "" 
  },
  state: { 
    type: String, 
    default: "" 
  },
  pincode: { 
    type: String, 
    default: "" 
  },
  pickupAddress: {
    street: { type: String, default: "" },
    city: { type: String, default: "" },
    state: { type: String, default: "" },
    pincode: { type: String, default: "" },
    landmark: { type: String, default: "" }
  },
  bankDetails: {
    accountHolderName: { type: String, default: "" },
    accountNumber: { type: String, default: "" },
    ifscCode: { type: String, default: "" },
    bankName: { type: String, default: "" },
    upiId: { type: String, default: "" }
  },
  cashfreeBeneficiaryId: {
    type: String,
    default: ""
  },
  walletBalance: {
    type: Number,
    default: 0
  },
  cashbackBalance: {
    type: Number,
    default: 0
  },
  totalEscrowInterestEarned: {
    type: Number,
    default: 0
  },
  totalCashbackEarned: {
    type: Number,
    default: 0
  },
  totalWithdrawn: {
    type: Number,
    default: 0
  },

  // ── Refer & Earn ─────────────────────────────────────────────────
  referralCode: {
    type: String,
    unique: true,
    sparse: true,
    uppercase: true,
    trim: true
    // Auto-generated on signup: SK-XXXXX (5 random alphanumeric chars)
  },
  referredBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
    // ID of the seller who referred this user
  },
  referralCredits: {
    type: Number,
    default: 0
    // ₹40 credited per referred seller's first delivered shipment
    // Can ONLY be used to discount a Pro plan purchase
  },
  totalReferralEarned: {
    type: Number,
    default: 0
    // Lifetime total referral credits earned
  },
  referralCreditUsed: {
    type: Number,
    default: 0
    // Total referral credits redeemed against Pro plan purchases
  },
  role: { 
    type: String, 
    enum: ['User', 'Supplier', 'Receiver', 'Admin', 'super_admin'], 
    default: 'Receiver' 
  },
  isAdmin: {
    type: Boolean,
    default: false
  },
  adminRole: {
    type: String,
    enum: ['super_admin', 'operations_admin', 'finance_admin', 'support_admin', null],
    default: null
  },
  isSuspended: {
    type: Boolean,
    default: false
  },
  suspendedReason: {
    type: String,
    default: ""
  },
  suspendedAt: {
    type: Date,
    default: null
  },
  platformType: {
    type: String,
    enum: ['independent', 'ecommerce', 'none', ''],
    default: 'independent'
  },
  isPro: {
    type: Boolean,
    default: false
  },
  proPlan: {
    type: String,
    enum: ['Standard', 'Pro'],
    default: 'Standard'
  },
  proUpgradedAt: {
    type: Date,
    default: null
  },
  isEmailVerified: {
    type: Boolean,
    default: false
  },
  isPhoneVerified: {
    type: Boolean,
    default: false
  },
  createdAt: { 
    type: Date, 
    default: Date.now 
  }
});

// Compound Unique Index: Allows same email ONLY if role is different (Option 3)
UserSchema.index({ email: 1, role: 1 }, { unique: true });

module.exports = mongoose.model('User', UserSchema);
