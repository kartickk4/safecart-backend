/**
 * MongoDB Migration Script — Add Pro Fields to Existing Users
 * Run once: node scripts/migrate-pro-fields.js
 *
 * Sets default values for isPro, proPlan, proUpgradedAt on all
 * existing user documents that do not yet have these fields.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/securekaro';

async function migrate() {
  console.log('🔌 Connecting to MongoDB:', MONGO_URI);
  await mongoose.connect(MONGO_URI);
  console.log('✅ Connected.\n');

  const db = mongoose.connection.db;
  const collection = db.collection('users');

  // Step 1: Add isPro = false where field is missing
  const resIsPro = await collection.updateMany(
    { isPro: { $exists: false } },
    { $set: { isPro: false } }
  );
  console.log(`[isPro]         Updated ${resIsPro.modifiedCount} document(s) → isPro: false`);

  // Step 2: Add proPlan = 'Standard' where field is missing
  const resProPlan = await collection.updateMany(
    { proPlan: { $exists: false } },
    { $set: { proPlan: 'Standard' } }
  );
  console.log(`[proPlan]       Updated ${resProPlan.modifiedCount} document(s) → proPlan: 'Standard'`);

  // Step 3: Add proUpgradedAt = null where field is missing
  const resProUpgradedAt = await collection.updateMany(
    { proUpgradedAt: { $exists: false } },
    { $set: { proUpgradedAt: null } }
  );
  console.log(`[proUpgradedAt] Updated ${resProUpgradedAt.modifiedCount} document(s) → proUpgradedAt: null`);

  // Step 4: Summary
  const total = await collection.countDocuments();
  const proUsers = await collection.countDocuments({ isPro: true });
  const standardUsers = await collection.countDocuments({ isPro: false });

  console.log('\n📊 Post-Migration Summary:');
  console.log(`   Total users  : ${total}`);
  console.log(`   Pro users    : ${proUsers}`);
  console.log(`   Standard     : ${standardUsers}`);

  await mongoose.disconnect();
  console.log('\n🔒 Disconnected. Migration complete!');
}

migrate().catch((err) => {
  console.error('❌ Migration failed:', err.message);
  process.exit(1);
});
