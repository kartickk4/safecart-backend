const mongoose = require('mongoose');

async function testSrv() {
  const uri = 'mongodb+srv://Kartick_das:kartick4897@5ycrpqe.mongodb.net/safecart?retryWrites=true&w=majority';
  console.log('Testing SRV URI:', uri);
  try {
    const conn = await mongoose.connect(uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 5000
    });
    console.log('SUCCESS SRV Connected:', conn.connection.host);
    process.exit(0);
  } catch (err) {
    console.error('FAILED SRV Error:', err.message);
    process.exit(1);
  }
}

testSrv();
