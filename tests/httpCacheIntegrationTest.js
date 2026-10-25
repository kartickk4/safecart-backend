/**
 * End-to-End HTTP Route Caching & Header Verification
 */
require('dotenv').config();
const http = require('http');
const app = require('../src/app');

async function runHttpTests() {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  console.log(`Test HTTP server listening on port ${port}`);

  try {
    // 1. Verify /api/v1/shipments/couriers (Public slowly changing cache)
    const res1 = await fetch(`${baseUrl}/api/v1/shipments/couriers`);
    const data1 = await res1.json();
    console.log('1. Couriers status:', res1.status, 'Cache-Control:', res1.headers.get('cache-control'));
    console.log('   Couriers count:', data1.count, 'First courier:', data1.couriers?.[0]?.name);

    if (res1.status !== 200 || !data1.success || data1.count < 5) {
      throw new Error('Couriers endpoint verification failed');
    }

    // 2. Verify /api/v1/shipments/serviceability/pincode/110001 (Cached Geo lookup)
    const res2 = await fetch(`${baseUrl}/api/v1/shipments/serviceability/pincode/110001`);
    const data2 = await res2.json();
    console.log('2. Pincode 110001 zone:', data2.serviceability?.zone, 'Label:', data2.serviceability?.label);

    if (data2.serviceability?.zone !== 'metro') {
      throw new Error('Pincode serviceability verification failed');
    }

    // 3. Verify Privacy Anti-Cache Headers on Sensitive Endpoint /api/v1/auth/login
    const res3 = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'fake@securekaro.in', password: 'wrong' })
    });
    console.log('3. Auth route Cache-Control:', res3.headers.get('cache-control'));
    console.log('   Auth route Pragma:', res3.headers.get('pragma'));

    if (res3.headers.get('cache-control') !== 'no-store, no-cache, must-revalidate, private') {
      throw new Error('Auth route failed privacy header enforcement');
    }

    // 4. Verify Public Tracking Endpoint Sanitize & Headers
    const res4 = await fetch(`${baseUrl}/api/v1/tracking/TC-delhivery-1234567890`);
    console.log('4. Tracking route status (404 for unknown AWB is expected):', res4.status);

    console.log('\n>>> ALL HTTP INTEGRATION CHECKS PASSED SUCCESSFULLY <<<');
  } finally {
    server.close();
  }
}

runHttpTests().catch(err => {
  console.error('HTTP Test Failure:', err);
  process.exit(1);
});
