const mongoose = require('mongoose');

const testUris = [
  "mongodb://Kartick_das:kartick4897@ac-ciki0ky-shard-00-00.5ycrpqe.mongodb.net:27017,ac-ciki0ky-shard-00-01.5ycrpqe.mongodb.net:27017,ac-ciki0ky-shard-00-02.5ycrpqe.mongodb.net:27017/safecart?replicaSet=atlas-12ckb0-shard-0&authSource=admin&retryWrites=true&w=majority",
  "mongodb://Kartick_das:kartick4897@ac-ciki0ky-shard-00-00.5ycrpqe.mongodb.net:27017,ac-ciki0ky-shard-00-01.5ycrpqe.mongodb.net:27017,ac-ciki0ky-shard-00-02.5ycrpqe.mongodb.net:27017/safecart?tls=true&replicaSet=atlas-12ckb0-shard-0&authSource=admin&retryWrites=true&w=majority",
  "mongodb+srv://Kartick_das:kartick4897@ac-ciki0ky-shard-00-00.5ycrpqe.mongodb.net/safecart?retryWrites=true&w=majority"
];

async function runSslTests() {
  for (let i = 0; i < testUris.length; i++) {
    console.log(`\nTesting SSL URI Option #${i+1}...`);
    try {
      const conn = await mongoose.connect(testUris[i], {
        useNewUrlParser: true,
        useUnifiedTopology: true,
        serverSelectionTimeoutMS: 5000
      });
      console.log(`🎉 SUCCESS ON OPTION #${i+1}! Connected host: ${conn.connection.host}`);
      await mongoose.disconnect();
      return testUris[i];
    } catch (e) {
      console.log(`Option #${i+1} Failed: ${e.message}`);
    }
  }
}

runSslTests();
