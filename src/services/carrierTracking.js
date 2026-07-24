const axios = require('axios');

/**
 * Books a shipment (Simulated since TrackCourier.io is tracking-only).
 * Returns AWB tracking code, carrier slug, and shipping label.
 */
const bookShipment = async (shipment, senderUser) => {
  // If the request already has tracking details specified (e.g. for testing live APIs)
  if (shipment.carrierSlug && shipment.awbCode) {
    return {
      carrierSlug: shipment.carrierSlug.toLowerCase(),
      awbCode: shipment.awbCode,
      shippingLabelUrl: shipment.shippingLabelUrl || 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf'
    };
  }

  // Generate simulated booking details
  const carrierSlug = (process.env.DEFAULT_CARRIER || 'delhivery').toLowerCase();
  const randomSuffix = Math.floor(1000000000 + Math.random() * 9000000000);
  const awbCode = `TC-${carrierSlug}-${randomSuffix}`;
  const shippingLabelUrl = 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf';

  console.log(`[CARRIER TRACKING] Simulated booking for shipment ${shipment.shipmentId}. Assigned Courier: ${carrierSlug}, AWB: ${awbCode}`);

  return {
    carrierSlug,
    awbCode,
    shippingLabelUrl
  };
};

/**
 * Gets tracking details from TrackCourier.io API or mock simulation.
 */
const getTrackingDetails = async (carrierSlug, awbCode) => {
  const isMock = process.env.CARRIER_TRACKING_MOCK === 'true' || 
                 awbCode.startsWith('MOCK');

  if (isMock) {
    console.log(`[CARRIER TRACKING MOCK] Fetching mock checkpoints for AWB: ${awbCode}`);
    
    // Simulate typical stages based on tracking time/milestones
    return {
      awb: awbCode,
      courier: carrierSlug,
      status: "In Transit",
      shipmentState: "in_transit",
      activities: [
        {
          activity: "Package Picked Up by Courier Partner",
          location: "Sender Location",
          date: new Date(Date.now() - 3600000 * 4).toISOString(),
          status: "Picked Up"
        },
        {
          activity: "Arrived at Sorting Hub",
          location: "Intermediate Sorting Hub",
          date: new Date(Date.now() - 3600000 * 2).toISOString(),
          status: "In Transit"
        }
      ]
    };
  }

  try {
    const apiKey = process.env.CARRIER_TRACKING_API_KEY;
    if (!apiKey) {
      throw new Error('CARRIER_TRACKING_API_KEY is not defined in the environment variables');
    }

    const response = await axios.get('https://api.trackcourier.io/v1/track', {
      params: {
        courier: carrierSlug,
        tracking_number: awbCode
      },
      headers: {
        'X-API-Key': apiKey
      }
    });

    const data = response.data;
    if (data && data.success && data.data) {
      const trackingData = data.data;
      const checkpoints = trackingData.Checkpoints || [];
      
      const mappedActivities = checkpoints.map(cp => {
        let checkpointDate = new Date();
        if (cp.Date) {
          try {
            checkpointDate = new Date(cp.Date + (cp.Time ? ' ' + cp.Time : ''));
            if (isNaN(checkpointDate.getTime())) {
              checkpointDate = new Date();
            }
          } catch (e) {
            checkpointDate = new Date();
          }
        }
        return {
          activity: cp.Activity || 'Status updated',
          location: cp.Location || 'Hub',
          date: checkpointDate.toISOString(),
          status: cp.CheckpointState || cp.MostRecentStatus || 'In Transit'
        };
      });

      return {
        awb: awbCode,
        courier: carrierSlug,
        status: trackingData.MostRecentStatus || "In Transit",
        shipmentState: (trackingData.ShipmentState || "in_transit").toLowerCase(),
        activities: mappedActivities
      };
    }
    return null;
  } catch (error) {
    console.error('TrackCourier API Error:', error.response ? error.response.data : error.message);
    return null;
  }
};

module.exports = {
  bookShipment,
  getTrackingDetails
};
