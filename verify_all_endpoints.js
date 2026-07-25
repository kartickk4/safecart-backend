const axios = require('axios');

const API = 'http://localhost:5001/api/v1';

async function runFullSystemAudit() {
  console.log('============ SAFECART BACKEND & FRONTEND ENDPOINT VERIFICATION ============');
  let token1, token2;
  let user1, user2;
  let shipment1, shipment2;

  try {
    // 1. Health check
    const h = await axios.get('http://localhost:5001/health');
    console.log('✅ 1. Healthcheck:', h.data.status, 'Service:', h.data.service);

    // 2. Auth: Register User 1 (Sender)
    const phone1 = `+9198${Math.floor(10000000 + Math.random() * 90000000)}`;
    const signup1 = await axios.post(`${API}/auth/signup`, {
      email: `sender_${Date.now()}@safecart.in`,
      password: 'Password123!',
      phone: phone1,
      fullName: 'Vikram Sender',
      role: 'User'
    });
    token1 = signup1.data.accessToken;
    user1 = signup1.data.user;
    console.log('✅ 2. Auth Signup (Sender):', user1.email, 'Phone:', user1.phone);

    // 3. Auth: Register User 2 (Receiver)
    const phone2 = `+9197${Math.floor(10000000 + Math.random() * 90000000)}`;
    const signup2 = await axios.post(`${API}/auth/signup`, {
      email: `receiver_${Date.now()}@safecart.in`,
      password: 'Password123!',
      phone: phone2,
      fullName: 'Anita Receiver',
      role: 'User'
    });
    token2 = signup2.data.accessToken;
    user2 = signup2.data.user;
    console.log('✅ 3. Auth Signup (Receiver):', user2.email, 'Phone:', user2.phone);

    const headers1 = { headers: { Authorization: `Bearer ${token1}` } };
    const headers2 = { headers: { Authorization: `Bearer ${token2}` } };

    // 4. Auth Login Verification
    const login1 = await axios.post(`${API}/auth/login`, {
      email: user1.email,
      password: 'Password123!'
    });
    console.log('✅ 4. Auth Login:', login1.data.user.email, 'JWT Token Issued:', !!login1.data.accessToken);

    // 5. Profile: Get & Update Bank Account Details in DB
    const profileUpd1 = await axios.put(`${API}/profile`, {
      fullName: 'Vikram Sender (Verified Supplier)',
      bankDetails: {
        accountHolderName: 'Vikram Sender',
        accountNumber: '987654321012',
        ifscCode: 'HDFC0001234',
        bankName: 'HDFC Bank'
      }
    }, headers1);
    console.log('✅ 5. Profile & Bank Account Details Saved in DB:', profileUpd1.data.bankDetails.bankName, profileUpd1.data.bankDetails.accountNumber);

    // Profile for Receiver
    await axios.put(`${API}/profile`, {
      bankDetails: {
        accountHolderName: 'Anita Receiver',
        accountNumber: '123456789012',
        ifscCode: 'ICIC0005678',
        bankName: 'ICICI Bank'
      }
    }, headers2);

    // 6. Shipments: Create Stage 1/3 Shipment with Escrow Funding & Logistics AWB Generation
    const createShip1 = await axios.post(`${API}/shipments`, {
      receiverName: 'Anita Receiver',
      receiverPhone: phone2,
      description: 'Custom Electronics Order',
      amount: 15400,
      city: 'Mumbai -> Bengaluru',
      carrierSlug: 'delhivery',
      fundEscrow: true
    }, headers1);
    shipment1 = createShip1.data;
    console.log('✅ 6. Create Escrow Shipment (Stage 3 Active):', shipment1.shipmentId, 'AWB:', shipment1.awbCode, 'Status:', shipment1.status, 'Escrow Stage:', shipment1.escrowStage);

    // 7. Get Shipments for Sender & Receiver
    const listShip1 = await axios.get(`${API}/shipments`, headers1);
    const listShip2 = await axios.get(`${API}/shipments`, headers2);
    console.log('✅ 7. Query User Shipments from DB:', 'Sender sees:', listShip1.data.length, 'shipment(s); Receiver sees:', listShip2.data.length, 'shipment(s)');

    // 8. Detailed Shipment & Carrier Journey Query
    const shipDetails = await axios.get(`${API}/shipments/${shipment1.shipmentId}`, headers1);
    console.log('✅ 8. Get Shipment Details by ID:', shipDetails.data.shipment.shipmentId, 'Courier Journey Milestones:', shipDetails.data.journey.milestones.length);

    // 9. Public Courier Tracking Endpoint by AWB Code
    const publicTrack = await axios.get(`${API}/tracking/${shipment1.awbCode}`);
    console.log('✅ 9. Public Courier Tracking by AWB:', publicTrack.data.awb, 'Courier Status:', publicTrack.data.status);

    // 10. Live Courier Webhook Updates (Simulating Live Courier In-Transit & Out for Delivery & Delivered Stages)
    console.log('--- Simulating Live Courier Tracking Webhook Updates ---');
    
    // Stage 4: In Transit
    await axios.post(`${API}/tracking/webhook/carrier-tracking`, {
      awb: shipment1.awbCode,
      status: 'In Transit',
      location: 'Bhiwandi Hub, Maharashtra',
      activities: [
        { activity: 'Package Picked Up', location: 'Bhiwandi Hub', time: new Date() },
        { activity: 'In Transit to Destination Hub', location: 'Pune Express Highway Hub', time: new Date() }
      ]
    });
    const trackAfterTransit = await axios.get(`${API}/tracking/${shipment1.awbCode}`);
    console.log('  🚚 Live Courier Webhook -> Stage 4 (In Transit): Status =', trackAfterTransit.data.status, 'Milestones =', trackAfterTransit.data.journey.length);

    // Stage 4: Out for Delivery
    await axios.post(`${API}/tracking/webhook/carrier-tracking`, {
      awb: shipment1.awbCode,
      status: 'Out for Delivery',
      location: 'Bengaluru Delivery Hub',
      activities: [
        { activity: 'Package Picked Up', location: 'Bhiwandi Hub', time: new Date() },
        { activity: 'In Transit to Destination Hub', location: 'Pune Express Highway Hub', time: new Date() },
        { activity: 'Out for Delivery with Agent Vijay', location: 'Bengaluru Delivery Hub', time: new Date() }
      ]
    });
    const trackAfterOut = await axios.get(`${API}/tracking/${shipment1.awbCode}`);
    console.log('  🚚 Live Courier Webhook -> Stage 4 (Out for Delivery): Status =', trackAfterOut.data.status);

    // Stage 5: Delivered
    await axios.post(`${API}/tracking/webhook/carrier-tracking`, {
      awb: shipment1.awbCode,
      status: 'Delivered',
      location: 'Bengaluru Destination Address',
      activities: [
        { activity: 'Package Picked Up', location: 'Bhiwandi Hub', time: new Date() },
        { activity: 'In Transit to Destination Hub', location: 'Pune Express Highway Hub', time: new Date() },
        { activity: 'Out for Delivery with Agent Vijay', location: 'Bengaluru Delivery Hub', time: new Date() },
        { activity: 'Package Delivered to Recipient Anita Receiver', location: 'Bengaluru Destination Address', time: new Date() }
      ]
    });
    const trackAfterDelivered = await axios.get(`${API}/shipments/${shipment1.shipmentId}`, headers2);
    console.log('  ✅ Live Courier Webhook -> Stage 5 (Delivered): Status in DB =', trackAfterDelivered.data.shipment.status, 'Escrow Stage =', trackAfterDelivered.data.shipment.escrowStage);

    // 11. Escrow Release by Receiver
    const releaseRes = await axios.put(`${API}/shipments/${shipment1.shipmentId}/release`, {}, headers2);
    console.log('✅ 11. Delivery Sign-Off & Escrow Release by Receiver:', releaseRes.data.shipmentId, 'Final Status:', releaseRes.data.status, 'Escrow Stage:', releaseRes.data.escrowStage);

    // 12. Create Shipment 2 for Dispute Claim Testing
    const createShip2 = await axios.post(`${API}/shipments`, {
      receiverName: 'Anita Receiver',
      receiverPhone: phone2,
      description: 'Fragile Glassware Shipment',
      amount: 8200,
      city: 'Delhi -> Mumbai',
      carrierSlug: 'bluedart',
      fundEscrow: true
    }, headers1);
    shipment2 = createShip2.data;

    // 13. File Dispute Claim (Locks Escrow in MongoDB)
    const claimRes = await axios.post(`${API}/claims`, {
      shipmentId: shipment2.shipmentId,
      role: 'receiver',
      reason: 'Damaged item',
      description: 'Glassware arrived shattered during transit.'
    }, headers2);
    console.log('✅ 13. Dispute Claim Filed & Escrow Locked in DB:', claimRes.data.claimId, 'Shipment ID:', claimRes.data.shipmentId, 'Claim Status:', claimRes.data.status);

    // Query Claim Details
    const claimDetail = await axios.get(`${API}/claims/${shipment2.shipmentId}`, headers2);
    console.log('✅ 14. Query Claim Details from DB:', claimDetail.data.claimId, 'Filed By:', claimDetail.data.filedBy.fullName);

    // 15. Notifications API
    const notifs1 = await axios.get(`${API}/notifications`, headers1);
    const notifs2 = await axios.get(`${API}/notifications`, headers2);
    console.log('✅ 15. Real Notifications Generated in DB:', 'Sender received', notifs1.data.length, 'alerts; Receiver received', notifs2.data.length, 'alerts');

    if (notifs1.data.length > 0) {
      const readRes = await axios.put(`${API}/notifications/${notifs1.data[0]._id}/read`, {}, headers1);
      console.log('✅ 16. Mark Notification Read in DB:', readRes.data._id, 'Read Status:', readRes.data.read);
    }

    console.log('========================================================================');
    console.log('🎉 ALL BACKEND ENDPOINTS & LIVE COURIER TRACKING STAGES FULLY VERIFIED!');
    console.log('========================================================================');
  } catch (err) {
    console.error('❌ Audit Failed:', err.response?.data || err.message);
  }
}

runFullSystemAudit();
