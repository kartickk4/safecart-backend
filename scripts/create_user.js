const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
require('dotenv').config({ path: 'C:/Users/Kartick/.gemini/antigravity-ide/scratch/safecart-backend/.env' });

const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  phone: { type: String, trim: true },
  fullName: { type: String, required: true, trim: true },
  role: { type: String, enum: ['Supplier', 'Receiver', 'Admin'], default: 'Receiver' },
  referralCode: { type: String, unique: true, uppercase: true, trim: true },
  walletBalance: { type: Number, default: 0 },
  cashbackBalance: { type: Number, default: 0 },
  isPhoneVerified: { type: Boolean, default: true },
  isEmailVerified: { type: Boolean, default: true }
}, { timestamps: true });

const User = mongoose.model('User', UserSchema);

async function generateReferralCode() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = 'SK-';
  for (let i = 0; i < 5; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

async function createUser(email, password, fullName, phone, role = 'Receiver') {
  await mongoose.connect(process.env.MONGODB_URI);

  const normalizedEmail = email.toLowerCase().trim();
  const existing = await User.findOne({ email: normalizedEmail, role });
  if (existing) {
    console.log(`User already exists for ${normalizedEmail} as ${role} (ID: ${existing._id})`);
    await mongoose.disconnect();
    return;
  }

  const salt = await bcrypt.genSalt(10);
  const passwordHash = await bcrypt.hash(password, salt);
  const referralCode = await generateReferralCode();

  const user = await User.create({
    email: normalizedEmail,
    passwordHash,
    phone: phone || '9876543210',
    fullName: fullName || normalizedEmail.split('@')[0],
    role: role,
    referralCode,
    walletBalance: 0,
    cashbackBalance: 0,
    isPhoneVerified: true,
    isEmailVerified: true
  });

  console.log(`Successfully created user in MongoDB!`);
  console.log(`ID: ${user._id}`);
  console.log(`Email: ${user.email}`);
  console.log(`Role: ${user.role}`);
  console.log(`Referral Code: ${user.referralCode}`);

  await mongoose.disconnect();
}

const args = process.argv.slice(2);
if (args.length >= 2) {
  createUser(args[0], args[1], args[2], args[3], args[4] || 'Receiver').catch(console.error);
} else {
  module.exports = { createUser };
}
