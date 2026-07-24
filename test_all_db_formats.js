const mongoose = require('mongoose');

const uris = [
  "mongodb://Kartick_das:kartick4897@ac-ciki0ky-shard-00-00.5ycrpqe.mongodb.net:27017,ac-ciki0ky-shard-00-01.5ycrpqe.mongodb.net:27017,ac-ciki0ky-shard-00-02.5ycrpqe.mongodb.net:27017/safecart?ssl=true&replicaSet=atlas-12ckb0-shard-0&authSource=admin&retryWrites=true&w=majority",
  "mongodb+srv://Kartick_das:kartick4897@ac-ciki0ky.5ycrpqe.mongodb.net/safecart?retryWrites=true&w=majority",
  "mongodb+srv://Kartick_das:kartick4897@cluster0.5ycrpqe.mongodb.net/safecart?retryWrites=true&w=majority"
];

async function testAll() {
  for (let i = 0; i < uris.length; i++) {
    console.log(`\nTesting URI variation #${i+1}...`);
    try {
      const conn = await mongoose.connect(uris[i], {
        useNewUrlParser: true,
        useUnifiedTopology: true,
        serverSelectionTimeoutMS: 4000
      });
      console.log(`SUCCESS on variation #${i+1}! Connected to: ${conn.connection.host}`);
      await mongoose.disconnect();
      return uris[i];
    } catch (e) {
      console.log(`FAILED variation #${i+1}: ${e.message}`);
    }
  }
}

testAll();
