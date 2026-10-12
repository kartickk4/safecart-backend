/**
 * agentController.js
 * Handles the AI Agent chat state machine, bulk Excel upload parsing,
 * carrier rate comparison, and auto-booking.
 */

const { v4: uuidv4 } = require('uuid');
const XLSX = require('xlsx');
const AgentSession = require('../models/AgentSession');
const BulkJob = require('../models/BulkJob');
const Shipment = require('../models/Shipment');
const User = require('../models/User');
const { getCarrierRates, getPincodeInfo } = require('../services/carrierRateService');
const { autoScheduleCourierPickup } = require('../services/pickupService');
const { sendPaymentLinkWhatsApp, sendBookingConfirmationWhatsApp } = require('../services/whatsappService');
const cashfreeService = require('../services/cashfreeService');
const smsService = require('../services/smsService');
const { createNotification } = require('../services/notification');
const { calculateServiceFee } = require('../utils/feeConfig');

// ── Helpers ───────────────────────────────────────────────────────────────────

const generateShipmentId = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const suffix = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  const num = Math.floor(1000 + Math.random() * 9000);
  return `SPL-${num}-${suffix[0]}`;
};

const fmt = (n) => `₹${new Intl.NumberFormat('en-IN').format(n)}`;

/** Extract 10-digit Indian phone from freetext */
const extractPhone = (text) => {
  const digits = (text || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 10) return digits;
  return null;
};

/** Extract 6-digit pincode from freetext */
const extractPincode = (text) => {
  const match = (text || '').match(/\b\d{6}\b/);
  return match ? match[0] : null;
};

/** Extract weight from freetext (e.g. "1.5 kg", "500g", "2") */
const extractWeight = (text) => {
  const gramsMatch = text.match(/(\d+(?:\.\d+)?)\s*g(?:ram)?s?\b/i);
  if (gramsMatch) return parseFloat(gramsMatch[1]) / 1000;
  const kgMatch = text.match(/(\d+(?:\.\d+)?)\s*k(?:g|ilo)?s?\b/i);
  if (kgMatch) return parseFloat(kgMatch[1]);
  const numMatch = text.match(/^(\d+(?:\.\d+)?)/);
  if (numMatch) return parseFloat(numMatch[1]);
  return null;
};

/** Extract amount/price from freetext */
const extractAmount = (text) => {
  const match = (text || '').match(/(?:₹|rs\.?|inr\.?)?\s*(\d[\d,]*(?:\.\d{1,2})?)/i);
  if (match) return parseFloat(match[1].replace(/,/g, ''));
  return null;
};

/** Extract dimension (L×W×H in cm) from freetext */
const extractDimension = (text) => {
  const match = text.match(/(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)/i);
  if (match) return { l: parseFloat(match[1]), w: parseFloat(match[2]), h: parseFloat(match[3]) };
  return null;
};

/** Extract payment mode (prepaid vs cod) from freetext */
const extractPaymentMode = (text) => {
  const t = (text || '').toLowerCase().trim();
  if (t === '1' || t.includes('prepaid') || t.includes('online') || t.includes('advance') || t.includes('link') || t.includes('escrow') || t.includes('upi')) {
    return 'prepaid';
  }
  if (t === '2' || t.includes('cod') || t.includes('cash on delivery') || t.includes('cash') || t.includes('collect')) {
    return 'cod';
  }
  return null;
};

/** Is this a "yes" answer? */
const isYes = (text) => /^(yes|y|yeah|haan|ok|okay|sure|ha|enable|allow|on)/i.test(text.trim());
/** Is this a "no" answer? */
const isNo  = (text) => /^(no|n|nope|nahi|disable|not|off|naa|final)/i.test(text.trim());

// ── Carrier Quote Formatting ──────────────────────────────────────────────────

const formatCarrierQuotes = (quotes) => {
  return quotes.map((q, i) => {
    const badge = q.isLowest ? ' 🏆 *Cheapest & Auto-Selected*' : '';
    return `${i + 1}. *${q.name}* — ${fmt(q.price)} · ${q.eta}${badge}`;
  }).join('\n');
};

const isReadyToConfirm = (d) => !!(
  d &&
  d.receiverName &&
  d.receiverPhone &&
  d.receiverAddress &&
  d.receiverPincode &&
  d.weightKg &&
  d.amount &&
  d.paymentMode
);

const buildSummaryConfirmation = (session, data, user) => {
  const senderPincode = data.senderPincode || user.pincode || '110001';
  const dims = { length: data.lengthCm || 15, width: data.widthCm || 10, height: data.heightCm || 5 };
  const quotes = getCarrierRates(senderPincode, data.receiverPincode, data.weightKg || 0.5, dims);
  session.carrierQuotes = quotes;
  if (!session.selectedCarrier?.slug) {
    session.selectedCarrier = quotes[0];
  }
  const sel = session.selectedCarrier || quotes[0];
  const isCod = (data.paymentMode === 'cod');
  const modeText = isCod ? '🚚 Cash on Delivery (COD)' : '💳 Prepaid Escrow';
  const rtoText = isCod
    ? '⚠️ Not Available for COD (Prepaid Only)'
    : (data.rtoProtectionEnabled ? '🛡️ Enabled (₹40 Seller Relief)' : 'Disabled');

  const volWeight = parseFloat((((dims.length * dims.width * dims.height) / 5000)).toFixed(2));

  return (
    `📋 *Shipment Summary — Please Confirm:*\n\n` +
    `👤 *Receiver:* ${data.receiverName} (${data.receiverPhone})\n` +
    `📍 *Address:* ${data.receiverAddress}\n` +
    `📮 *Pincode:* ${data.receiverPincode}\n` +
    `📦 *Item:* ${data.description || 'General Merchandise'}\n` +
    `⚖️ *Weight:* ${data.weightKg} kg (Volumetric: ${volWeight} kg, Dims: ${dims.length}×${dims.width}×${dims.height} cm)\n` +
    `💰 *Amount:* ${fmt(data.amount)}\n` +
    `💳 *Payment Mode:* ${modeText}\n` +
    `🛡️ *RTO Protection:* ${rtoText}\n` +
    `↩️ *Returns:* ${data.returnAllowed !== false ? 'Enabled (24h)' : 'Disabled (Final Sale)'}\n` +
    `🚚 *Carrier:* ${sel.name} — ${fmt(sel.price)} · ${sel.eta}\n\n` +
    (isCod 
      ? `*Note for COD:*\n• Courier collects ${fmt(data.amount)} cash/UPI from buyer at delivery\n• Courier fee (${fmt(sel.price)}) + COD handling (₹40) settled via wallet\n• No buyer payment link will be sent ✅\n\n`
      : `*Note for Prepaid Escrow:*\n• Buyer pays via secure Escrow link sent via WhatsApp & SMS\n• Courier pickup is auto-booked once payment is locked\n• Funds released to sender after delivery is confirmed ✅\n\n`) +
    `Type *"confirm"* to book, or *"edit"* to change something.`
  );
};

// ── Step Definitions ─────────────────────────────────────────────────────────

const STEPS = {
  GREETING: 0,
  RECEIVER_NAME: 1,
  RECEIVER_PHONE: 2,
  RECEIVER_ADDRESS: 3,
  RECEIVER_PINCODE: 4,
  PARCEL_DETAILS: 5,
  PARCEL_AMOUNT: 6,
  PAYMENT_MODE: 7,
  RTO_PROTECTION: 8,
  RETURN_POLICY: 9,
  CARRIER_SELECTION: 10,
  CONFIRMATION: 11,
  DONE: 12
};

// ── Step Description Helper (for reminding user of in-progress bookings) ───────

const getStepDescription = (step) => {
  switch (step) {
    case STEPS.RECEIVER_NAME: return { name: 'Receiver Name', prompt: "receiver's full name" };
    case STEPS.RECEIVER_PHONE: return { name: 'Receiver Phone', prompt: "10-digit mobile number" };
    case STEPS.RECEIVER_ADDRESS: return { name: 'Delivery Address', prompt: "full delivery address" };
    case STEPS.RECEIVER_PINCODE: return { name: 'Delivery Pincode', prompt: "6-digit delivery pincode" };
    case STEPS.PARCEL_DETAILS: return { name: 'Parcel Details', prompt: "weight (e.g. 1.5 kg) and description" };
    case STEPS.PARCEL_AMOUNT: return { name: 'Parcel Value', prompt: "order amount in ₹" };
    case STEPS.PAYMENT_MODE: return { name: 'Payment Mode', prompt: "'1' for Prepaid or '2' for COD" };
    case STEPS.RTO_PROTECTION: return { name: 'RTO Protection', prompt: "'yes' or 'no'" };
    case STEPS.RETURN_POLICY: return { name: 'Return Policy', prompt: "'yes' or 'no'" };
    case STEPS.CARRIER_SELECTION: return { name: 'Carrier Selection', prompt: "carrier name or 'confirm'" };
    case STEPS.CONFIRMATION: return { name: 'Confirmation', prompt: "'confirm' to book or 'edit' to modify" };
    default: return { name: 'Shipment Details', prompt: 'details' };
  }
};

// ── Intelligent Query & Problem Solver Engine ─────────────────────────────────

