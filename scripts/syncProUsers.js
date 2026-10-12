const mongoose = require('mongoose');
require('dotenv').config({ path: 'C:/Users/Kartick/.gemini/antigravity-ide/scratch/safecart-backend/.env' });

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  // Find all accounts where any role under the email has isPro: true
  const proUsers = await mongoose.connection.collection('users').find({ isPro: true }).toArray();
  const proEmails = [...new Set(proUsers.map(u => (u.email || '').toLowerCase().trim()).filter(Boolean))];

  console.log('Emails with at least one Pro account:', proEmails);

  for (const email of proEmails) {
    const updateResult = await mongoose.connection.collection('users').updateMany(
      { email },
      { $set: { isPro: true, proPlan: 'Pro', proUpgradedAt: new Date() } }
    );
    console.log(`Synced Pro status for ${email}: ${updateResult.modifiedCount} accounts updated.`);
  }

  // Also clean up any role: 'User' documents for kartickdas6289@gmail.com
  const userRoleDoc = await mongoose.connection.collection('users').findOne({ email: 'kartickdas6289@gmail.com', role: 'User' });
  if (userRoleDoc) {
    // If supplier or receiver already exists, remove or merge the stale User document
    const supplierExists = await mongoose.connection.collection('users').findOne({ email: 'kartickdas6289@gmail.com', role: 'Supplier' });
    if (supplierExists) {
      await mongoose.connection.collection('users').deleteOne({ _id: userRoleDoc._id });
      console.log('Deleted redundant stale User role document for kartickdas6289@gmail.com');
    } else {
      await mongoose.connection.collection('users').updateOne({ _id: userRoleDoc._id }, { $set: { role: 'Supplier' } });
      console.log('Updated User role doc to Supplier');
    }
  }

  const finalDocs = await mongoose.connection.collection('users').find({ email: 'kartickdas6289@gmail.com' }).toArray();
  console.log('Final accounts for kartickdas6289@gmail.com:');
  finalDocs.forEach(d => console.log(`- Role: ${d.role}, isPro: ${d.isPro}, proPlan: ${d.proPlan}, googleId: ${d.googleId}`));

  await mongoose.disconnect();
}

run().catch(console.error);
