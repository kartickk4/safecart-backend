const path = require('path');
const fs = require('fs');

function loadMod(type, name) {
  const candidates = [
    path.resolve(__dirname, '..', type, name),
    path.resolve(__dirname, type, name),
    path.resolve(__dirname, name),
    path.resolve(process.cwd(), 'src', type, name),
    path.resolve(process.cwd(), type, name),
    path.resolve(process.cwd(), name)
  ];
  for (const c of candidates) {
    if (fs.existsSync(c + '.js')) return require(c + '.js');
    if (fs.existsSync(c)) return require(c);
  }
  try { return require(`../${type}/${name}`); } catch(e) {}
  return require(`./${name}`);
}

const { getCheapestPickupCarrier } = loadMod('services', 'carrierRateService');
const { createNotification } = loadMod('services', 'notification');
const { createOrderInShiprocket } = loadMod('services', 'shiprocketService');
const { createOrderInNimbusPost } = loadMod('services', 'nimbuspostService');
const CarrierJourney = loadMod('models', 'CarrierJourney');

function formatCarrierBrandName(slug, explicitName) {
  if (explicitName && !explicitName.toLowerCase().startsWith('nimbus_') && !explicitName.toLowerCase().startsWith('shadowfax_')) {
    return explicitName;
  }
  const s = String(slug || '').toLowerCase();
  if (s.includes('bluedart') || s.includes('blue_dart')) return 'Blue Dart Express';
  if (s.includes('shadowfax')) {
    if (s.includes('direct')) return 'Shadowfax Direct';
    return 'Shadowfax Technologies';
  }
  if (s.includes('delhivery')) {
    if (s.includes('direct')) return 'Delhivery Direct';
    return 'Delhivery Express';
  }
  if (s.includes('ekart')) return 'Ekart Logistics';
  if (s.includes('xpressbees')) return 'Xpressbees Logistics';
  if (s.includes('dtdc')) return 'DTDC Express';
  if (s.includes('ecom_express') || s.includes('ecom')) return 'Ecom Express';
  if (s.includes('amazon') || s.includes('ats')) return 'Amazon Shipping';
  if (s.includes('rapido')) return 'Rapido Parcel';
  if (s.includes('indiapost') || s.includes('speed_post')) return 'India Post Speed Post';
  if (s.includes('smartr')) return 'Smartr Logistics';
  if (s.includes('trackon')) return 'Trackon Courier';
  
  const cleaned = s
    .replace(/^nimbus_/i, '')
    .replace(/_[a-f0-9]{16,}$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  return cleaned ? (cleaned.charAt(0).toUpperCase() + cleaned.slice(1)) : 'Courier Partner';
}



const PREFIX_MAP = {
  delhivery:    'SR-DLV',
  shadowfax:    'SR-SFX',
  rapido:       'SR-RPD',
  ekart:        'SR-EKT',
  xpressbees:   'SR-XPB',
  dtdc:         'SR-DTC',
  bluedart:     'SR-BLU',
  ecom_express: 'SR-ECM',
  indiapost:    'SR-POST'
};

/**
 * Auto-schedules courier pickup for a booked shipment by comparing
 * ALL popular courier partners (Delhivery, Shadowfax, Ekart, Xpressbees, DTDC, BlueDart, etc.)
 * through the Shiprocket Multi-Carrier API and choosing whichever has the lowest delivery charge.
 *
 * @param {object} shipment - Mongoose Shipment document
 * @param {object} sender   - Mongoose User document or sender object
 * @returns {object} { pickupToken, pickupSlot, carrier, rate, executive, comparison, apiProvider }
 */
const autoScheduleCourierPickup = async (shipment, sender, preferredCarrierSlug) => {
  try {
    const senderPincode = shipment.senderPincode || 
                          sender?.pincode || 
                          sender?.pickupAddress?.pincode || 
                          '110001';

    const receiverPincode = shipment.receiverPincode || '400001';
    const weightKg = shipment.parcelWeight || 0.5;

    // 1. Compare rates across all popular courier partners via Shiprocket Multi-Carrier API
    const { cheapest, comparison, savingsAmount } = getCheapestPickupCarrier(senderPincode, receiverPincode, weightKg);

    // Honor preferredCarrierSlug selected by buyer / caller, else check shipment.carrierSlug, else auto cheapest
    const targetCarrierSlug = (
      preferredCarrierSlug || 
      (shipment.carrierSlug && shipment.carrierSlug !== 'auto' && shipment.carrierSlug !== 'add_later' ? shipment.carrierSlug : null) || 
      cheapest?.slug || 
      'delhivery'
    ).toLowerCase();

    const matchedCarrier = comparison?.find(c => c.slug === targetCarrierSlug);
    const assignedCarrierSlug = targetCarrierSlug;
    let assignedCarrierName = formatCarrierBrandName(targetCarrierSlug, matchedCarrier?.name);
    const assignedRate = matchedCarrier?.price || (targetCarrierSlug.includes('bluedart') ? 65 : 40);

    // 2. Compute the optimal pickup time slot strictly using Indian Standard Time (IST, UTC+5:30)
    const nowUtc = new Date();
    const istTime = new Date(nowUtc.getTime() + (5.5 * 60 * 60 * 1000));
    const istHour = istTime.getUTCHours();

    let pickupDate = new Date(istTime.getTime());
    let pickupSlot = '';
    let pickupDateStr = '';
    let pickupTimeStr = '14:00:00';

    if (istHour < 14) {
      // Booked before 2:00 PM IST -> Same-Day Afternoon Pickup (2 PM - 6 PM)
      pickupSlot = 'Today, 02:00 PM - 06:00 PM (Same-Day Evening Slot)';
      pickupTimeStr = '15:00:00';
      const yyyy = pickupDate.getUTCFullYear();
      const mm = String(pickupDate.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(pickupDate.getUTCDate()).padStart(2, '0');
      pickupDateStr = `${yyyy}-${mm}-${dd}`;
    } else {
      // Booked 2:00 PM IST or later -> Next-Day Morning Pickup (10 AM - 1 PM)
      pickupDate.setUTCDate(pickupDate.getUTCDate() + 1);
      // Skip Sunday if tomorrow is Sunday
      if (pickupDate.getUTCDay() === 0) {
        pickupDate.setUTCDate(pickupDate.getUTCDate() + 1);
      }
      const dayName = pickupDate.toLocaleDateString('en-IN', {
        timeZone: 'UTC',
        weekday: 'short',
        day: 'numeric',
        month: 'short'
      });
      pickupSlot = `${dayName}, 10:00 AM - 01:00 PM (Morning Slot)`;
      pickupTimeStr = '11:00:00';
      const yyyy = pickupDate.getUTCFullYear();
      const mm = String(pickupDate.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(pickupDate.getUTCDate()).padStart(2, '0');
      pickupDateStr = `${yyyy}-${mm}-${dd}`;
    }

    // 3. Generate Courier Pickup Token / Reference
    const isDelhiveryDirect = String(assignedCarrierSlug || '').startsWith('delhivery');
    const isShadowfaxDirect = String(assignedCarrierSlug || '').startsWith('shadowfax');
    const isNimbus = String(assignedCarrierSlug || '').startsWith('nimbus_');

    let prefix = 'SR-PKP';
    for (const [key, val] of Object.entries(PREFIX_MAP)) {
      if (assignedCarrierSlug.includes(key)) {
        prefix = val;
        break;
      }
    }
    let pickupToken = `${prefix}-${Math.floor(100000 + Math.random() * 900000)}`;

    // 4. Assign Pickup Executive (Carrier-assigned for live couriers, no fake simulated names)
    let executive;
    if (isDelhiveryDirect) {
      executive = {
        name: 'Delhivery Field Executive',
        phone: 'Assigned on morning dispatch'
      };
    } else if (isShadowfaxDirect) {
      executive = {
        name: 'Shadowfax Field Rider',
        phone: 'Assigned on morning dispatch'
      };
    } else if (isNimbus) {
      executive = {
        name: `${assignedCarrierName} Logistics Partner`,
        phone: 'Assigned upon carrier dispatch'
      };
    } else {
      executive = {
        name: 'Courier Field Executive',
        phone: 'Assigned on morning dispatch'
      };
    }

    // 5. Construct full sender pickup location address
    const pickupAddressStr = shipment.senderAddress || 
      sender?.address || 
      (sender?.pickupAddress?.street ? 
        `${sender.pickupAddress.street}${sender.pickupAddress.city ? ', ' + sender.pickupAddress.city : ''}${sender.pickupAddress.state ? ', ' + sender.pickupAddress.state : ''}${sender.pickupAddress.pincode ? ' - ' + sender.pickupAddress.pincode : ''}` : 
        'Registered Merchant Warehouse');

    // 6. Update shipment document with auto-scheduled pickup metadata
    shipment.carrierSlug = assignedCarrierSlug;
    shipment.autoCarrierSelected = true;
    shipment.pickupScheduledAt = new Date();
    shipment.pickupToken = pickupToken;
    shipment.pickupSlot = '';
    shipment.pickupStatus = 'Ready to Ship';
    shipment.pickupCarrier = assignedCarrierName;
    shipment.pickupCarrierSlug = assignedCarrierSlug;
    shipment.pickupRate = shipment.pickupRate || shipment.deliveryCharge || assignedRate;
    if (!shipment.courierDeliveryCharge) {
      shipment.courierDeliveryCharge = shipment.pickupRate;
    }
    if (shipment.paymentMode === 'cod' && !shipment.codHandlingCharge) {
      shipment.codHandlingCharge = shipment.codCharge || 30;
    }

    // For paid_offline orders (no escrow vault), courier charge is debited directly from seller wallet
    if (shipment.paymentMode === 'paid_offline' && sender) {
      const curWallet = Number(sender.walletBalance) || 0;
      sender.walletBalance = parseFloat((curWallet - assignedRate).toFixed(2));
      await sender.save();
      try {
        const { recordTransaction } = require('./walletService');
        await recordTransaction({
          userId: sender._id,
          type: 'debit',
          amount: assignedRate,
          source: 'freight_deduction',
          description: `Courier freight deducted for shipment ${shipment.shipmentId}`,
          balanceBefore: curWallet,
          balanceAfter: sender.walletBalance,
          metadata: { shipmentId: shipment.shipmentId }
        });
      } catch (err) {}
      shipment.courierChargeDeducted = assignedRate;
      shipment.courierChargeDeductedFrom = 'seller_wallet';
      shipment.courierChargeStatus = 'Deducted';
    }

    shipment.pickupExpectedDate = pickupDate;
    shipment.pickupAgentName = executive.name;
    shipment.pickupAgentPhone = executive.phone;
    shipment.pickupLocationAddress = pickupAddressStr;
    shipment.pickupRateComparison = comparison;
    shipment.pickupAggregator = isDelhiveryDirect 
      ? 'Delhivery Direct Production Network' 
      : isShadowfaxDirect
      ? 'Shadowfax Direct Production Network'
      : (isNimbus ? 'NimbusPost Multi-Carrier Network' : 'Shiprocket Multi-Carrier Network');

    let isPickupConfirmed = false;
    let dlRes = null;
    let sfRes = null;
    let npRes = null;

    // Multi-Gateway Dispatch: Route to Delhivery Direct, Shadowfax Direct, NimbusPost, or Shiprocket
    if (isDelhiveryDirect) {
      try {
        const { createDelhiveryDirectOrder } = require('./delhiveryService');
        dlRes = await createDelhiveryDirectOrder(shipment, sender, { pickupDateStr, pickupTimeStr });
        if (dlRes?.awbCode) {
          shipment.awbCode = dlRes.awbCode;
          shipment.delhiveryWaybill = dlRes.awbCode;
          pickupToken = dlRes.pickupId ? `DLV-PR-${dlRes.pickupId}` : `DLV-${dlRes.awbCode}`;
          shipment.pickupToken = pickupToken;
          assignedCarrierName = 'Delhivery Express (Direct)';
          if (dlRes.pickupId) {
            isPickupConfirmed = true;
          }
          if (dlRes.pickupError) {
            shipment.pickupError = dlRes.pickupError;
          }
          if (dlRes.labelUrl) {
            shipment.shippingLabelUrl = dlRes.labelUrl;
          }
          console.log(`✅ [Delhivery Direct Dispatch] Successfully booked waybill: ${dlRes.awbCode}, PR: ${dlRes.pickupId || 'Pending'} for ${shipment.shipmentId}`);
        }
      } catch (dlErr) {
        console.warn('[DELHIVERY DIRECT SYNC NOTICE]:', dlErr.message);
      }
    } else if (isShadowfaxDirect) {
      try {
        const { createShadowfaxDirectOrder } = require('./shadowfaxService');
        sfRes = await createShadowfaxDirectOrder(shipment, sender);
        if (sfRes?.awbCode) {
          shipment.awbCode = sfRes.awbCode;
          shipment.shadowfaxAwb = sfRes.awbCode;
          pickupToken = `SFX-${sfRes.awbCode}`;
          shipment.pickupToken = pickupToken;
          assignedCarrierName = 'Shadowfax Technologies (Direct)';
          if (sfRes.labelUrl) {
            shipment.shippingLabelUrl = sfRes.labelUrl;
          }
          console.log(`✅ [Shadowfax Direct Dispatch] Successfully booked AWB: ${sfRes.awbCode} for ${shipment.shipmentId}`);
        }
      } catch (sfErr) {
        console.warn('[SHADOWFAX DIRECT SYNC NOTICE]:', sfErr.message);
      }
    } else if (isNimbus) {
      try {
        if (typeof createOrderInNimbusPost === 'function') {
          npRes = await createOrderInNimbusPost(shipment, sender);
          if (npRes?.orderId) {
            shipment.nimbusOrderId = npRes.orderId;
            shipment.nimbusShipmentId = npRes.shipmentId;
            if (npRes.awb) {
              shipment.awbCode = npRes.awb;
              shipment.nimbusAwb = npRes.awb;
            }
            const cleanOrderId = String(npRes.orderId).replace(/^NP[-_]/i, '');
            pickupToken = `NP-${cleanOrderId}`;
            shipment.pickupToken = pickupToken;
            if (npRes.labelUrl) {
              shipment.shippingLabelUrl = npRes.labelUrl;
            }
            if (npRes.labelPdfBase64) {
              shipment.shippingLabelPdfBase64 = npRes.labelPdfBase64;
            }
            if (npRes.courierName) {
              assignedCarrierName = formatCarrierBrandName(targetCarrierSlug, npRes.courierName);
              shipment.pickupCarrier = assignedCarrierName;
            }
          }
        }
      } catch (npErr) {
        console.warn('[NIMBUSPOST SYNC BACKGROUND NOTICE]:', npErr.message);
      }
    } else {
      // Live Shiprocket API: Push order to merchant's Shiprocket dashboard and auto-dispatch
      try {
        if (typeof createOrderInShiprocket === 'function') {
          const srRes = await createOrderInShiprocket(shipment, sender);
          if (srRes?.order_id) {
            shipment.shiprocketOrderId = srRes.order_id;
            shipment.shiprocketShipmentId = srRes.shipment_id;
            pickupToken = `SR-${srRes.order_id}`;
            shipment.pickupToken = pickupToken;
            if (srRes.dispatch?.courierName) {
              assignedCarrierName = srRes.dispatch.courierName;
            }
          }
        }
      } catch (srErr) {
        console.warn('[SHIPROCKET SYNC BACKGROUND NOTICE]:', srErr.message);
      }
    }

    shipment.pickupStatus = isPickupConfirmed ? 'Scheduled' : 'Ready to Ship';
    shipment.pickupSlot = isPickupConfirmed ? pickupSlot : '';

    if (typeof shipment.save === 'function') {
      await shipment.save();
    }

    // 7. Update CarrierJourney timeline with the accurate milestone
    try {
      let journey = await CarrierJourney.findOne({ shipmentId: shipment.shipmentId });
      if (!journey) {
        journey = new CarrierJourney({
          shipmentId: shipment.shipmentId,
          awbCode: shipment.awbCode,
          courierName: assignedCarrierName,
          milestones: []
        });
      }

      const comparisonText = comparison.length > 1 
        ? `SecureKaro Hybrid Logistics Engine compared ${comparison.length} popular courier partners across Shiprocket & NimbusPost (Delhivery, Shadowfax, Ekart, Xpressbees, DTDC, BlueDart, Ecom Express). Lowest rate: ${assignedCarrierName} at ₹${assignedRate}.` 
        : '';

      const milestoneStatus = isPickupConfirmed ? 'Pickup Scheduled' : 'Manifest Ready to Ship (Pickup Pending)';
      const milestoneDetail = isPickupConfirmed
        ? `Confirmed ${assignedCarrierName} pickup for slot: ${pickupSlot}. ${comparisonText} Courier Reference: ${pickupToken}. Pickup Executive: ${executive.name} (${executive.phone}).`
        : `Manifest generated on ${assignedCarrierName} network (AWB: ${shipment.awbCode || pickupToken}). Pickup not yet scheduled by courier partner. ${comparisonText}`;

      journey.milestones.push({
        status: milestoneStatus,
        location: sender?.city || sender?.pickupAddress?.city || 'Origin Warehouse',
        detail: milestoneDetail,
        time: new Date()
      });

      await journey.save();
    } catch (jErr) {
      console.warn('[PICKUP SERVICE] Journey update note:', jErr.message);
    }

    // 8. In-app notification for supplier
    if (sender?._id || shipment.senderId) {
      await createNotification(
        sender?._id || shipment.senderId,
        'local_shipping',
        `Courier ${isPickupConfirmed ? 'Pickup Scheduled' : 'Manifest Generated'}: ${shipment.shipmentId}`,
        isPickupConfirmed
          ? `Manifested with ${assignedCarrierName} (rate: ₹${assignedRate}). Confirmed pickup slot: ${pickupSlot}. Courier Ref: ${pickupToken}.`
          : `Manifested with ${assignedCarrierName} (rate: ₹${assignedRate}). AWB generated (${shipment.awbCode || pickupToken}); awaiting courier pickup confirmation.`,
        'shipping'
      );
    }

    // SECURITY: Log without pickup token (sensitive credential)
    console.log(`[PICKUP SERVICE] ${isPickupConfirmed ? 'Scheduled' : 'Manifested'} ${assignedCarrierName} for ${shipment.shipmentId}. Confirmed: ${isPickupConfirmed}, Rate: ₹${assignedRate}`);

    return {
      success: true,
      pickupToken,
      pickupSlot: isPickupConfirmed ? pickupSlot : '',
      carrier: assignedCarrierName,
      carrierSlug: assignedCarrierSlug,
      rate: assignedRate,
      executive,
      comparison,
      pickupLocationAddress: pickupAddressStr,
      apiProvider: 'Shiprocket Multi-Carrier Logistics Engine',
      totalCouriersCompared: comparison.length,
      savingsAmount
    };
  } catch (error) {
    console.error('[PICKUP SERVICE ERROR]:', error);
    return {
      success: false,
      error: error.message
    };
  }
};

/**
 * Cancel shipment order with the courier partner / master account
 * (NimbusPost, Shiprocket, Delhivery Direct, etc.)
 * @param {object} shipment - Mongoose Shipment document
 * @returns {Promise<{success: boolean, message: string}>}
 */
const cancelCarrierShipment = async (shipment) => {
  if (!shipment) return { success: false, message: 'No shipment provided' };

  const carrierSlug = String(shipment.carrierSlug || shipment.pickupCarrierSlug || '').toLowerCase();
  const awb = shipment.awbCode || shipment.nimbusAwb || shipment.delhiveryWaybill || shipment.shadowfaxAwb;
  console.log(`[CARRIER DISPATCH CANCEL] Cancelling carrier order for ${shipment.shipmentId} (Carrier: ${carrierSlug}, AWB: ${awb})`);

  let cancelResult = { success: false, message: 'No provider matched' };

  // 1. NimbusPost
  if (carrierSlug.startsWith('nimbus_') || shipment.nimbusOrderId || shipment.nimbusAwb || (shipment.pickupAggregator && shipment.pickupAggregator.includes('NimbusPost'))) {
    try {
      const { cancelNimbusPostOrder } = require('./nimbuspostService');
      cancelResult = await cancelNimbusPostOrder(awb);
    } catch (npErr) {
      console.warn('[CARRIER CANCEL] NimbusPost cancel error:', npErr.message);
    }
  } 
  // 2. Delhivery Direct
  else if (carrierSlug.startsWith('delhivery') || shipment.delhiveryWaybill) {
    try {
      const { cancelDelhiveryDirectOrder } = require('./delhiveryService');
      cancelResult = await cancelDelhiveryDirectOrder(shipment.delhiveryWaybill || awb);
    } catch (dlvErr) {
      console.warn('[CARRIER CANCEL] Delhivery Direct cancel error:', dlvErr.message);
    }
  } 
  // 3. Shiprocket
  else if (shipment.shiprocketOrderId || (shipment.pickupAggregator && shipment.pickupAggregator.includes('Shiprocket'))) {
    try {
      const { cancelShiprocketOrder } = require('./shiprocketService');
      cancelResult = await cancelShiprocketOrder(shipment.shiprocketOrderId, awb);
    } catch (srErr) {
      console.warn('[CARRIER CANCEL] Shiprocket cancel error:', srErr.message);
    }
  }

  shipment.pickupStatus = 'Cancelled';
  if (typeof shipment.save === 'function') {
    try {
      await shipment.save();
    } catch (saveErr) {}
  }

  return cancelResult;
};

module.exports = {
  autoScheduleCourierPickup,
  cancelCarrierShipment,
  PICKUP_EXECUTIVES
};
