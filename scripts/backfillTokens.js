const mongoose = require('mongoose');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');
  const Shipment = mongoose.model('Shipment', new mongoose.Schema({}, { strict: false }));
  
  const shipments = await Shipment.find({
    $or: [
      { inboxQrToken: { $exists: false } },
      { inboxQrToken: null },
      { inboxQrToken: '' }
    ]
  });

  console.log('Shipments missing inboxQrToken:', shipments.length);

  for (const s of shipments) {
    const qrToken = crypto.randomBytes(20).toString('hex');
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    s.inboxQrToken = qrToken;
    s.inboxQrGeneratedAt = new Date();
    s.inboxQrUsed = false;
    s.deliveryOtp = otp;
    s.deliveryOtpExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    s.deliveryOtpUsed = false;
    await s.save();
    console.log('Backfilled shipment:', s.shipmentId, 'token:', qrToken);
  }

  console.log('All shipments now have valid inboxQrTokens!');
  process.exit(0);
}

run().catch(err => {
  console.error('Backfill error:', err);
  process.exit(1);
});
