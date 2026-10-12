const mongoose = require('mongoose');
require('dotenv').config({ path: 'C:/Users/Kartick/.gemini/antigravity-ide/scratch/safecart-backend/.env' });

async function check() {
  await mongoose.connect(process.env.MONGODB_URI);
  const shipments = await mongoose.connection.collection('shipments').find({
    inboxQrToken: { $regex: '^f07bc85d' }
  }).toArray();
  console.log('Matching shipments:', shipments.map(s => ({
    _id: s._id,
    shipmentId: s.shipmentId,
    description: s.description,
    amount: s.amount,
    status: s.status,
    inboxQrToken: s.inboxQrToken,
    inboxQrUsed: s.inboxQrUsed,
    receiverPhone: s.receiverPhone
  })));

  if (shipments.length === 0) {
    const all = await mongoose.connection.collection('shipments').find({}).project({ shipmentId: 1, description: 1, amount: 1, inboxQrToken: 1, status: 1 }).toArray();
    console.log('All shipments with tokens:', all);
  }
  await mongoose.disconnect();
}

check().catch(console.error);