const resolveIntelligentQuery = async (rawMessage, user, session) => {
  const msg = (rawMessage || '').trim();

  // 1. Initial Empty Greeting / Page Load
  if (!msg) {
    // Reset any stale session step so opening the chatbot is always welcoming and never asks for receiver name
    session.step = STEPS.GREETING;
    session.collectedData = user.address ? { senderAddress: user.address } : {};
    session.isEditing = false;
    session.editingField = '';

    const firstName = user.fullName ? user.fullName.split(' ')[0] : 'Merchant';
    return {
      handled: true,
      reply:
        `👋 Hi ${firstName}! I'm *SecureKaro AI Agent* 🚀 — your autonomous logistics partner & intelligent e-commerce problem solver.\n\n` +
        `Here is what I can do for you:\n` +
        `• 📦 *Book a Shipment* — Type parcel details in one go or step-by-step\n` +
        `• 🔍 *Live Tracking* — Type *"track SPL-..."* or ask for your latest order status\n` +
        `• 💰 *Wallet & Payouts* — Ask *"what is my balance?"* to view available & escrow funds\n` +
        `• 🔄 *Replacement Guide* — Ask *"how does replacement work?"* for our 4-step verified flow\n` +
        `• 🛡️ *RTO & Dispute Protection* — Ask about rejected deliveries, damage claims or defect discounts\n` +
        `• 🎁 *Referral Rewards* — Ask *"my referral code"* to check credits & invite merchants\n\n` +
        `How can I assist you right now? Feel free to ask any question, or type *"Book shipment"* to start!`
    };
  }

  // 2. Cancel / Reset / Stop Booking
  if (/^(cancel|stop|abort|exit|quit|cancel booking|stop booking|reset booking)$/i.test(msg)) {
    if (session.step > STEPS.GREETING && session.step < STEPS.DONE) {
      session.step = STEPS.GREETING;
      session.collectedData = user.address ? { senderAddress: user.address } : {};
      session.isEditing = false;
      session.editingField = '';
      return {
        handled: true,
        reply: `🛑 *Booking draft cancelled.*\n\nI'm ready for anything else! You can ask questions, track shipments, check your wallet, or type *"Book shipment"* whenever you're ready.`
      };
    }
  }

  let intelligentReply = null;

  // 3. Live Tracking / Order Lookup
  const splMatch = msg.match(/\b(SPL-\d+-[A-Z0-9])\b/i);
  const isTrackingQuery = splMatch || /\b(track|tracking|status of|where is my parcel|where is my order|courier status|delivery status|track package|track shipment)\b/i.test(msg);

  if (isTrackingQuery) {
    let shipment = null;
    if (splMatch) {
      const searchId = splMatch[1].toUpperCase();
      shipment = await Shipment.findOne({ shipmentId: searchId, senderId: user._id })
        || await Shipment.findOne({ shipmentId: searchId });
    } else {
      // Find latest shipment of this user
      shipment = await Shipment.findOne({ senderId: user._id }).sort({ createdAt: -1 });
    }

    if (!shipment) {
      intelligentReply = `🔍 *No Shipments Found:*\n\nI couldn't locate any matching shipment records in your account.\n\nType *"Book shipment"* to create your first verified escrow delivery!`;
    } else {
      const s = shipment;
      const isCod = s.paymentMode === 'cod';
      const stageNames = {
        1: 'Awaiting Payment',
        2: 'Payment Locked (Escrow)',
        3: 'In Transit / Pickup Scheduled',
        4: 'Delivered (24h Inspection Window)',
        5: 'Funds Released to Seller',
        6: 'Disputed / In Review'
      };
      const stageText = stageNames[s.escrowStage] || s.status;

      let card = 
        `📦 *Live Shipment Telemetry — ${s.shipmentId}*\n\n` +
        `• *Current Status:* *${s.status}* (${stageText})\n` +
        `• *Receiver:* ${s.receiverName} (${s.receiverPhone})\n` +
        `• *Destination:* ${s.city || s.receiverPincode || 'In Transit'}\n` +
        `• *Item & Value:* ${s.description || 'General Merchandise'} — ${fmt(s.amount)} (${isCod ? '🚚 COD' : '💳 Prepaid Escrow'})\n` +
        `• *Carrier Partner:* ${s.carrierSlug ? s.carrierSlug.toUpperCase() : 'Delhivery'} | *AWB:* \`${s.awbCode || 'Pending Pickup'}\`\n`;

      if (s.pickupSlot) {
        card += `• *Pickup Window:* ${s.pickupSlot}\n`;
      }

      if (s.status === 'Awaiting Payment' && s.paymentLink) {
        card += `\n🔗 *Buyer Payment Link:*\n${s.paymentLink}\n_(Buyer can pay via UPI or card to lock escrow funds)_\n`;
      }

      if (s.returnStatus && s.returnStatus !== 'None') {
        card += `\n↩️ *Return/Replacement Status:* *${s.returnStatus}*\n`;
        if (s.returnType === 'replacement') {
          card += 
            `🔄 *4-Step Replacement Milestones:*\n` +
            `• Step 1: Buyer Request — ✅ Verified\n` +
            `• Step 2: Reverse Pickup — ${s.replacementPickupAwbCode ? '✅ (' + s.replacementPickupAwbCode + ')' : '⏳ Scheduled'}\n` +
            `• Step 3: Seller Inspection — ${s.oldItemReceivedBySupplier ? '✅ Confirmed by Merchant' : '⏳ Awaiting Old Parcel Delivery'}\n` +
            `• Step 4: New Parcel Delivery — ${s.replacementDelivered ? '✅ Delivered to Buyer' : (s.replacementItemDispatched ? '🚚 In Transit' : 'Pending Old Parcel Inspection')}\n`;
        } else if (s.returnType === 'partial_discount') {
          card += `• Defect Discount Offered: ₹${s.discountOfferedAmount || 0} (${s.discountAccepted ? '✅ Accepted by Buyer' : 'Pending Buyer Acceptance'})\n`;
        }
      }

      intelligentReply = card;
    }
  }

  // 4. Wallet, Balance & Payouts Query
  else if (/\b(wallet|balance|payout|withdraw|earnings|payouts|my money|account balance|available balance|cashfree)\b/i.test(msg)) {
    const currentUser = await User.findById(user._id) || user;
    const activeEscrowShipments = await Shipment.find({
      senderId: user._id,
      escrowStage: { $in: [2, 3, 4] }
    });
    const lockedEscrow = activeEscrowShipments.reduce((sum, s) => sum + (s.amount || 0), 0);
    const available = currentUser.walletBalance || 0;
    const withdrawn = currentUser.totalWithdrawn || 0;

    intelligentReply =
      `💰 *Your Live Wallet & Earnings Summary:*\n\n` +
      `💼 *Available Withdrawable Balance:* *${fmt(available)}*\n` +
      `🔒 *Locked in Active Escrow:* *${fmt(lockedEscrow)}* (${activeEscrowShipments.length} in-transit orders)\n` +
      `📈 *Lifetime Total Withdrawn:* *${fmt(withdrawn)}*\n\n` +
      `⚡ *How Cashfree Payouts Work:*\n` +
      `• Once a parcel is delivered and the 24-hour buyer inspection window ends, escrow funds auto-credit to your Available Balance.\n` +
      `• Navigate to the *Wallet* tab in the left menu and tap *Withdraw Funds* for instant IMPS / UPI bank payout.`;
  }

  // 5. Recent Orders / Orders Health Query
  else if (/\b(recent orders|my orders|all orders|active shipments|order health|order list|list orders|check orders)\b/i.test(msg)) {
    const recent = await Shipment.find({ senderId: user._id }).sort({ createdAt: -1 }).limit(5);
    if (!recent || recent.length === 0) {
      intelligentReply = `📦 *No Orders Found:*\n\nYou don't have any recent shipments. Type *"Book shipment"* to send a parcel!`;
    } else {
      let ordersList = `📊 *Your Recent Shipments & Order Health (Last 5):*\n\n`;
      recent.forEach((o, i) => {
        let flag = '✅ Normal';
        if (o.status === 'Disputed') flag = '🚨 Action Needed: Dispute in Review';
        else if (o.status === 'Return Requested') flag = '↩️ Action Needed: Return Requested';
        else if (o.status === 'Replacement Requested') flag = '🔄 Action Needed: Replacement Requested';
        else if (o.status === 'Awaiting Payment') flag = '⏳ Awaiting Buyer Escrow Payment';
        else if (o.status === 'Pending Pickup') flag = '📦 Courier Pickup Scheduled';
        else if (o.status === 'Delivered') flag = '🎉 Delivered (Inspection Active)';

        ordersList += `${i + 1}. *${o.shipmentId}* — ${fmt(o.amount)} (${o.receiverName})\n   • Status: ${o.status}\n   • Note: ${flag}\n\n`;
      });
      ordersList += `Type *"track SPL-..."* to inspect full tracking for any of these parcels!`;
      intelligentReply = ordersList;
    }
  }

  // 6. Replacement Flow Problem Solver
  else if (/\b(replacement|replace|swap item|exchange item|replace old item|how does replacement work|replacement policy|replacement flow|damaged item)\b/i.test(msg)) {
    intelligentReply =
      `🔄 *How SecureKaro 4-Step Verified Replacement Works:*\n\n` +
      `To protect sellers from fraud and fake swaps, SecureKaro enforces an inspection-first protocol:\n\n` +
      `1️⃣ *Step 1 — Buyer Request:*\nBuyer initiates the replacement request with photos/video demonstrating the defect or sizing mismatch.\n\n` +
      `2️⃣ *Step 2 — Reverse Courier Pickup:*\nOur automated system schedules a reverse courier to pick up the defective item from the buyer and route it back to your warehouse.\n\n` +
      `3️⃣ *Step 3 — Seller Inspection & Confirmation:*\nYou receive the old parcel, verify that it matches the original item, and click *'Confirm Old Item Received & Approve Replacement'* in the portal.\n\n` +
      `4️⃣ *Step 4 — New Replacement Delivered:*\nYou dispatch the replacement unit. When delivered, buyer verifies it, and the escrow funds are safely released to you! ✅\n\n` +
      `💡 *Why this protects you:* You NEVER send a replacement blind before inspecting the returned parcel first!`;
  }

  // 7. Defect Partial Discount Problem Solver
  else if (/\b(partial discount|defect discount|partial refund|minor defect|small damage|cosmetic flaw|save return cost)\b/i.test(msg)) {
    intelligentReply =
      `⚡ *Defect Partial Discount — Save Reverse Courier Costs:*\n\n` +
      `If a buyer reports a minor issue (stitching flaw, slight cosmetic scratch, or minor sizing):\n\n` +
      `• A physical return would cost you ₹80–₹150 in reverse shipping, plus courier transit wear.\n` +
      `• Instead, SecureKaro allows you to offer a *Partial Discount (e.g. 15% – 30%)* directly through Escrow.\n` +
      `• *Buyer Accepts in 1-Click:* The discount is refunded to the buyer immediately, and the remaining balance is paid directly to your wallet.\n` +
      `• Result: Sale is saved, zero reverse shipping fees, and zero return transit risk! 🎯`;
  }

  // 8. RTO & Rejected Delivery Protection
  else if (/\b(rto|undelivered|courier return)\b|reject(ed|s|ion)?|refus(ed|es|al)?/i.test(msg)) {
    intelligentReply =
      `🛡️ *SecureKaro Smart RTO & Undelivered Protection:*\n\n` +
      `• *Prepaid Escrow Orders:* When RTO Protection is enabled, SecureKaro credits *₹40 seller relief compensation* directly to your wallet if a courier marks the parcel RTO due to buyer rejection.\n` +
      `• *Delivery Verification:* Couriers are required to attempt delivery up to 3 times with OTP and geo-tagged proof.\n` +
      `• *Anti-Fraud Network:* Buyers who serially reject 3+ parcels across our merchant network are blacklisted and charged a fair-play deposit on future orders.\n` +
      `• *Note on COD:* RTO relief is exclusively for Prepaid Escrow orders since prepaid buyers have committed financial escrow.`;
  }

  // 9. Escrow 24-Hour Inspection Window & Safety Rules
  else if (/\b(escrow|how does escrow work|24 hours|24h window|inspection window|when will i get paid|release payment|payout time)\b/i.test(msg)) {
    intelligentReply =
      `🔒 *How SecureKaro Escrow Protects Merchants & Buyers:*\n\n` +
      `1. *Advance Lock:* Buyer pays into 100% RBI-compliant Cashfree Escrow before courier pickup.\n` +
      `2. *Safe Transit:* Funds remain locked while Delhivery/DTDC/Shadowfax delivers the parcel.\n` +
      `3. *24-Hour Inspection Window:* Once marked 'Delivered', the buyer has 24 hours to inspect the package.\n` +
      `4. *Auto-Release:* The buyer can click 'Confirm & Release' anytime for instant payout. If they don't report an issue within 24 hours, SecureKaro *automatically releases 100% of the funds* into your merchant wallet!\n` +
      `5. *Instant Withdrawal:* Transfer from your wallet to any verified Bank Account or UPI ID instantly.`;
  }

  // 10. Return Fraud, Disputes & Unboxing Evidence
  else if (/\b(fraud|dispute|fake return|empty box|wrong item|scam|cheated|file claim|arbitration|disputed)\b/i.test(msg)) {
    intelligentReply =
      `🚨 *How to Handle Disputes & Prevent Return Fraud:*\n\n` +
      `If a buyer attempts a fraudulent return (e.g. sending back an empty box, bricks, or used clothes):\n\n` +
      `1️⃣ *Always Record Unboxing Video:* When receiving any return parcel from the courier executive, film an uncut 360° unboxing video showing the shipping label and parcel contents.\n` +
      `2️⃣ *Raise a Dispute in SecureKaro:* Go to the shipment in your portal, open details, and click *'Raise Dispute / File Claim'*.\n` +
      `3️⃣ *Upload Evidence:* Attach photos of the package and your unboxing video link.\n` +
      `4️⃣ *Arbitration & Compensation:* Our arbitration team compares carrier origin/return weight manifests. When fraud is verified, the buyer's claim is denied and the seller is fully compensated from the escrow!`;
  }

  // 11. Referral Code & Refer & Earn
  else if (/\b(referral|referral code|refer a friend|invite|refer and earn|my code|promo code)\b/i.test(msg)) {
    const currentUser = await User.findById(user._id) || user;
    const refCode = currentUser.referralCode || 'SK-GROW';
    const credits = currentUser.referralCredits || 0;
    const totalEarned = currentUser.totalReferralEarned || 0;

    intelligentReply =
      `🎁 *Your Refer & Earn Program:*\n\n` +
      `• *Your Personal Referral Code:* \`${refCode}\`\n` +
      `• *Available Referral Credits:* ₹${credits}\n` +
      `• *Lifetime Referral Earnings:* ₹${totalEarned}\n\n` +
      `📢 *How it works:*\n` +
      `Share your referral code with other D2C, Instagram or WhatsApp sellers. When they sign up and complete their first verified delivery, both of you earn credits towards your Pro shipping tier!`;
  }

  // 12. General Problem / Issue / Support Inquiry
  // 12. Live Support Helpline Escalation & Dissatisfaction Handler (LAST RESORT ONLY)
  else if (/\b(not satisfied|not satisfy|unsatisfied|not working|not resolved|unresolved|didn't solve|not solved|unsolved|problem not solved|cannot solve|can't solve|didn't resolve|still have|still problem|cannot resolve|can't resolve|call support|talk to human|human agent|call customer|customer care|customer support|helpline|support number|support phone|call helpline|live support|contact support|phone number|call now)\b/i.test(msg)) {
    intelligentReply =
      `📞 *Need Direct Live Human Assistance?*\n\n` +
      `If the issue is still unresolved or you would like to speak directly with our team, our dedicated merchant support specialists are on standby to resolve it immediately:\n\n` +
      `• ☎️ *Toll-Free Helpline:* *1800-123-SAFE (7233)*\n` +
      `• 📱 *Direct Merchant Desk / WhatsApp:* *+91 98765 43210*\n` +
      `• 📧 *Email Support Desk:* *support@securekaro.app*\n` +
      `• ⏰ *Operating Hours:* Mon - Sat: 9:00 AM – 9:00 PM IST\n\n` +
      `Our officers have full override access to unlock stuck escrow, expedite courier pickups, and review return unboxing disputes directly.`;

    if (session.step > STEPS.GREETING && session.step < STEPS.DONE) {
      const stepInfo = getStepDescription(session.step);
      intelligentReply += `\n\n────────────────────\n📦 *Shipment in progress:* We were at step: *${stepInfo.name}*.\nPlease reply with the *${stepInfo.prompt}* to continue booking, or type *"cancel"* to abort.`;
    }
    return { handled: true, reply: intelligentReply, showSupport: true };
  }

  // 13. General Problem / Issue / Support Inquiry (AI tries to solve first)
  else if (/\b(problem|issue|trouble|help me|facing an issue|have a problem|facing problem|something went wrong|stuck|complaint)\b/i.test(msg)) {
    intelligentReply =
      `🤝 *I am here to solve it! What kind of issue are you facing?*\n\n` +
      `1️⃣ 🔄 *Replacement or Returns:* Buyer requested a replacement, exchange, or return?\n` +
      `2️⃣ 🚚 *Courier Delivery or RTO:* Delivery delayed, courier marked rejection, or pickup pending?\n` +
      `3️⃣ 💰 *Wallet & Escrow Payout:* Funds not credited, or questions on Cashfree withdrawal?\n` +
      `4️⃣ ⚡ *Defect Partial Discount:* Want to offer a 15%–30% discount to avoid return shipping fees?\n` +
      `5️⃣ 🚨 *Buyer Dispute or Fraud:* Wrong item returned or unboxing proof dispute?\n\n` +
      `Please tell me what happened (or provide your tracking ID e.g. *SPL-...*) and I will resolve it with you!`;
  }

  // 14. General Greetings & Capabilities Overview
  else if (/^(hi|hello|hey|namaste|greetings|help|who are you|what can you do|features)$/i.test(msg)) {
    const firstName = user.fullName ? user.fullName.split(' ')[0] : 'Merchant';
    intelligentReply =
      `👋 Hi ${firstName}! I am your **SecureKaro AI Logistics Assistant & Problem Solver** 🚀\n\n` +
      `I can help you with:\n` +
      `• 📦 *Booking Shipments:* Step-by-step or paste all parcel details in one sentence\n` +
      `• 🔍 *Live Tracking:* Just ask *"track SPL-..."* to see parcel milestones and courier status\n` +
      `• 💰 *Wallet & Payouts:* Ask *"what is my balance?"* to check available & locked funds\n` +
      `• 🔄 *Replacements & Returns:* Ask about our 4-step verified replacement flow\n` +
      `• 🛡️ *Dispute & Fraud Protection:* Ask how unboxing arbitration safeguards your money\n` +
      `• 🎁 *Referral Code:* Ask *"my referral code"* to share with fellow sellers\n\n` +
      `What would you like to do right now?`;
  }

  if (intelligentReply) {
    // If the user was in the middle of a booking, append context so they can resume
    if (session.step > STEPS.GREETING && session.step < STEPS.DONE) {
      const stepInfo = getStepDescription(session.step);
      intelligentReply += `\n\n────────────────────\n📦 *Shipment in progress:* We were at step: *${stepInfo.name}*.\nPlease reply with the *${stepInfo.prompt}* to continue booking, or type *"cancel"* to abort.`;
    }
    return { handled: true, reply: intelligentReply, showSupport: false };
  }

  return null;
};

