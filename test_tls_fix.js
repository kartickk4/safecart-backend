const mongoose = require('mongoose');

const uri = "mongodb://Kartick_das:kartick4897@ac-ciki0ky-shard-00-00.5ycrpqe.mongodb.net:27017,ac-ciki0ky-shard-00-01.5ycrpqe.mongodb.net:27017,ac-ciki0ky-shard-00-02.5ycrpqe.mongodb.net:27017/safecart?replicaSet=atlas-12ckb0-shard-0&authSource=admin&retryWrites=true&w=majority";

async function testTls() {
  console.log('Testing TLS Fix...');
  try {
    const conn = await mongoose.connect(uri, {
      tls: true,
      serverSelectionTimeoutMS: 5000
    });
    console.log('🎉 SUCCESS! Connected host:', conn.connection.host);
    process.exit(0);
  } catch (err) {
    console.error('TLS Fix Failed:', err.message);
    process.exit(1);
  }
}

testTls();
