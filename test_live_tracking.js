require('dotenv').config();
const { getTrackingDetails } = require('./src/services/carrierTracking');

async function testLiveTracking() {
  console.log('Testing Live TrackCourier API with key:', process.env.CARRIER_TRACKING_API_KEY ? 'Key Loaded' : 'No Key');
  console.log('CARRIER_TRACKING_MOCK:', process.env.CARRIER_TRACKING_MOCK);
  
  // Test with a sample AWB
  const res = await getTrackingDetails('delhivery', '1234567890');
  console.log('TrackCourier Result:', res);
}

testLiveTracking();