// ── Chat Handler (One Turn) ────────────────────────────────────────────────────

const handleChat = async (req, res) => {
  try {
    const { message = '', sessionId } = req.body;
    const userId = req.user._id;
    const user   = req.user;

    // Load or create session
    let session;
    if (sessionId) {
      session = await AgentSession.findOne({ sessionId, userId });
    }
    if (!session) {
      session = new AgentSession({
        sessionId: uuidv4(),
        userId,
        step: STEPS.GREETING,
        messages: []
      });
      // Pre-fill sender address from user profile if available
      if (user.address) {
        session.collectedData.senderAddress = user.address;
      }
    }

    const isEcommerce = (user.platformType === 'ecommerce');

    // Save user message to history
    if (message.trim()) {
      session.messages.push({ role: 'user', content: message.trim() });
    }

    // ── Check Intelligent Query & Problem Solver First ──────────────────────────
    const queryResult = await resolveIntelligentQuery(message, user, session);
    if (queryResult) {
      const agentReply = queryResult.reply;
      session.messages.push({ role: 'agent', content: agentReply });
      session.markModified('messages');
      try {
        await session.save();
      } catch (saveErr) {
        console.warn('[AGENT] session.save warning:', saveErr.message);
      }

      return res.json({
        sessionId: session.sessionId,
        step: session.step,
        reply: agentReply,
        carrierQuotes: session.step === STEPS.CARRIER_SELECTION ? session.carrierQuotes : undefined,
        selectedCarrier: session.selectedCarrier,
        collectedData: session.collectedData,
        createdShipmentId: session.createdShipmentId,
        showSupport: !!queryResult.showSupport
      });
    }

    let agentReply = '';
    const data = session.collectedData;

    switch (session.step) {

      // ── STEP 0: GREETING ─────────────────────────────────────────────────
      case STEPS.GREETING: {
        const lowerMsg = (message || '').toLowerCase().trim();
        const isBookingRequest = /^(book|send|create|new|start|dispatch)\s*(a\s*)?(shipment|parcel|order|courier|delivery)?$/i.test(lowerMsg)
          || lowerMsg === 'book' || lowerMsg === 'send parcel' || lowerMsg === 'book shipment' || lowerMsg === 'new shipment' || lowerMsg === 'book new shipment';

        // Check if user pasted a 1-shot multi-field booking string (contains phone AND pincode)
        const embeddedPhone = extractPhone(message);
        const embeddedPincode = extractPincode(message);
        const embeddedWeight = extractWeight(message);
        const embeddedAmount = extractAmount(message);
        const embeddedMode = extractPaymentMode(message);

        if (embeddedPhone && embeddedPincode) {
          data.receiverPhone = embeddedPhone;
          data.receiverPincode = embeddedPincode;
          if (embeddedWeight) data.weightKg = embeddedWeight;
          if (embeddedAmount) data.amount = embeddedAmount;
          if (embeddedMode) data.paymentMode = embeddedMode;
          
          // Try to extract name (e.g. "to Rahul" or words at start)
          const nameMatch = message.match(/(?:to|receiver:?)\s*([A-Za-z\s]{2,30})/i);
          if (nameMatch) {
            data.receiverName = nameMatch[1].trim();
          }

          if (isReadyToConfirm(data)) {
            const senderPincode = data.senderPincode || user.pincode || '110001';
            const dims = { length: data.lengthCm || 15, width: data.widthCm || 10, height: data.heightCm || 5 };
            const quotes = getCarrierRates(senderPincode, data.receiverPincode, data.weightKg || 0.5, dims);
            session.carrierQuotes = quotes;
            session.selectedCarrier = quotes[0];
            agentReply = `🎯 Parsed all details from your message! ✅\n\n` + buildSummaryConfirmation(session, data, user);
            session.step = STEPS.CONFIRMATION;
            break;
          }

          // If some fields are missing, ask for the first missing field
          if (!data.receiverName) {
            agentReply = `📦 Captured phone (*${embeddedPhone}*) and pincode (*${embeddedPincode}*)! ✅\n\n*What is the receiver's full name?*`;
            session.step = STEPS.RECEIVER_NAME;
            break;
          }
          if (!data.receiverAddress) {
            agentReply = `📦 Receiver *${data.receiverName}* (${embeddedPhone}) saved! ✅\n\n*What is their complete street delivery address?*`;
            session.step = STEPS.RECEIVER_ADDRESS;
            break;
          }
          if (!data.amount) {
            agentReply = `📦 Address and details saved! ✅\n\n*What is the parcel value / order amount? (in ₹)*`;
            session.step = STEPS.PARCEL_AMOUNT;
            break;
          }
          if (!data.paymentMode) {
            agentReply = `💰 Amount saved! ✅\n\n*What is the payment mode?*\n1. 💳 *Prepaid Escrow*\n2. 🚚 *COD (Cash on Delivery)*`;
            session.step = STEPS.PAYMENT_MODE;
            break;
          }
        }

        if (isBookingRequest) {
          agentReply =
            `Great! Let's book your shipment 🚀\n\n` +
            `*What is the receiver's full name?*\n\n` +
            `💡 _Pro Tip: You can also paste all details in a single sentence, e.g.:\n"1.5kg kurta to Rahul, 9876543210, 12 MG Rd Bangalore 560001, Rs 1200, prepaid"_`;
          session.step = STEPS.RECEIVER_NAME;
          break;
        }

        // Fallback guidance
        agentReply =
          `I am ready to help! What would you like to do?\n\n` +
          `• 📦 *Book a shipment:* Type *"Book shipment"* or paste order details\n` +
          `• 🔍 *Track a parcel:* Type *"track SPL-..."* or *"where is my order"*\n` +
          `• 💰 *Check wallet:* Type *"my wallet"* or *"balance"*\n` +
          `• 🔄 *Replacement guidance:* Type *"how does replacement work"*\n` +
          `• 🛡️ *RTO & Dispute rules:* Type *"rto protection"*\n\n` +
          `Or describe any problem you are facing!`;
        break;
      }

      // ── STEP 1: RECEIVER NAME ────────────────────────────────────────────
      case STEPS.RECEIVER_NAME: {
        const name = (message || '').trim();
        if (name.length < 2) {
          agentReply = `⚠️ Please enter a valid name (at least 2 characters).\n\n*Receiver's full name?*`;
          break;
        }
        data.receiverName = name;
        if (session.isEditing || isReadyToConfirm(data)) {
          session.isEditing = false;
          session.editingField = '';
          agentReply = `👤 Receiver updated to: *${name}* ✅\n\n` + buildSummaryConfirmation(session, data, user);
          session.step = STEPS.CONFIRMATION;
          break;
        }
        agentReply = `Got it! Receiver: *${name}* ✅\n\n*What is their 10-digit WhatsApp/mobile number?*`;
        session.step = STEPS.RECEIVER_PHONE;
        break;
      }

      // ── STEP 2: RECEIVER PHONE ───────────────────────────────────────────
      case STEPS.RECEIVER_PHONE: {
        const phone = extractPhone(message);
        if (!phone) {
          agentReply = `⚠️ I need a valid 10-digit Indian mobile number.\n\nExample: *9876543210*\n\n*Receiver's phone number?*`;
          break;
        }
        data.receiverPhone = phone;
        if (session.isEditing || isReadyToConfirm(data)) {
          session.isEditing = false;
          session.editingField = '';
          agentReply = `📱 Phone number updated to: *${phone}* ✅\n\n` + buildSummaryConfirmation(session, data, user);
          session.step = STEPS.CONFIRMATION;
          break;
        }
        agentReply = `📱 Phone: *${phone}* ✅\n\n*What is the receiver's full delivery address?*\n_(Include street, area, city)_`;
        session.step = STEPS.RECEIVER_ADDRESS;
        break;
      }

      // ── STEP 3: RECEIVER ADDRESS ─────────────────────────────────────────
      case STEPS.RECEIVER_ADDRESS: {
        const address = (message || '').trim();
        if (address.length < 5) {
          agentReply = `⚠️ Please enter a complete address (street, area, city).\n\nExample: *12 MG Road, Koramangala, Bangalore*\n\n*Delivery address?*`;
          break;
        }
        data.receiverAddress = address;

        // Auto-extract 6-digit pincode if present in the address
        const embeddedPin = extractPincode(address);
        if (embeddedPin) {
          data.receiverPincode = embeddedPin;
          const senderPincode = data.senderPincode || user.pincode || '110001';
          const dims = { length: data.lengthCm || 15, width: data.widthCm || 10, height: data.heightCm || 5 };
          const quotes = getCarrierRates(senderPincode, data.receiverPincode, data.weightKg || 0.5, dims);
          session.carrierQuotes = quotes;
          session.selectedCarrier = quotes[0];
        }

        if (session.isEditing || isReadyToConfirm(data)) {
          session.isEditing = false;
          session.editingField = '';
          agentReply = `📍 Address updated to: *${address}* ✅\n\n` + buildSummaryConfirmation(session, data, user);
          session.step = STEPS.CONFIRMATION;
          break;
        }
        agentReply = `📍 Address saved ✅\n\n*What is the delivery pincode?*`;
        session.step = STEPS.RECEIVER_PINCODE;
        break;
      }

      // ── STEP 4: RECEIVER PINCODE ─────────────────────────────────────────
      case STEPS.RECEIVER_PINCODE: {
        const pincode = extractPincode(message);
        if (!pincode) {
          agentReply = `⚠️ Please enter a valid 6-digit pincode.\n\nExample: *560001*\n\n*Delivery pincode?*`;
          break;
        }
        data.receiverPincode = pincode;

        const senderPincode = data.senderPincode || user.pincode || '110001';
        const dims = { length: data.lengthCm || 15, width: data.widthCm || 10, height: data.heightCm || 5 };
        const quotes = getCarrierRates(senderPincode, data.receiverPincode, data.weightKg || 0.5, dims);
        session.carrierQuotes = quotes;
        session.selectedCarrier = quotes[0];

        if (session.isEditing || isReadyToConfirm(data)) {
          session.isEditing = false;
          session.editingField = '';
          const pinfo = getPincodeInfo(pincode);
          agentReply = `📮 Pincode updated to: *${pincode}* (${pinfo.label}) ✅\n\n` + buildSummaryConfirmation(session, data, user);
          session.step = STEPS.CONFIRMATION;
          break;
        }
        const pinfo = getPincodeInfo(pincode);
        agentReply = `📮 Pincode: *${pincode}* (${pinfo.label}) ✅\n\n*Now tell me about the parcel:*\n\n• Weight? (e.g. "1.5 kg" or "500g")\n• Dimensions? (Length × Width × Height in cm, e.g. "20x15x10 cm")\n• Item description? (e.g. "Blue Cotton Kurta")\n\n_You can type all together, like: "1kg, 20x15x10, cotton kurta"_`;
        session.step = STEPS.PARCEL_DETAILS;
        break;
      }

      // ── STEP 5: PARCEL DETAILS (weight + dimensions + description) ────────
      case STEPS.PARCEL_DETAILS: {
        const weight = extractWeight(message);
        const dims   = extractDimension(message);
        
        // Extract description: remove numbers and units, clean up
        const descClean = message
          .replace(/\d+(?:\.\d+)?\s*(?:kg|kilo|gram|g|cm|x|×|\*)/gi, '')
          .replace(/,/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

        const missing = [];
        if (!weight && !data.weightKg) missing.push('weight (e.g. "1.5 kg")');
        if ((!descClean || descClean.length < 3) && (!data.description || data.description.length < 3)) {
          missing.push('item description (e.g. "Blue Kurta")');
        }

        if (missing.length > 0) {
          agentReply = `⚠️ I'm missing: *${missing.join(', ')}*\n\nPlease provide:\n• Weight (e.g. "1.5 kg")\n• Dimensions (optional, e.g. "20x15x10 cm")\n• Item description (e.g. "Blue Cotton Kurta")`;
          break;
        }

        if (weight && weight > 0) data.weightKg = weight;
        if (dims) {
          data.lengthCm = dims.l;
          data.widthCm  = dims.w;
          data.heightCm = dims.h;
        }
        if (descClean && descClean.length >= 3) {
          data.description = descClean.substring(0, 200);
        }

        if (data.receiverPincode) {
          const senderPincode = data.senderPincode || user.pincode || '110001';
          const currentDims = { length: data.lengthCm || 15, width: data.widthCm || 10, height: data.heightCm || 5 };
          const quotes = getCarrierRates(senderPincode, data.receiverPincode, data.weightKg || 0.5, currentDims);
          session.carrierQuotes = quotes;
          session.selectedCarrier = quotes[0];
        }

        if (session.isEditing || isReadyToConfirm(data)) {
          session.isEditing = false;
          session.editingField = '';
          agentReply = `📦 Parcel details updated ✅\n\n` + buildSummaryConfirmation(session, data, user);
          session.step = STEPS.CONFIRMATION;
          break;
        }

        const volKg = ((data.lengthCm * data.widthCm * data.heightCm) / 5000).toFixed(2);
        const dimStr = `${data.lengthCm}×${data.widthCm}×${data.heightCm} cm (Volumetric: ${volKg} kg)`;
        agentReply = `📦 Parcel Details Saved ✅\n• Actual Weight: *${data.weightKg} kg*\n• Dimensions: *${dimStr}*\n• Item: *${data.description}*\n\n*What is the parcel value / order amount? (in ₹)*`;
        session.step = STEPS.PARCEL_AMOUNT;
        break;
      }

      // ── STEP 6: PARCEL AMOUNT ────────────────────────────────────────────
      case STEPS.PARCEL_AMOUNT: {
        const amount = extractAmount(message);
        if (!amount || amount < 1) {
          agentReply = `⚠️ Please enter a valid amount in ₹.\n\nExample: *1200* or *₹1,200*\n\n*Parcel value / amount?*`;
          break;
        }
        data.amount = amount;

        if (session.isEditing || isReadyToConfirm(data)) {
          session.isEditing = false;
          session.editingField = '';
          agentReply = `💰 Order value updated to: *${fmt(amount)}* ✅\n\n` + buildSummaryConfirmation(session, data, user);
          session.step = STEPS.CONFIRMATION;
          break;
        }

        agentReply =
          `💰 Order Value: *${fmt(amount)}* saved ✅\n\n` +
          `*What is the payment mode for this shipment?*\n\n` +
          `1. 💳 *Prepaid Escrow* — Buyer pays via secure Escrow link. Courier pickup is auto-booked once payment is locked and paid to sender after delivery is confirmed\n` +
          `2. 🚚 *Cash on Delivery (COD)* — Courier collects payment from buyer at delivery\n\n` +
          `_Reply "1" for Prepaid Escrow or "2" for COD._`;
        session.step = STEPS.PAYMENT_MODE;
        break;
      }

      // ── STEP 7: PAYMENT MODE ─────────────────────────────────────────────
      case STEPS.PAYMENT_MODE: {
        const mode = extractPaymentMode(message);
        if (!mode) {
          agentReply = 
            `⚠️ Please select a valid payment mode:\n\n` +
            `• Reply *"1"* or *"prepaid"* for Prepaid Escrow\n` +
            `• Reply *"2"* or *"cod"* for Cash on Delivery (COD)`;
          break;
        }
        data.paymentMode = mode;
        const isCod = mode === 'cod';

        if (isCod) {
          data.rtoProtectionEnabled = false; // RTO Protection is strictly unavailable for COD
          const modeNote = `💵 Payment Mode: *Cash on Delivery (COD)* ✅\n_(RTO Protection is not available for COD orders — exclusive to Prepaid Escrow)_\n\n`;

          if (session.isEditing || isReadyToConfirm(data)) {
            session.isEditing = false;
            session.editingField = '';
            agentReply = modeNote + buildSummaryConfirmation(session, data, user);
            session.step = STEPS.CONFIRMATION;
            break;
          }

          const dims = { length: data.lengthCm || 15, width: data.widthCm || 10, height: data.heightCm || 5 };

          if (isEcommerce) {
            data.returnAllowed = true;
            session.step = STEPS.CARRIER_SELECTION;
            const senderPincode = data.senderPincode || user.pincode || '110001';
            const quotes = getCarrierRates(senderPincode, data.receiverPincode, data.weightKg, dims);
            session.carrierQuotes = quotes;
            session.selectedCarrier = quotes[0]; // Auto-select cheapest

            agentReply =
              modeNote +
              `_(E-commerce seller — Returns automatically enabled ✅)_\n\n` +
              `🚚 *Carrier Price Comparison:*\n\n` +
              `${formatCarrierQuotes(quotes)}\n\n` +
              `The *cheapest carrier (${quotes[0].name})* has been auto-selected.\n` +
              `Want to change? Reply with the number (1-${quotes.length}) or type the carrier name.\n` +
              `Or type *"ok"* / *"confirm"* to proceed with ${quotes[0].name}.`;
          } else {
            agentReply = modeNote + `*Should returns be allowed for this parcel?*\n\n✅ Yes — Buyer can return within 24h after delivery (Recommended)\n❌ No — Final sale, no returns`;
            session.step = STEPS.RETURN_POLICY;
          }
        } else {
          // Prepaid:
          if (session.isEditing || isReadyToConfirm(data)) {
            session.isEditing = false;
            session.editingField = '';
            agentReply = `💳 Payment Mode: *Prepaid Escrow* ✅\n\n` + buildSummaryConfirmation(session, data, user);
            session.step = STEPS.CONFIRMATION;
            break;
          }

          // Prepaid initial questionnaire: ask for RTO Protection!
          session.step = STEPS.RTO_PROTECTION;
          agentReply =
            `💳 Payment Mode: *Prepaid Escrow* ✅\n\n` +
            `🛡️ *Enable Smart RTO & Undelivered Protection?*\n\n` +
            `If the buyer refuses or fails to accept delivery:\n` +
            `• SecureKaro compensates you *₹40* relief per rejected parcel\n` +
            `• Repeat serial rejectors (3+ rejections/week) pay a fair-play fee\n\n` +
            `Reply *"yes"* to enable RTO Protection or *"no"* to skip.`;
        }
        break;
      }

      // ── STEP 8: RTO & UNDELIVERED PROTECTION (prepaid only) ──────────────
      case STEPS.RTO_PROTECTION: {
        const msg = (message || '').trim();
        if (isYes(msg)) {
          data.rtoProtectionEnabled = true;
          agentReply = `🛡️ RTO Protection: *Active* ✅ (₹40 seller compensation on delivery rejection)\n\n`;
        } else if (isNo(msg)) {
          data.rtoProtectionEnabled = false;
          agentReply = `🛡️ RTO Protection: *Disabled* ❌\n\n`;
        } else {
          agentReply = `Please reply *"yes"* to enable RTO protection or *"no"* to skip.\n\n*Enable Smart RTO Protection?*`;
          break;
        }

        if (session.isEditing || (isReadyToConfirm(data) && session.carrierQuotes?.length > 0)) {
          session.isEditing = false;
          session.editingField = '';
          agentReply += buildSummaryConfirmation(session, data, user);
          session.step = STEPS.CONFIRMATION;
          break;
        }

        const dims = { length: data.lengthCm || 15, width: data.widthCm || 10, height: data.heightCm || 5 };

        if (isEcommerce) {
          data.returnAllowed = true;
          session.step = STEPS.CARRIER_SELECTION;
          const senderPincode = data.senderPincode || user.pincode || '110001';
          const quotes = getCarrierRates(senderPincode, data.receiverPincode, data.weightKg, dims);
          session.carrierQuotes = quotes;
          session.selectedCarrier = quotes[0]; // Auto-select cheapest

          agentReply +=
            `_(E-commerce seller — Returns automatically enabled ✅)_\n\n` +
            `🚚 *Carrier Price Comparison:*\n\n` +
            `${formatCarrierQuotes(quotes)}\n\n` +
            `The *cheapest carrier (${quotes[0].name})* has been auto-selected.\n` +
            `Want to change? Reply with the number (1-${quotes.length}) or type the carrier name.\n` +
            `Or type *"ok"* / *"confirm"* to proceed with ${quotes[0].name}.`;
        } else {
          agentReply += `*Should returns be allowed for this parcel?*\n\n✅ Yes — Buyer can return within 24h after delivery (Recommended)\n❌ No — Final sale, no returns`;
          session.step = STEPS.RETURN_POLICY;
        }
        break;
      }

      // ── STEP 9: RETURN POLICY (independent sellers only) ─────────────────
      case STEPS.RETURN_POLICY: {
        const msg = (message || '').trim();
        if (isYes(msg)) {
          data.returnAllowed = true;
          agentReply = `Returns: *Enabled* ✅ (24h buyer protection window)\n\n`;
        } else if (isNo(msg)) {
          data.returnAllowed = false;
          agentReply = `Returns: *Disabled* ❌ (Final sale)\n\n`;
        } else {
          agentReply = `Please reply *"yes"* to allow returns or *"no"* for final sale.\n\n*Allow returns for this parcel?*`;
          break;
        }

        if (session.isEditing || (isReadyToConfirm(data) && session.carrierQuotes?.length > 0)) {
          session.isEditing = false;
          session.editingField = '';
          const retStatus = data.returnAllowed !== false ? 'Enabled (24h Window)' : 'Disabled (Final Sale)';
          agentReply += `↩️ Returns updated to: *${retStatus}* ✅\n\n` + buildSummaryConfirmation(session, data, user);
          session.step = STEPS.CONFIRMATION;
          break;
        }

        // Fetch carrier quotes
        const senderPincode = data.senderPincode || user.pincode || '110001';
        const dims = { length: data.lengthCm || 15, width: data.widthCm || 10, height: data.heightCm || 5 };
        const quotes = getCarrierRates(senderPincode, data.receiverPincode, data.weightKg, dims);
        session.carrierQuotes = quotes;
        session.selectedCarrier = quotes[0]; // Auto-select cheapest

        agentReply +=
          `🚚 *Carrier Price Comparison:*\n\n` +
          `${formatCarrierQuotes(quotes)}\n\n` +
          `The *cheapest carrier (${quotes[0].name})* has been auto-selected.\n` +
          `Want to change? Reply with the number (1-${quotes.length}) or type the carrier name.\n` +
          `Or type *"ok"* / *"confirm"* to proceed with ${quotes[0].name}.`;
        session.step = STEPS.CARRIER_SELECTION;
        break;
      }

      // ── STEP 8: CARRIER SELECTION (with change option) ───────────────────
      case STEPS.CARRIER_SELECTION: {
        const msg = (message || '').trim();
        const lowerMsg = msg.toLowerCase();
        const quotes = session.carrierQuotes || [];

        // Allow direct edits while in carrier selection
        if (lowerMsg === 'name' || lowerMsg === 'edit name') {
          session.step = STEPS.RECEIVER_NAME;
          session.isEditing = true;
          session.editingField = 'name';
          agentReply = `Sure! What is the new *receiver full name*?`;
          break;
        }
        if (lowerMsg === 'phone' || lowerMsg === 'edit phone') {
          session.step = STEPS.RECEIVER_PHONE;
          session.isEditing = true;
          session.editingField = 'phone';
          agentReply = `Sure! What is the new *10-digit mobile number*?`;
          break;
        }
        if (lowerMsg === 'address' || lowerMsg === 'edit address') {
          session.step = STEPS.RECEIVER_ADDRESS;
          session.isEditing = true;
          session.editingField = 'address';
          agentReply = `Sure! What is the new *delivery address*?`;
          break;
        }
        if (lowerMsg === 'pincode' || lowerMsg === 'edit pincode') {
          session.step = STEPS.RECEIVER_PINCODE;
          session.isEditing = true;
          session.editingField = 'pincode';
          agentReply = `Sure! What is the new *6-digit delivery pincode*?`;
          break;
        }
        if (lowerMsg === 'amount' || lowerMsg === 'price' || lowerMsg === 'edit amount') {
          session.step = STEPS.PARCEL_AMOUNT;
          session.isEditing = true;
          session.editingField = 'amount';
          agentReply = `Sure! What is the new *parcel amount / value in ₹*?`;
          break;
        }
        if (lowerMsg === 'mode' || lowerMsg === 'payment' || lowerMsg === 'edit mode' || lowerMsg === 'edit payment') {
          session.step = STEPS.PAYMENT_MODE;
          session.isEditing = true;
          session.editingField = 'mode';
          agentReply = `Sure! What is the new *payment mode*? (Reply *"1"* for Prepaid Escrow or *"2"* for COD):`;
          break;
        }
        if (lowerMsg === 'rto' || lowerMsg === 'edit rto' || lowerMsg === 'toggle rto') {
          if (data.paymentMode === 'cod') {
            agentReply = `⚠️ RTO Protection is not available for COD orders (exclusive to Prepaid Escrow shipments).\n\nTo enable RTO Protection, first switch payment mode to Prepaid Escrow by typing *"edit mode"*.`;
            break;
          }
          data.rtoProtectionEnabled = !data.rtoProtectionEnabled;
          agentReply = `🛡️ RTO Protection updated to: *${data.rtoProtectionEnabled ? 'Active' : 'Disabled'}* ✅\n\n` + buildSummaryConfirmation(session, data, user);
          break;
        }
        if (lowerMsg === 'weight' || lowerMsg === 'dims' || lowerMsg === 'dimensions' || lowerMsg === 'parcel' || lowerMsg === 'edit weight' || lowerMsg === 'edit dims' || lowerMsg === 'edit dimensions') {
          session.step = STEPS.PARCEL_DETAILS;
          session.isEditing = true;
          session.editingField = 'parcel';
          agentReply = `Sure! Please enter the new *parcel weight & dimensions* (e.g. "1.5 kg, 20x15x10 cm, Kurta"):`;
          break;
        }

        // Check if user wants to change carrier
        const numChoice = parseInt(msg);
        const byNumber = !isNaN(numChoice) && numChoice >= 1 && numChoice <= quotes.length;
        const byName   = quotes.find(q => q.name.toLowerCase().includes(lowerMsg) || q.slug.toLowerCase().includes(lowerMsg));
        // Accept "confirm courier", "confirm & book", "confirm", "ok", "yes", empty, or any carrier name match
        const confirmed = isYes(msg) || lowerMsg === 'ok' || lowerMsg === 'confirm' || lowerMsg === 'confirm courier' || lowerMsg === 'confirm & book' || !msg;
        // "Change Courier" button → go to carrier selection again (stay in same step, refresh quotes list)
        if (lowerMsg === 'change courier' || lowerMsg === 'change carrier' || lowerMsg === 'carrier') {
          const senderPincode2 = data.senderPincode || user.pincode || '110001';
          const dims2 = { length: data.lengthCm || 15, width: data.widthCm || 10, height: data.heightCm || 5 };
          const freshQuotes = getCarrierRates(senderPincode2, data.receiverPincode, data.weightKg, dims2);
          session.carrierQuotes = freshQuotes;
          agentReply = `🚚 *Choose a carrier:*\n\n${formatCarrierQuotes(freshQuotes)}\n\nReply with number (1-${freshQuotes.length}) or carrier name:`;
          break;
        }

        if (byNumber) {
          session.selectedCarrier = quotes[numChoice - 1];
          if (session.isEditing || isReadyToConfirm(data)) {
            session.isEditing = false;
            session.step = STEPS.CONFIRMATION;
            agentReply = `🚚 Carrier updated to: *${session.selectedCarrier.name}* (${fmt(session.selectedCarrier.price)}) ✅\n\n` + buildSummaryConfirmation(session, data, user);
            break;
          }
          agentReply = `✅ Changed to *${quotes[numChoice - 1].name}* (${fmt(quotes[numChoice - 1].price)})\n\nType *"confirm"* to proceed or pick another carrier.`;
          break;
        } else if (byName && !confirmed) {
          session.selectedCarrier = byName;
          if (session.isEditing || isReadyToConfirm(data)) {
            session.isEditing = false;
            session.step = STEPS.CONFIRMATION;
            agentReply = `🚚 Carrier updated to: *${byName.name}* (${fmt(byName.price)}) ✅\n\n` + buildSummaryConfirmation(session, data, user);
            break;
          }
          agentReply = `✅ Changed to *${byName.name}* (${fmt(byName.price)})\n\nType *"confirm"* to proceed or pick another carrier.`;
          break;
        } else if (!confirmed && msg.length > 0 && !byNumber && !byName) {
          // Unrecognized input
          agentReply = `I didn't understand that. To change carrier, type a number (1-${quotes.length}) or carrier name.\nOr type *"confirm"* / *"ok"* to proceed with *${session.selectedCarrier?.name}*.`;
          break;
        }

        // Show full confirmation summary
        agentReply = buildSummaryConfirmation(session, data, user);
        session.step = STEPS.CONFIRMATION;
        session.isEditing = false;
        break;
      }

      // ── STEP 11: FINAL CONFIRMATION & BOOKING ────────────────────────────
      case STEPS.CONFIRMATION: {
        const msg = (message || '').toLowerCase().trim();

        if (msg === 'edit' || msg === 'change' || msg === 'edit details') {
          agentReply = `No problem! What would you like to change?\n\nType or click:\n• *"edit address"* — delivery address\n• *"edit pincode"* — destination pincode\n• *"edit name"* — receiver name\n• *"edit phone"* — phone number\n• *"edit amount"* — parcel value\n• *"edit mode"* — prepaid or COD\n• *"toggle rto"* — RTO protection\n• *"edit weight"* / *"edit dims"* — parcel weight & dimensions\n• *"change carrier"* — choose courier\n• *"toggle return"* — return policy`;
          break;
        }

        // Individual field edit triggers
        if (msg === 'name' || msg === 'edit name') {
          session.step = STEPS.RECEIVER_NAME;
          session.isEditing = true;
          session.editingField = 'name';
          agentReply = `Sure! What is the new *receiver full name*?`;
          break;
        }
        if (msg === 'phone' || msg === 'edit phone') {
          session.step = STEPS.RECEIVER_PHONE;
          session.isEditing = true;
          session.editingField = 'phone';
          agentReply = `Sure! What is the new *10-digit mobile number*?`;
          break;
        }
        if (msg === 'address' || msg === 'edit address') {
          session.step = STEPS.RECEIVER_ADDRESS;
          session.isEditing = true;
          session.editingField = 'address';
          agentReply = `Sure! What is the new *delivery address*?`;
          break;
        }
        if (msg === 'pincode' || msg === 'edit pincode') {
          session.step = STEPS.RECEIVER_PINCODE;
          session.isEditing = true;
          session.editingField = 'pincode';
          agentReply = `Sure! What is the new *6-digit delivery pincode*?`;
          break;
        }
        if (msg === 'amount' || msg === 'price' || msg === 'edit amount') {
          session.step = STEPS.PARCEL_AMOUNT;
          session.isEditing = true;
          session.editingField = 'amount';
          agentReply = `Sure! What is the new *parcel amount / value in ₹*?`;
          break;
        }
        if (msg === 'mode' || msg === 'payment' || msg === 'edit mode' || msg === 'edit payment') {
          session.step = STEPS.PAYMENT_MODE;
          session.isEditing = true;
          session.editingField = 'mode';
          agentReply = `Sure! What is the new *payment mode*? (Reply *"1"* for Prepaid Escrow or *"2"* for COD):`;
          break;
        }
        if (msg === 'weight' || msg === 'dims' || msg === 'dimensions' || msg === 'parcel' || msg === 'edit weight' || msg === 'edit dims' || msg === 'edit dimensions') {
          session.step = STEPS.PARCEL_DETAILS;
          session.isEditing = true;
          session.editingField = 'parcel';
          agentReply = `Sure! Please enter the new *parcel weight & dimensions* (e.g. "1.5 kg, 20x15x10 cm, Kurta"):`;
          break;
        }
        if (msg === 'carrier' || msg === 'change carrier' || msg === 'change courier' || msg === 'edit carrier') {
          session.step = STEPS.CARRIER_SELECTION;
          session.isEditing = true;
          session.editingField = 'carrier';
          const senderPincode = data.senderPincode || user.pincode || '110001';
          const dims = { length: data.lengthCm || 15, width: data.widthCm || 10, height: data.heightCm || 5 };
          const quotes = getCarrierRates(senderPincode, data.receiverPincode, data.weightKg || 0.5, dims);
          session.carrierQuotes = quotes;
          agentReply = `🚚 *Choose a carrier:*\n\n${formatCarrierQuotes(quotes)}\n\nReply with number (1-${quotes.length}) or carrier name:`;
          break;
        }
        if (msg === 'return' || msg === 'toggle return' || msg === 'edit return') {
          if (isEcommerce) {
            agentReply = `ℹ️ As an e-commerce platform seller (Meesho, Amazon, Flipkart), returns are mandatory and remain *Enabled* ✅ with 24h inspection.\n\nType *"confirm"* to proceed with booking.`;
          } else {
            data.returnAllowed = !data.returnAllowed;
            const retStatus = data.returnAllowed !== false ? 'Enabled (24h)' : 'Disabled (Final Sale)';
            agentReply = `↩️ Returns updated to: *${retStatus}* ✅\n\n` + buildSummaryConfirmation(session, data, user);
          }
          break;
        }
        if (msg.startsWith('return:') || msg.startsWith('returns:') || msg.startsWith('edit return:') || msg.startsWith('edit returns:')) {
          if (isEcommerce) {
            agentReply = `ℹ️ As an e-commerce platform seller (Meesho, Amazon, Flipkart), returns are mandatory and remain *Enabled* ✅ with 24h inspection.\n\nType *"confirm"* to proceed with booking.`;
          } else {
            const rawVal = message.replace(/^(?:edit\s+)?returns?[\s:]+/i, '').trim().toLowerCase();
            if (isYes(rawVal) || rawVal === 'enable' || rawVal === 'enabled' || rawVal === 'true') {
              data.returnAllowed = true;
            } else if (isNo(rawVal) || rawVal === 'disable' || rawVal === 'disabled' || rawVal === 'false') {
              data.returnAllowed = false;
            } else {
              data.returnAllowed = !data.returnAllowed;
            }
            const retStatus = data.returnAllowed !== false ? 'Enabled (24h)' : 'Disabled (Final Sale)';
            agentReply = `↩️ Returns updated to: *${retStatus}* ✅\n\n` + buildSummaryConfirmation(session, data, user);
          }
          break;
        }
        if (msg === 'rto' || msg === 'edit rto' || msg === 'toggle rto') {
          if (data.paymentMode === 'cod') {
            agentReply = `⚠️ RTO Protection is not available for COD orders (exclusive to Prepaid Escrow shipments).\n\nTo enable RTO Protection, first switch payment mode to Prepaid by typing *"edit mode"*.`;
          } else {
            data.rtoProtectionEnabled = !data.rtoProtectionEnabled;
            agentReply = `🛡️ RTO Protection updated to: *${data.rtoProtectionEnabled ? 'Active' : 'Disabled'}* ✅\n\n` + buildSummaryConfirmation(session, data, user);
          }
          break;
        }

        // Handle inline field edits with prefix
        if (msg.startsWith('name:') || msg.startsWith('name ') || msg.startsWith('edit name:') || msg.startsWith('edit name ')) {
          const val = message.replace(/^(?:edit\s+)?name[\s:]+/i, '').trim();
          if (val.length >= 2) { data.receiverName = val; agentReply = `✅ Name updated to *${val}*.\n\n` + buildSummaryConfirmation(session, data, user); break; }
        }
        if (msg.startsWith('phone:') || msg.startsWith('phone ') || msg.startsWith('edit phone:') || msg.startsWith('edit phone ')) {
          const ph = extractPhone(message.replace(/^(?:edit\s+)?phone[\s:]+/i, ''));
          if (ph) { data.receiverPhone = ph; agentReply = `✅ Phone updated to *${ph}*.\n\n` + buildSummaryConfirmation(session, data, user); break; }
        }
        if (msg.startsWith('address:') || msg.startsWith('address ') || msg.startsWith('edit address:') || msg.startsWith('edit address ')) {
          const addr = message.replace(/^(?:edit\s+)?address[\s:]+/i, '').trim();
          if (addr.length >= 5) {
            data.receiverAddress = addr;
            const pin = extractPincode(addr);
            if (pin) {
              data.receiverPincode = pin;
              const senderPincode = data.senderPincode || user.pincode || '110001';
              const dims = { length: data.lengthCm || 15, width: data.widthCm || 10, height: data.heightCm || 5 };
              session.carrierQuotes = getCarrierRates(senderPincode, data.receiverPincode, data.weightKg || 0.5, dims);
              session.selectedCarrier = session.carrierQuotes[0];
            }
            agentReply = `✅ Delivery address updated to *${addr}*.\n\n` + buildSummaryConfirmation(session, data, user);
            break;
          }
        }
        if (msg.startsWith('pincode:') || msg.startsWith('pincode ') || msg.startsWith('edit pincode:') || msg.startsWith('edit pincode ')) {
          const pin = extractPincode(message.replace(/^(?:edit\s+)?pincode[\s:]+/i, ''));
          if (pin) {
            data.receiverPincode = pin;
            const senderPincode = data.senderPincode || user.pincode || '110001';
            const dims = { length: data.lengthCm || 15, width: data.widthCm || 10, height: data.heightCm || 5 };
            session.carrierQuotes = getCarrierRates(senderPincode, data.receiverPincode, data.weightKg || 0.5, dims);
            session.selectedCarrier = session.carrierQuotes[0];
            agentReply = `✅ Pincode updated to *${pin}*.\n\n` + buildSummaryConfirmation(session, data, user);
            break;
          }
        }
        if (msg.startsWith('amount:') || msg.startsWith('amount ') || msg.startsWith('edit amount:') || msg.startsWith('edit amount ')) {
          const amt = extractAmount(message.replace(/^(?:edit\s+)?amount[\s:]+/i, ''));
          if (amt) { data.amount = amt; agentReply = `✅ Amount updated to *${fmt(amt)}*.\n\n` + buildSummaryConfirmation(session, data, user); break; }
        }
        if (msg.startsWith('weight:') || msg.startsWith('weight ') || msg.startsWith('edit weight:') || msg.startsWith('edit weight ')) {
          const w = extractWeight(message.replace(/^(?:edit\s+)?weight[\s:]+/i, ''));
          if (w) {
            data.weightKg = w;
            const senderPincode = data.senderPincode || user.pincode || '110001';
            const dims = { length: data.lengthCm || 15, width: data.widthCm || 10, height: data.heightCm || 5 };
            session.carrierQuotes = getCarrierRates(senderPincode, data.receiverPincode, data.weightKg, dims);
            session.selectedCarrier = session.carrierQuotes[0];
            agentReply = `✅ Weight updated to *${w} kg*.\n\n` + buildSummaryConfirmation(session, data, user);
            break;
          }
        }

        if (!isYes(msg) && msg !== 'confirm' && msg !== 'book' && msg !== 'confirm & book') {
          agentReply = `Please type *"confirm"* to book or *"edit"* to change details.`;
          break;
        }

        if (!user.phone || !user.isPhoneVerified) {
          agentReply = `⚠️ *Phone Verification Required Before First Shipment*\n\nYour mobile number must be verified via OTP before booking shipments on SecureKaro.\n\nPlease open your *Profile Settings* or the *Create Shipment* page to verify your phone number in 30 seconds.`;
          session.step = STEPS.CONFIRMATION;
          break;
        }

        // ── BOOKING ───────────────────────────────────────────────────────
        agentReply = `⏳ *Booking your shipment...* Please wait a moment.`;

        try {
          const sel = session.selectedCarrier || session.carrierQuotes?.[0] || { slug: 'delhivery', name: 'Delhivery', price: 40 };
          const awbCode = `AGT-${sel.slug.toUpperCase().substring(0, 3)}-${Math.floor(1000000000 + Math.random() * 9000000000)}`;
          const shipmentId = generateShipmentId();

          const isCod = (data.paymentMode || 'prepaid') === 'cod';
          const isPrepaidOrder = !isCod;

          let codFeePaid = false;
          let codFeePaymentMethod = 'none';
          let codFeePaidAt = null;
          let codFeeTransactionRef = '';
          let deliveryCharge = sel.price || 40;
          let codCharge = isCod ? 40 : 0;
          let totalCodFees = isCod ? (deliveryCharge + codCharge) : 0;

          const isOffline = data.paymentMode === 'paid_offline';
          const availableWallet = Number(user.walletBalance) || 0;

          // Block COD and Offline Paid booking if seller wallet balance is negative
          if (availableWallet < 0 && (isCod || isOffline)) {
            agentReply = 
              `🚫 *COD / Offline Shipping Suspended — Negative Wallet Balance*\n\n` +
              `Your seller wallet balance is negative (*-₹${Math.abs(availableWallet).toFixed(2)}*).\n\n` +
              `COD and Offline Paid shipment bookings are suspended until outstanding dues are cleared.\n\n` +
              `💡 *How to unlock:* Switch this order to *Prepaid Escrow* by replying *"edit mode"*, or recharge your wallet in the *Wallet* tab.`;
            break;
          }

          // COD Wallet deduction check
          if (isCod) {
            if (availableWallet >= totalCodFees) {
              // Adjust directly from wallet
              user.walletBalance = parseFloat(Math.max(0, availableWallet - totalCodFees).toFixed(2));
              await user.save();

              codFeePaid = true;
              codFeePaymentMethod = 'wallet_adjustment';
              codFeePaidAt = new Date();
              codFeeTransactionRef = 'WAL_' + Date.now();
            } else {
              // Insufficient wallet balance for COD fees
              agentReply = 
                `⚠️ *Insufficient Wallet Balance for COD Shipment*\n\n` +
                `COD booking requires an upfront courier fee of *₹${totalCodFees}* (Courier Delivery: ₹${deliveryCharge} + COD Handling: ₹${codCharge}).\n\n` +
                `💼 *Current Wallet Balance:* ₹${availableWallet}\n` +
                `🔻 *Shortfall:* ₹${totalCodFees - availableWallet}\n\n` +
                `Please top up your wallet in the *Wallet* tab or switch this shipment to *Prepaid* by replying *"edit mode"*.`;
              break;
            }
          }

          // Create Cashfree payment link ONLY for Prepaid shipments
          let cfLink = { linkUrl: '', linkId: '' };
          if (isPrepaidOrder) {
            cfLink = await cashfreeService.createPaymentLink({
              shipmentId,
              amount: data.amount,
              receiverName: data.receiverName,
              receiverPhone: data.receiverPhone,
              description: data.description,
              returnAllowed: data.returnAllowed
            });
          }

          // Create Shipment document
          const shipment = new Shipment({
            shipmentId,
            senderId:        userId,
            receiverName:    data.receiverName,
            receiverPhone:   data.receiverPhone,
            receiverAddress: data.receiverAddress,
            receiverPincode: data.receiverPincode,
            description:     data.description,
            amount:          data.amount,
            city:            `${data.senderPincode || 'Sender'} → ${data.receiverPincode}`,
            carrierSlug:     sel.slug,
            awbCode,
            returnAllowed:   data.returnAllowed,
            paymentLink:     cfLink.linkUrl || '',
            cashfreeLinkId:  cfLink.linkId || '',
            paymentMode:     isCod ? 'cod' : 'prepaid',
            isPrepaid:       isPrepaidOrder,
            codCharge:       codCharge,
            deliveryCharge:  deliveryCharge,
            totalCodFees:    totalCodFees,
            codFeePaid:      codFeePaid,
            codFeePaymentMethod,
            codFeePaidAt,
            codFeeTransactionRef,
            rtoProtectionEnabled: (!isCod && data.rtoProtectionEnabled === true),
            bookedViaAgent:  true,
            agentSessionId:  session.sessionId,
            parcelWeight:    data.weightKg,
            parcelLength:    data.lengthCm || 15,
            parcelWidth:     data.widthCm || 10,
            parcelHeight:    data.heightCm || 5,
            serviceFeeDeducted: calculateServiceFee(data.amount).fee,
            serviceFeeRate:  calculateServiceFee(data.amount).rate,
            status:          isCod ? 'Pending Pickup' : 'Awaiting Payment',
            escrowStage:     isCod ? 3 : 1
          });
          await shipment.save();

          // Auto-schedule Delhivery / Shiprocket pickup slot (cheapest courier)
          const pickupResult = await autoScheduleCourierPickup(shipment, user);

          // For prepaid: send payment link to buyer via WhatsApp (SMS restricted per policy)
          if (isPrepaidOrder && cfLink.linkUrl) {
            await sendPaymentLinkWhatsApp({
              phone:        data.receiverPhone,
              receiverName: data.receiverName,
              shipmentId,
              amount:       data.amount,
              description:  data.description,
              linkUrl:      cfLink.linkUrl
            });
          }

          // Notify sender
          await createNotification(
            userId,
            'smart_toy',
            `🤖 Agent Booked Shipment — ${shipmentId} (${isCod ? 'COD' : 'Prepaid'})`,
            `AI Agent booked shipment for ${data.receiverName} (${data.receiverPhone}). ` +
            `Carrier: ${pickupResult.carrier || sel.name}. Auto-pickup slot: ${pickupResult.pickupSlot}. ` +
            (isCod ? `COD Fees ₹${totalCodFees} adjusted from wallet.` : `Payment link sent via WhatsApp & SMS.`),
            'shipping'
          );

          session.createdShipmentId = shipmentId;
          session.step = STEPS.DONE;

          const carrierBadge = pickupResult.carrier || sel.name;
          const rateBadge = pickupResult.rate || sel.price;

          if (isCod) {
            agentReply =
              `✅ *COD Shipment Booked & Pickup Scheduled!*\n\n` +
              `🆔 *Shipment ID:* ${shipmentId}\n` +
              `🚚 *Carrier:* ${carrierBadge} (Delivery Charge: ₹${rateBadge})\n` +
              `💵 *Payment Mode:* Cash on Delivery (COD) — ₹${data.amount} to be collected at delivery\n` +
              `💼 *Wallet Adjusted:* ₹${totalCodFees} (Courier ₹${deliveryCharge} + COD ₹${codCharge})\n` +
              `📦 *Auto-Scheduled Pickup Slot:* ${pickupResult.pickupSlot}\n` +
              `🏷️ *Pickup Reference:* ${pickupResult.pickupToken}\n` +
              `👤 *Assigned Executive:* ${pickupResult.executive?.name} (${pickupResult.executive?.phone})\n` +
              `📍 *Delivery Address:* ${data.receiverAddress}\n` +
              `⚖️ *Package:* ${data.weightKg} kg (${data.lengthCm || 15}×${data.widthCm || 10}×${data.heightCm || 5} cm)\n\n` +
              `🚫 *Payment Link Skipped:* As requested for COD shipments, no online payment link was sent to the buyer.\n` +
              `⚡ *Zero Supplier Effort:* Courier executive will arrive automatically during the scheduled pickup slot.\n\n` +
              `Type *"new"* to book another shipment or close this chat.`;
          } else {
            agentReply =
              `✅ *Shipment Booked & Courier Pickup Auto-Scheduled!*\n\n` +
              `🆔 *Shipment ID:* ${shipmentId}\n` +
              `🚚 *Cheapest Carrier:* ${carrierBadge} (Delivery Charge: ₹${rateBadge})\n` +
              `🌐 *Powered by Shiprocket API:* Lowest rate auto-assigned across all courier partners.\n` +
              `📦 *Auto-Scheduled Pickup Slot:* ${pickupResult.pickupSlot}\n` +
              `🏷️ *Pickup Reference:* ${pickupResult.pickupToken}\n` +
              `👤 *Assigned Executive:* ${pickupResult.executive?.name} (${pickupResult.executive?.phone})\n` +
              `💰 *Escrow Amount:* ${fmt(data.amount)}\n` +
              `📱 *Payment link sent to ${data.receiverName}* via WhatsApp & SMS\n` +
              `📍 *Delivery Address:* ${data.receiverAddress}\n` +
              `⚖️ *Package:* ${data.weightKg} kg (${data.lengthCm || 15}×${data.widthCm || 10}×${data.heightCm || 5} cm)\n\n` +
              `⚡ *Zero Supplier Effort:* The carrier executive will arrive automatically during the scheduled pickup slot once payment is verified.\n\n` +
              `Type *"new"* to book another shipment or close this chat.`;
          }
        } catch (bookErr) {
          console.error('[AGENT] Booking error:', bookErr);
          agentReply = `⚠️ Booking failed: ${bookErr.message}. Please try again or use the manual booking form.`;
        }
        break;
      }

      // ── STEP 10: DONE ─────────────────────────────────────────────────────
      case STEPS.DONE: {
        const doneMsg = (message || '').toLowerCase();
        if (doneMsg.includes('new') || doneMsg.includes('book another') || doneMsg.includes('another shipment')) {
          // Reset session for a new shipment
          session.step = STEPS.GREETING;
          session.collectedData = {};
          session.carrierQuotes = [];
          session.selectedCarrier = {};
          session.createdShipmentId = '';
          agentReply = `Great! Let's book another shipment 🚀\n\n*What is the receiver's full name?*`;
          session.step = STEPS.RECEIVER_NAME;
        } else {
          agentReply = `Your shipment *${session.createdShipmentId}* is being processed. Type *"new"* or click *"Book Another Shipment"* to book another.`;
        }
        break;
      }

      default:
        agentReply = `Something went wrong. Let's start fresh!\n\n*What is the receiver's full name?*`;
        session.step = STEPS.RECEIVER_NAME;
    }

    // Save agent reply to message history
    session.messages.push({ role: 'agent', content: agentReply });
    session.markModified('collectedData');
    session.markModified('messages');
    session.markModified('carrierQuotes');
    try {
      await session.save();
    } catch (saveErr) {
      console.warn('[AGENT] session.save warning:', saveErr.message);
      // Fallback: direct update without version check
      await AgentSession.updateOne(
        { _id: session._id },
        {
          $set: {
            step: session.step,
            collectedData: session.collectedData,
            carrierQuotes: session.carrierQuotes,
            selectedCarrier: session.selectedCarrier,
            createdShipmentId: session.createdShipmentId,
            isEditing: session.isEditing,
            editingField: session.editingField
          },
          $push: {
            messages: {
              $each: [
                ...(message.trim() ? [{ role: 'user', content: message.trim() }] : []),
                { role: 'agent', content: agentReply }
              ]
            }
          }
        }
      ).catch(e => console.error('[AGENT] Fallback update failed:', e.message));
    }

    res.json({
      sessionId: session.sessionId,
      step: session.step,
      reply: agentReply,
      carrierQuotes: session.step === STEPS.CARRIER_SELECTION ? session.carrierQuotes : undefined,
      selectedCarrier: session.selectedCarrier,
      collectedData: session.collectedData,
      createdShipmentId: session.createdShipmentId
    });

  } catch (err) {
    console.error('[AGENT] handleChat error:', err);
    res.status(500).json({ error: err.message || 'Agent error. Please try again.' });
  }
};

// ── Bulk Excel Upload Handler v2 ─────────────────────────────────────────────
// Supports the rich 20-column template schema for sellers doing large batches.

/**
 * Normalize a header key: lowercase, replace spaces/hyphens with underscore
 * so we handle minor user formatting differences.
 */
const normalizeKey = (k) => String(k || '').toLowerCase().trim().replace(/[\s\-]+/g, '_');

/**
 * Find a value from an Excel row by any alias that matches a canonical column.
 * aliases is an array of possible column name strings.
 */
const getCol = (row, ...aliases) => {
  const keys = Object.keys(row);
  for (const alias of aliases) {
    const norm = normalizeKey(alias);
    const found = keys.find(k => normalizeKey(k) === norm);
    if (found !== undefined && row[found] !== undefined && row[found] !== '') return String(row[found]);
  }
  return '';
};

/** Resolve payment mode from freetext */
const resolvePaymentMode = (val) => {
  const v = (val || '').toLowerCase().trim();
  if (v.includes('cod') || v.includes('cash')) return 'cod';
  return 'prepaid';
};

/** Resolve carrier slug preference from freetext */
const resolveCarrierPref = (val) => {
  const v = (val || '').toLowerCase().trim();
  if (!v || v === 'auto' || v === '-' || v === 'any') return 'auto';
  if (v.includes('delhivery'))  return 'delhivery';
  if (v.includes('bluedart') || v.includes('blue dart')) return 'bluedart';
  if (v.includes('dtdc'))       return 'dtdc';
  if (v.includes('ekart'))      return 'ekart';
  if (v.includes('shadowfax'))  return 'shadowfax';
  if (v.includes('rapido'))     return 'rapido';
  if (v.includes('xpressbee') || v.includes('xpressbees')) return 'xpressbees';
  if (v.includes('ecom') || v.includes('ecom_express')) return 'ecom_express';
  if (v.includes('india post') || v.includes('indiapost')) return 'indiapost';
  return 'auto';
};

/** Resolve category name from freetext */
const resolveCategory = (val) => {
  const v = (val || '').trim();
  const allowed = [
    'Electronics', 'Clothing', 'Books', 'Furniture', 'Toys',
    'Jewellery', 'Footwear', 'Beauty', 'Sports', 'Food',
    'Automotive', 'Home Decor', 'Medical', 'Stationery', 'General'
  ];
  const match = allowed.find(c => c.toLowerCase() === v.toLowerCase());
  return match || 'General';
};

const REQUIRED_COLUMNS = [
  'receiver_name', 'receiver_phone', 'receiver_address',
  'pincode', 'weight_kg', 'description', 'amount'
];

const COLUMN_ALIASES = {
  receiver_name:         ['receiver_name', 'name', 'customer_name', 'buyer_name', 'recipient_name'],
  receiver_phone:        ['receiver_phone', 'phone', 'mobile', 'contact', 'phone_number', 'mobile_number'],
  receiver_email:        ['receiver_email', 'email', 'email_id', 'buyer_email'],
  receiver_address:      ['receiver_address', 'address', 'delivery_address', 'shipping_address'],
  receiver_city:         ['receiver_city', 'city', 'town'],
  receiver_state:        ['receiver_state', 'state'],
  pincode:               ['pincode', 'zip', 'zip_code', 'postal_code', 'delivery_pincode'],
  description:           ['description', 'item', 'product', 'item_description', 'product_name', 'goods'],
  category:              ['category', 'product_category', 'item_category', 'type'],
  weight_kg:             ['weight_kg', 'weight', 'wt', 'weight_in_kg', 'wt_kg'],
  height_cm:             ['height_cm', 'height', 'h', 'height_in_cm'],
  width_cm:              ['width_cm', 'width', 'w', 'width_in_cm'],
  length_cm:             ['length_cm', 'length', 'l', 'length_in_cm'],
  quantity:              ['quantity', 'qty', 'pieces', 'units'],
  amount:                ['amount', 'value', 'price', 'order_amount', 'invoice_value', 'declared_value'],
  payment_mode:          ['payment_mode', 'mode', 'payment', 'pay_mode'],
  cod_amount:            ['cod_amount', 'cash_on_delivery', 'cod', 'collection_amount'],
  insurance_required:    ['insurance_required', 'insurance', 'insure'],
  return_allowed:        ['return_allowed', 'return', 'returns', 'return_policy'],
  preferred_carrier:     ['preferred_carrier', 'carrier', 'courier', 'carrier_preference'],
  special_instructions:  ['special_instructions', 'instructions', 'notes', 'delivery_notes', 'remarks'],
  seller_order_id:       ['seller_order_id', 'order_id', 'invoice_no', 'reference', 'ref_no', 'po_number']
};

const handleBulkUpload = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded. Please upload an Excel (.xlsx) or CSV file.' });
    }

    const userId = req.user._id;
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });

    if (!rows || rows.length === 0) {
      return res.status(400).json({ error: 'Excel file is empty or has no data rows.' });
    }
    if (rows.length > 500) {
      return res.status(400).json({ error: 'Maximum 500 shipments per batch. Please split into multiple files.' });
    }

    // Check that at a minimum the required columns are present
    const firstRow = rows[0];
    const presentKeys = Object.keys(firstRow).map(normalizeKey);
    const missingCols = REQUIRED_COLUMNS.filter(col => {
      const aliases = COLUMN_ALIASES[col] || [col];
      return !aliases.some(alias => presentKeys.includes(normalizeKey(alias)));
    });
    if (missingCols.length > 0) {
      return res.status(400).json({
        error: `Missing required columns: ${missingCols.join(', ')}. Please download and use the official template.`,
        requiredColumns: REQUIRED_COLUMNS,
        downloadTemplateHint: 'Click "Download Template" in the upload panel to get the correct format.'
      });
    }

    // Validate each row
    const parsedRows = rows.map((row, idx) => {
      const errors = [];
      const rowNum = idx + 2; // header = row 1, data starts at row 2

      // ── Core required fields ──
      const name    = getCol(row, ...COLUMN_ALIASES.receiver_name).trim();
      const phone   = extractPhone(getCol(row, ...COLUMN_ALIASES.receiver_phone));
      const address = getCol(row, ...COLUMN_ALIASES.receiver_address).trim();
      const pincode = extractPincode(getCol(row, ...COLUMN_ALIASES.pincode));
      const weight  = parseFloat(getCol(row, ...COLUMN_ALIASES.weight_kg).replace(/[^\d.]/g, '')) || 0;
      const desc    = getCol(row, ...COLUMN_ALIASES.description).trim();
      const amount  = parseFloat(getCol(row, ...COLUMN_ALIASES.amount).replace(/[^\d.]/g, '')) || 0;

      // ── Optional enrichment fields ──
      const email    = getCol(row, ...COLUMN_ALIASES.receiver_email).trim();
      const city     = getCol(row, ...COLUMN_ALIASES.receiver_city).trim();
      const state    = getCol(row, ...COLUMN_ALIASES.receiver_state).trim();
      const category = resolveCategory(getCol(row, ...COLUMN_ALIASES.category));
      const heightCm = parseFloat(getCol(row, ...COLUMN_ALIASES.height_cm).replace(/[^\d.]/g, '')) || 15;
      const widthCm  = parseFloat(getCol(row, ...COLUMN_ALIASES.width_cm).replace(/[^\d.]/g, '')) || 15;
      const lengthCm = parseFloat(getCol(row, ...COLUMN_ALIASES.length_cm).replace(/[^\d.]/g, '')) || 15;
      const quantity = parseInt(getCol(row, ...COLUMN_ALIASES.quantity).replace(/[^\d]/g, ''), 10) || 1;

      const payMode  = resolvePaymentMode(getCol(row, ...COLUMN_ALIASES.payment_mode));
      const codAmt   = parseFloat(getCol(row, ...COLUMN_ALIASES.cod_amount).replace(/[^\d.]/g, '')) || (payMode === 'cod' ? amount : 0);
      const insure   = !isNo(getCol(row, ...COLUMN_ALIASES.insurance_required) || 'no');
      const returnOk = !isNo(getCol(row, ...COLUMN_ALIASES.return_allowed) || 'yes');
      const carrier  = resolveCarrierPref(getCol(row, ...COLUMN_ALIASES.preferred_carrier));
      const notes    = getCol(row, ...COLUMN_ALIASES.special_instructions).trim().substring(0, 300);
      const orderId  = getCol(row, ...COLUMN_ALIASES.seller_order_id).trim().substring(0, 100);

      // ── Validation ──
      if (!name || name.length < 2)        errors.push('receiver_name is missing or too short (min 2 chars)');
      if (!phone)                           errors.push('receiver_phone must be a valid 10-digit Indian number');
      if (!address || address.length < 8)   errors.push('receiver_address is too short (min 8 chars, include street + area)');
      if (!pincode)                         errors.push('pincode must be a valid 6-digit number');
      if (!weight || weight <= 0)           errors.push('weight_kg must be a positive number (e.g. 1.5)');
      if (!desc || desc.length < 3)         errors.push('description is missing or too short');
      if (!amount || amount < 1)            errors.push('amount must be at least ₹1');
      if (payMode === 'cod' && codAmt <= 0) errors.push('cod_amount must be > 0 when payment_mode is COD');
      if (quantity < 1 || quantity > 999)   errors.push('quantity must be between 1 and 999');

      return {
        rowNumber: rowNum,
        receiverName:    name,
        receiverPhone:   phone || getCol(row, ...COLUMN_ALIASES.receiver_phone).trim(),
        receiverEmail:   email,
        receiverAddress: address,
        receiverCity:    city,
        receiverState:   state,
        pincode:         pincode || getCol(row, ...COLUMN_ALIASES.pincode).trim(),
        description:     desc,
        category,
        weightKg:        weight,
        heightCm,
        widthCm,
        lengthCm,
        quantity,
        amount,
        paymentMode:     payMode,
        codAmount:       codAmt,
        insuranceRequired: insure,
        returnAllowed:   returnOk,
        preferredCarrier: carrier,
        specialInstructions: notes,
        sellerOrderId:   orderId,
        isValid:         errors.length === 0,
        errors
      };
    });

    const validRows   = parsedRows.filter(r => r.isValid).length;
    const invalidRows = parsedRows.filter(r => !r.isValid).length;

    // Create a BulkJob record
    const jobId = uuidv4();
    const job = new BulkJob({
      jobId,
      userId,
      status: 'awaiting_confirmation',
      totalRows: parsedRows.length,
      validRows,
      invalidRows,
      parsedRows,
      originalFileName: req.file.originalname,
      templateVersion: 'v2'
    });
    await job.save();

    res.json({
      jobId,
      totalRows: parsedRows.length,
      validRows,
      invalidRows,
      parsedRows,
      message: invalidRows > 0
        ? `⚠️ Found ${invalidRows} row(s) with errors. Fix them or proceed to book the ${validRows} valid rows.`
        : `✅ All ${validRows} rows are valid. Ready to book in one shot!`
    });

  } catch (err) {
    console.error('[AGENT] Bulk upload error:', err);
    res.status(500).json({ error: 'Failed to parse Excel file: ' + err.message });
  }
};

