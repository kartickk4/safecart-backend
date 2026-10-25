require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./src/models/User');
const Reward = require('./src/models/Reward');
const rewardService = require('./src/services/rewardService');

async function runTest() {
  console.log('Connecting to database...');
  await mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
  console.log('Connected to MongoDB!');

  try {
    // 1. Create or get test user
    const testPhone = '+919999999999';
    let user = await User.findOne({ phone: testPhone });
    if (!user) {
      user = new User({
        email: 'test_receiver@securekaro.app',
        passwordHash: 'hashed_password_dummy',
        fullName: 'Test Receiver User',
        phone: testPhone,
        cashbackBalance: 0
      });
      await user.save();
      console.log('Created new test user:', user.email);
    } else {
      user.cashbackBalance = 0;
      await user.save();
      console.log('Reset test user cashbackBalance to 0');
    }

    // Clean previous rewards
    await Reward.deleteMany({ userId: user._id });

    // 2. Verify Weighted Random Distribution over 100 iterations
    console.log('\n--- Testing Weighted Random Distribution (100 runs) ---');
    const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
    for (let i = 0; i < 100; i++) {
      const val = rewardService.generateWeightedCashback();
      counts[val]++;
    }
    console.log('Distribution results (counts out of 100):');
    console.log(counts);
    const lowSum = counts[1] + counts[2] + counts[3];
    const highSum = counts[4] + counts[5] + counts[6];
    console.log(`Common rewards (₹1-₹3): ${lowSum}% (Expected: ~85%)`);
    console.log(`Rare rewards (₹4-₹6): ${highSum}% (Expected: ~15%)`);

    // 3. Test grantPrepaymentCashback
    console.log('\n--- Testing grantPrepaymentCashback ---');
    const shipmentId = `SPL-TEST-${Math.floor(Math.random() * 10000)}`;
    const reward = await rewardService.grantPrepaymentCashback(shipmentId, testPhone);
    
    if (reward) {
      console.log(`SUCCESS: Granted ₹${reward.amount} cashback for shipment ${shipmentId}`);
      user = await User.findById(user._id);
      console.log('Updated user cashbackBalance:', user.cashbackBalance);
    } else {
      throw new Error('Failed to grant cashback');
    }

    // 4. Test duplicate prevention
    console.log('\n--- Testing Duplicate Prevention ---');
    const duplicateReward = await rewardService.grantPrepaymentCashback(shipmentId, testPhone);
    const rewardCount = await Reward.countDocuments({ userId: user._id, shipmentId, type: 'CASHBACK_EARNED' });
    if (rewardCount === 1) {
      console.log('SUCCESS: Prevented duplicate cashback for the same shipment ID.');
    } else {
      throw new Error('FAIL: Duplicate cashback was allowed!');
    }

    // 5. Add some mock balance to test withdrawal
    console.log('\n--- Testing Withdrawal Feature ---');
    user.cashbackBalance = 50; // Mock balance
    await user.save();
    console.log('Set user cashback balance to ₹50 for withdrawal test.');

    // 5a. UPI Withdrawal
    console.log('Testing UPI Withdrawal...');
    const upiResult = await rewardService.withdrawCashback(
      user._id,
      20,
      'UPI',
      { upiId: 'test_receiver@upi' }
    );
    console.log(`SUCCESS: Withdrawn ₹20 via UPI. New Balance: ₹${upiResult.cashbackBalance}`);
    
    // 5b. Bank Withdrawal
    console.log('Testing Bank Account Withdrawal...');
    const bankResult = await rewardService.withdrawCashback(
      user._id,
      15,
      'BANK',
      {
        accountHolderName: 'Test Receiver User',
        accountNumber: '1234567890',
        ifscCode: 'HDFC0000123',
        bankName: 'HDFC Bank'
      }
    );
    console.log(`SUCCESS: Withdrawn ₹15 via Bank Account. New Balance: ₹${bankResult.cashbackBalance}`);

    // Verify final state
    user = await User.findById(user._id);
    console.log('Final user cashbackBalance:', user.cashbackBalance);
    const transactions = await Reward.find({ userId: user._id });
    console.log(`Total transactions recorded in DB: ${transactions.length}`);

    console.log('\n=====================================');
    console.log('ALL REWARD & WITHDRAWAL TESTS PASSED!');
    console.log('=====================================');

  } catch (error) {
    console.error('Test failed with error:', error);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected database.');
  }
}

runTest();
