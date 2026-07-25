const axios = require('axios');

const API = 'http://localhost:5001/api/v1';

async function testAll() {
  console.log('--- Testing Backend APIs ---');
  try {
    // 1. Healthcheck
    const h = await axios.get('http://localhost:5001/health');
    console.log('✅ Healthcheck:', h.data);

    // 2. Signup / Login
    const testEmail = `testuser_${Date.now()}@safecart.in`;
    const testPassword = 'Password123!';
    const testPhone = `+9198${Math.floor(10000000 + Math.random() * 90000000)}`;

    const signupRes = await axios.post(`${API}/auth/signup`, {
      email: testEmail,
      password: testPassword,
      phone: testPhone,
      fullName: 'Test Live User',
      role: 'User'
    });
    console.log('✅ Signup Success:', signupRes.data.user.email);
    const token = signupRes.data.accessToken;

    const authHeaders = { headers: { Authorization: `Bearer ${token}` } };

    // 3. Profile & Bank Details update
    const profileRes = await axios.put(`${API}/profile`, {
      bankDetails: {
        accountHolderName: 'Test Live User',
        accountNumber: '998877665544',
        ifscCode: 'HDFC0001234',
        bankName: 'HDFC Bank'
      }
    }, authHeaders);
    console.log('✅ Profile Bank Details Updated:', profileRes.data.bankDetails);

    // 4. Create Shipment
    const shipRes = await axios.post(`${API}/shipments`, {
      receiverName: 'Priya Nair',
      receiverPhone: '+919876543210',
      description: 'Handcrafted Wooden Decor',
      amount: 4500,
      city: 'Mumbai -> Delhi',
      fundEscrow: true
    }, authHeaders);
    console.log('✅ Shipment Created:', shipRes.data.shipmentId, shipRes.data.status);

    // 5. Get Shipments
    const listRes = await axios.get(`${API}/shipments`, authHeaders);
    console.log('✅ Get Shipments Count:', listRes.data.length);

    // 6. Get Notifications
    const notifRes = await axios.get(`${API}/notifications`, authHeaders);
    console.log('✅ Get Notifications Count:', notifRes.data.length, 'First Title:', notifRes.data[0]?.title);

    console.log('--- ALL BACKEND VERIFICATIONS PASSED ---');
  } catch (err) {
    console.error('❌ Test Error:', err.response?.data || err.message);
  }
}

testAll();