// ── Confirm Bulk Booking ───────────────────────────────────────────────────────

const confirmBulkBooking = async (req, res) => {
  try {
    const { jobId, bookOnlyValid = true } = req.body;
    const userId = req.user._id;
    const user = req.user;

    const job = await BulkJob.findOne({ jobId, userId });
    if (!job) return res.status(404).json({ error: 'Bulk job not found.' });
    if (job.status === 'processing' || job.status === 'completed') {
      return res.status(400).json({ error: 'This bulk job is already being processed.' });
    }

    if (!user.phone || !user.isPhoneVerified) {
      return res.status(403).json({
        error: 'Phone verification required',
        code: 'PHONE_VERIFICATION_REQUIRED',
        message: 'Phone verification is mandatory before booking bulk shipments. Please verify your mobile number.'
      });
    }

    job.status = 'processing';
    await job.save();

    // Process in background (non-blocking)
    processBulkRows(job, user).catch(err => console.error('[BULK JOB] Processing error:', err));

    const toProcess = bookOnlyValid ? job.validRows : job.totalRows;
    res.json({
      jobId,
      message: `Booking ${toProcess} shipment(s) in the background. Poll /agent/bulk-status/${jobId} for live progress.`,
      totalRows: job.totalRows,
      validRows: job.validRows
    });

  } catch (err) {
    console.error('[AGENT] confirmBulkBooking error:', err);
    res.status(500).json({ error: err.message });
  }
};

