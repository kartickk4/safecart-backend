const mongoose = require('mongoose');
require('dotenv').config();
const connectDB = require('../src/config/db');
const User = require('../src/models/User');

connectDB().then(async () => {
  const result = await User.updateMany(
    { email: 'kartickdas6289@gmail.com' },
    { $set: { isAdmin: true, adminRole: 'super_admin' } }
  );
  console.log('ADMIN_SEEDED_SUCCESS:', result);
  process.exit(0);
}).catch(err => {
  console.error('SEED_ERROR:', err);
  process.exit(1);
});
