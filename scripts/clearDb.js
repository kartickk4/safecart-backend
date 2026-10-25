require('dotenv').config();
const mongoose = require('mongoose');

async function clearAllData() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI not found in environment!");
    process.exit(1);
  }

  console.log("Connecting to MongoDB Atlas...");
  await mongoose.connect(uri);
  console.log("Connected successfully!");

  const collections = await mongoose.connection.db.collections();
  for (let collection of collections) {
    const name = collection.collectionName;
    const result = await collection.deleteMany({});
    console.log(`Deleted ${result.deletedCount} documents from collection: ${name}`);
  }

  console.log("Database wipe completed successfully! All data cleared.");
  await mongoose.disconnect();
  process.exit(0);
}

clearAllData().catch(err => {
  console.error("Error clearing database:", err);
  process.exit(1);
});