/** Background processor for bulk rows — v2 rich schema */
async function processBulkRows(job, user) {
  const { getCarrierRates } = require('../services/carrierRateService');
  let successCount = 0;
  let failCount = 0;
  const createdIds = [];

    for (let i = 0; i < job.parsedRows.length; i++) {
    const row = job.parsedRows[i];
    if (!row.isValid) { failCount++; continue; }

    // Block COD and Offline orders in bulk if seller wallet balance is negative
    if ((Number(user.walletBalance) || 0) < 0 && (row.paymentMode === 'cod' || row.paymentMode === 'paid_offline')) {
      row.isValid = false;
      row.errorReason = `Suspended: Negative wallet balance (-₹${Math.abs(Number(user.walletBalance)).toFixed(2)}). Cannot book COD or Offline shipments.`;
      failCount++;
      continue;
    }

    try {
      const senderPincode = user.pincode || '110001';

      // Get carrier quotes — honour preferred carrier if seller specified one
      const quotes = getCarrierRates(senderPincode, row.pincode, row.weightKg);
      let sel = quotes[0]; // default: cheapest
      if (row.preferredCarrier && row.preferredCarrier !== 'auto') {
        const preferred = quotes.find(q => q.slug === row.preferredCarrier);
        if (preferred) sel = preferred;
      }

      const shipmentId = generateShipmentId();
      const awbCode = `AGT-${sel.slug.toUpperCase().substring(0, 3)}-${Math.floor(1000000000 + Math.random() * 9000000000)}`;

      // Payment link (skip for COD and Prepaid shipments)
      let cfLink = { linkUrl: '', linkId: '' };
      const isCod = row.paymentMode === 'cod';
      const isPrepaid = row.paymentMode === 'prepaid';

      const bulkShipment = new Shipment({
        shipmentId,
        senderId:          user._id,
        receiverName:      row.receiverName,
        receiverPhone:     row.receiverPhone,
        description:       row.description,
        amount:            row.amount,
        city:              `${senderPincode} → ${row.pincode}`,
        carrierSlug:       sel.slug,
        awbCode,
        returnAllowed:     row.returnAllowed,
        paymentLink:       cfLink.linkUrl,
        cashfreeLinkId:    cfLink.linkId,
        paymentMode:       row.paymentMode,
        isPrepaid:         isPrepaid,
        codAmount:         isCod ? (row.codAmount || row.amount) : 0,
        bookedViaAgent:    true,
        agentSessionId:    `bulk-${job.jobId}`,
        receiverAddress:   row.receiverAddress,
        receiverPincode:   row.pincode,
        parcelWeight:      row.weightKg,
        parcelHeight:      row.heightCm,
        serviceFeeDeducted: calculateServiceFee(row.amount).fee,
        serviceFeeRate:    calculateServiceFee(row.amount).rate,
        bulkJobId:         job.jobId,
        sellerOrderRef:    row.sellerOrderId || '',
        status:            'Pending Pickup',
        escrowStage:       3,
        receiverPaymentDone: isPrepaid,
        receiverPaidAt:    isPrepaid ? new Date() : undefined
      });
      await bulkShipment.save();
      await autoScheduleCourierPickup(bulkShipment, user);

      // Notification via WhatsApp per platform messaging policy
      await sendBookingConfirmationWhatsApp({
        phone:        row.receiverPhone,
        receiverName: row.receiverName,
        shipmentId,
        carrierName:  sel.name || sel.slug,
        awbCode,
        eta:          sel.eta || '3-5 business days'
      });

      // Update row with booking results
      row.shipmentId      = shipmentId;
      row.awbCode         = awbCode;
      row.paymentLink     = cfLink.linkUrl;
      row.carrierAssigned = sel.name;
      row.carrierPrice    = sel.price;
      createdIds.push(shipmentId);
      successCount++;

    } catch (rowErr) {
      row.bookingError = rowErr.message;
      row.errors = [...(row.errors || []), rowErr.message];
      row.isValid = false;
      failCount++;
    }

    job.processedRows = i + 1;
    job.markModified('parsedRows');
    await job.save();
  }

  job.status = 'completed';
  job.successCount = successCount;
  job.failCount = failCount;
  job.createdShipmentIds = createdIds;
  job.completedAt = new Date();
  await job.save();

  console.log(`[BULK JOB ${job.jobId}] Completed: ${successCount} booked, ${failCount} failed`);
}

