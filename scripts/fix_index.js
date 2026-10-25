require('dotenv').config();
const mongoose = require('mongoose');

async function fixIndexes() {
  try {
    const connStr = process.env.MONGODB_URI;
    if (!connStr) {
      console.error('MONGODB_URI not found');
      process.exit(1);
    }
    console.log('Connecting to MongoDB...');
    await mongoose.connect(connStr);
    console.log('Connected!');

    const User = require('./src/models/User');
    const indexes = await User.collection.indexes();
    console.log('Current MongoDB indexes on users collection:', indexes.map(i => i.name));

    if (indexes.some(i => i.name === 'email_1')) {
      console.log('Dropping legacy email_1 index...');
      await User.collection.dropIndex('email_1');
      console.log('Successfully dropped legacy email_1 index!');
    } else {
      console.log('Legacy email_1 index already removed!');
    }

    console.log('Ensuring compound indexes { email: 1, role: 1 }...');
    await User.syncIndexes();
    const updatedIndexes = await User.collection.indexes();
    console.log('Updated indexes:', updatedIndexes.map(i => i.name));

    console.log('ALL INDEXES SUCCESSFULLY FIXED!');
    process.exit(0);
  } catch (err) {
    console.error('Index Migration Error:', err);
    process.exit(1);
  }
}

fixIndexes();
