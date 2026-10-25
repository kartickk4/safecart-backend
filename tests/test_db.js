require('dotenv').config();
const mongoose = require('mongoose');

async function testConnection() {
  console.log('Testing connection to MONGODB_URI...');
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 5000
    });
    console.log('SUCCESS! MongoDB Connected to host:', conn.connection.host);
    process.exit(0);
  } catch (err) {
    console.error('FAILED! MongoDB Error:', err.message);
    process.exit(1);
  }
}

testConnection();