// ── Bulk Job Status ────────────────────────────────────────────────────────────

const getBulkStatus = async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = await BulkJob.findOne({ jobId, userId: req.user._id });
    if (!job) return res.status(404).json({ error: 'Job not found.' });

    // Progress percentage
    const progress = job.totalRows > 0
      ? Math.round((job.processedRows / job.totalRows) * 100)
      : 0;

    res.json({
      jobId:              job.jobId,
      status:             job.status,
      progress,
      totalRows:          job.totalRows,
      validRows:          job.validRows,
      invalidRows:        job.invalidRows,
      processedRows:      job.processedRows,
      successCount:       job.successCount,
      failCount:          job.failCount,
      createdShipmentIds: job.createdShipmentIds,
      parsedRows:         job.parsedRows,
      originalFileName:   job.originalFileName,
      completedAt:        job.completedAt
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── Download Bulk Booking Report (Excel) ──────────────────────────────────────

const downloadBulkReport = async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = await BulkJob.findOne({ jobId, userId: req.user._id });
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    if (job.status !== 'completed') {
      return res.status(400).json({ error: 'Report only available after job is completed.' });
    }

    const rows = job.parsedRows.map(r => ({
      'Row #':                r.rowNumber,
      'Seller Order ID':      r.sellerOrderId || '',
      'Booking Status':       r.shipmentId ? 'Booked ✅' : (r.bookingError ? 'Failed ❌' : 'Skipped'),
      'SecureKaro Shipment ID': r.shipmentId || '',
      'AWB Code':             r.awbCode || '',
      'Receiver Name':        r.receiverName,
      'Receiver Phone':       r.receiverPhone,
      'Receiver Email':       r.receiverEmail || '',
      'Delivery Address':     r.receiverAddress,
      'City':                 r.receiverCity || '',
      'State':                r.receiverState || '',
      'Pincode':              r.pincode,
      'Item Description':     r.description,
      'Category':             r.category || '',
      'Weight (kg)':          r.weightKg,
      'Dimensions (HxWxL cm)': `${r.heightCm}x${r.widthCm}x${r.lengthCm}`,
      'Quantity':             r.quantity || 1,
      'Declared Value (₹)':  r.amount,
      'Payment Mode':         r.paymentMode,
      'COD Amount (₹)':       r.codAmount || '',
      'Insurance':            r.insuranceRequired ? 'Yes' : 'No',
      'Return Allowed':       r.returnAllowed ? 'Yes' : 'No',
      'Preferred Carrier':    r.preferredCarrier || 'auto',
      'Carrier Assigned':     r.carrierAssigned || '',
      'Carrier Charge (₹)':  r.carrierPrice || '',
      'Payment Link':         r.paymentLink || '',
      'Special Instructions': r.specialInstructions || '',
      'Error / Reason':       r.bookingError || r.errors?.join('; ') || ''
    }));

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, 'Booking Report');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', `attachment; filename="securekaro_bulk_report_${jobId.slice(0, 8)}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);

  } catch (err) {
    console.error('[AGENT] downloadBulkReport error:', err);
    res.status(500).json({ error: err.message });
  }
};

// ── Get Carrier Rates (Public endpoint for carrier comparison card) ─────────────

const getCarrierRatesHandler = async (req, res) => {
  try {
    const { fromPincode, toPincode, weightKg, length, width, height, dimensions } = req.body;
    if (!fromPincode || !toPincode) {
      return res.status(400).json({ error: 'fromPincode and toPincode are required.' });
    }
    const dims = dimensions || (length && width && height ? { length, width, height } : null);
    const quotes = getCarrierRates(fromPincode, toPincode, parseFloat(weightKg) || 0.5, dims);
    res.json({ quotes, fromZone: getPincodeInfo(fromPincode), toZone: getPincodeInfo(toPincode) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── Get Session (for widget restore) ──────────────────────────────────────────

const getSession = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await AgentSession.findOne({ sessionId, userId: req.user._id });
    if (!session) return res.status(404).json({ error: 'Session not found.' });
    res.json({ session });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  handleChat,
  handleBulkUpload,
  confirmBulkBooking,
  getBulkStatus,
  downloadBulkReport,
  getCarrierRatesHandler,
  getSession
};
