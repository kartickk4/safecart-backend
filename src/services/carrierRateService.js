const axios = require('axios');
const { fetchLiveNimbusRates, getRealisticNimbusQuotes } = require('./nimbuspostService');
const { fetchDirectDelhiveryRate } = require('./delhiveryService');
const { fetchDirectShadowfaxRate } = require('./shadowfaxService');
const { cacheManager } = require('./cacheManager');

// Pincode-to-zone mapping (first 3 digits of 6-digit pincode)
const METRO_PREFIXES = new Set([
  '110','111','112','113',  // Delhi
  '400','401','402','403','404','405','406','407','408','409','410','411','412','413','414','415','416','417','418','419','420','421','422','423','424','425','426','427','428','429','430','431','432','433','434','435','436','437','438','439','440','441','442','443', // Mumbai + Maharashtra
  '560','561','562','563','564','565','566','567','568','569','570','571','572','573','574','575','576','577','578','579','580', // Bangalore + Karnataka
  '600','601','602','603','604','605','606','607','608','609','610','611','612','613','614','615','616','617','618','619','620','621','622','623','624','625','626','627','628','629','630', // Chennai + Tamil Nadu
  '500','501','502','503','504','505','506','507','508','509','510','511','512','513','514','515','516','517','518','519','520','521','522','523','524','525','526','527','528','529','530','531','532','533','534','535','536','537','538','539', // Hyderabad + Andhra/Telangana
  '700','701','702','703','704','705','706','707','708','709','710','711','712','713','714','715','716','717','718','719','720','721','722','723','724','725','726','727','728','729','730','731','732','733','734','735','736','737','738','739','740','741','742','743','744','745','746','747','748','749', // Kolkata + West Bengal
]);

const TIER2_PREFIXES = new Set([
  // Major Tier-2 cities: Pune, Surat, Jaipur, Lucknow, Kanpur, Ahmedabad, Indore, Bhopal, Patna, etc.
  '411','412','413','414','415','416','417','418','419','420', // Pune
  '395','396','397','398','399',                               // Surat
  '302','303','304','305','306','307','308','309','310','311','312','313','314','315','316','317','318','319','320','321','322','323','324','325','326','327','328','329','330','331','332','333','334','335','336','337','338','339', // Jaipur + Rajasthan
  '226','227','228','229','230','231','232','233','234','235', // Lucknow
  '380','381','382','383','384','385','386','387','388','389','390','391','392','393','394', // Ahmedabad + Gujarat
  '452','453','454','455','456','457','458','459','460','461','462','463','464','465','466','467','468','469','470','471','472','473','474','475','476','477','478','479','480', // Indore + MP
  '208','209','210','211','212','213','214','215','216','217','218','219','220','221','222','223','224','225', // Kanpur + Agra
]);

function getZone(pincode) {
  const prefix = String(pincode || '').trim().substring(0, 3);
  if (METRO_PREFIXES.has(prefix)) return 'metro';
  if (TIER2_PREFIXES.has(prefix)) return 'tier2';
  return 'tier3';
}

function getPincodeInfo(pincode) {
  const cleanPin = String(pincode || '').trim().slice(0, 6);
  const cacheKey = cacheManager.generateKey('logistics:pincode', { pin: cleanPin });
  const cached = cacheManager.memoryStore.get(cacheKey);
  if (cached) return cached;

  const zone = getZone(cleanPin);
  const labels = {
    metro: 'Metro Zone (Fastest Delivery)',
    tier2: 'Tier-2 City Zone',
    tier3: 'Rest of India / Tier-3 Zone'
  };
  const result = {
    pincode: cleanPin,
    zone,
    label: labels[zone] || 'Standard Logistics Zone'
  };

  // Cache for 24 hours (86400 seconds) - static geographic mapping
  cacheManager.set(cacheKey, result, 86400, ['logistics:geo']);
  return result;
}

// In-memory token cache for Shiprocket API
let shiprocketToken = null;
let shiprocketTokenExpiresAt = 0;

async function getShiprocketToken() {
  if (shiprocketToken && Date.now() < shiprocketTokenExpiresAt) {
    return shiprocketToken;
  }
  const email = process.env.SHIPROCKET_EMAIL;
  const password = process.env.SHIPROCKET_PASSWORD;
  if (!email || !password) return null;

  try {
    const authRes = await axios.post('https://apiv2.shiprocket.in/v1/external/auth/login', {
      email,
      password
    }, { timeout: 8000 });
    if (authRes.data?.token) {
      shiprocketToken = authRes.data.token;
      shiprocketTokenExpiresAt = Date.now() + 24 * 60 * 60 * 1000; // cache for 24 hours
      return shiprocketToken;
    }
  } catch (err) {
    console.warn('[Shiprocket Auth Error]:', err.response?.data?.message || err.message);
  }
  return null;
}

// Base rates per 500g slab (in INR including 18% GST + Fuel Surcharge)
// Aligned with live Shiprocket starter rates
const RATE_MATRIX = {
  'metro-metro':   { xpressbees: 49.72, delhivery: 55.72, shadowfax: 55.72, ekart: 55.72, rapido: 50.00, ecom_express: 58.50, dtdc: 77.32, indiapost: 65.00, bluedart: 98.28 },
  'metro-tier2':   { xpressbees: 58.00, delhivery: 64.50, shadowfax: 64.50, ekart: 66.00, rapido: 62.00, ecom_express: 68.00, dtdc: 82.50, indiapost: 72.00, bluedart: 108.50 },
  'metro-tier3':   { xpressbees: 76.50, delhivery: 79.50, shadowfax: 82.00, ekart: 82.00, rapido: 78.00, ecom_express: 84.00, dtdc: 94.00, indiapost: 88.00, bluedart: 125.00 },
  'tier2-metro':   { xpressbees: 58.00, delhivery: 64.50, shadowfax: 64.50, ekart: 66.00, rapido: 62.00, ecom_express: 68.00, dtdc: 82.50, indiapost: 72.00, bluedart: 108.50 },
  'tier2-tier2':   { xpressbees: 65.00, delhivery: 72.00, shadowfax: 74.00, ekart: 75.00, rapido: 70.00, ecom_express: 78.00, dtdc: 88.00, indiapost: 78.00, bluedart: 118.00 },
  'tier2-tier3':   { xpressbees: 82.00, delhivery: 86.00, shadowfax: 88.00, ekart: 88.00, rapido: 84.00, ecom_express: 92.00, dtdc: 98.00, indiapost: 92.00, bluedart: 135.00 },
  'tier3-metro':   { xpressbees: 76.50, delhivery: 79.50, shadowfax: 82.00, ekart: 82.00, rapido: 78.00, ecom_express: 84.00, dtdc: 94.00, indiapost: 88.00, bluedart: 125.00 },
  'tier3-tier2':   { xpressbees: 82.00, delhivery: 86.00, shadowfax: 88.00, ekart: 88.00, rapido: 84.00, ecom_express: 92.00, dtdc: 98.00, indiapost: 92.00, bluedart: 135.00 },
  'tier3-tier3':   { xpressbees: 92.00, delhivery: 95.00, shadowfax: 98.00, ekart: 98.00, rapido: 94.00, ecom_express: 102.00, dtdc: 110.00, indiapost: 100.00, bluedart: 145.00 },
};

const CARRIER_NAMES = {
  delhivery:    'Delhivery Express',
  shadowfax:    'Shadowfax Technologies',
  rapido:       'Rapido Parcel / Express',
  ekart:        'Ekart Logistics',
  xpressbees:   'Xpressbees Logistics',
  ecom_express: 'Ecom Express',
  dtdc:         'DTDC Express',
  bluedart:     'BlueDart Express',
  indiapost:    'India Post Speed Post'
};

const CARRIER_RATINGS = {
  delhivery:    4.8,
  shadowfax:    4.6,
  rapido:       4.7,
  ekart:        4.7,
  xpressbees:   4.5,
  ecom_express: 4.4,
  dtdc:         4.3,
  bluedart:     4.9,
  indiapost:    4.1
};

const CARRIER_ETAs = {
  'metro-metro':   { shadowfax: '1 day',     rapido: 'Same-Day / 1 day', xpressbees: '1-2 days', delhivery: '1-2 days', ekart: '1-2 days', ecom_express: '2 days',   dtdc: '2 days',   bluedart: '1 day',   indiapost: '2-3 days' },
  'metro-tier2':   { delhivery: '2 days',    rapido: '1-2 days',         xpressbees: '2-3 days', shadowfax: '2-3 days', ekart: '2-3 days', ecom_express: '2-3 days', dtdc: '3 days',   bluedart: '1-2 days', indiapost: '3-4 days' },
  'metro-tier3':   { delhivery: '3-4 days',  ekart: '3-4 days',          rapido: '3-4 days',      xpressbees: '3-5 days', shadowfax: '4 days', ecom_express: '4-5 days', dtdc: '4-5 days', bluedart: '2-3 days', indiapost: '4-6 days' },
  'tier2-metro':   { delhivery: '2 days',    rapido: '1-2 days',         xpressbees: '2-3 days', shadowfax: '2-3 days', ekart: '2-3 days', ecom_express: '2-3 days', dtdc: '3 days',   bluedart: '1-2 days', indiapost: '3-4 days' },
  'tier2-tier2':   { delhivery: '2-3 days',  rapido: '2-3 days',         xpressbees: '2-3 days', ekart: '3-4 days',      shadowfax: '3-4 days', ecom_express: '3-4 days', dtdc: '3-4 days', bluedart: '2 days',   indiapost: '4-5 days' },
  'tier2-tier3':   { delhivery: '3-5 days',  rapido: '3-5 days',         ekart: '4-5 days',      xpressbees: '4-5 days', ecom_express: '4-5 days', shadowfax: '4-6 days', dtdc: '5-6 days', bluedart: '3-4 days', indiapost: '5-7 days' },
  'tier3-metro':   { delhivery: '3-4 days',  rapido: '3-4 days',         ekart: '3-5 days',      xpressbees: '4-5 days', shadowfax: '4-5 days', ecom_express: '4-5 days', dtdc: '5 days',   bluedart: '2-3 days', indiapost: '5-6 days' },
  'tier3-tier2':   { delhivery: '3-5 days',  rapido: '3-5 days',         ekart: '4-5 days',      xpressbees: '4-6 days', shadowfax: '4-6 days', ecom_express: '5 days',   dtdc: '5-6 days', bluedart: '3-4 days', indiapost: '5-7 days' },
  'tier3-tier3':   { delhivery: '4-6 days',  rapido: '4-6 days',         ekart: '5-6 days',      xpressbees: '5-7 days', shadowfax: '5-7 days', ecom_express: '5-7 days', dtdc: '6-8 days', bluedart: '4-5 days', indiapost: '6-8 days' },
};

/**
 * Get carrier price quotes for a shipment across all popular partners.
 * Simulates calling Shiprocket Serviceability API & Delhivery Rate API.
 * Supports forward delivery and reverse pickup logistics (with QC & doorstep surcharge).
 *
 * @param {string} fromPincode - Sender pincode (or buyer pincode for reverse pickup)
 * @param {string} toPincode - Receiver pincode (or seller warehouse pincode for reverse return)
 * @param {number} weightKg - Weight in kg
 * @param {object|null} dimensions - Optional { length, width, height } in cm
 * @param {boolean} isReverse - Whether this is a reverse pickup shipment
 * @returns {Array} Sorted carrier quotes (lowest first)
 */
const getCarrierRates = (fromPincode, toPincode, weightKg = 0.5, dimensions = null, isReverse = false, isCod = false, declaredValue = 0, isSecureShipment = true) => {
  const fromZone = getZone(fromPincode);
  const toZone = getZone(toPincode);
  const zoneKey = `${fromZone}-${toZone}`;

  const rates = RATE_MATRIX[zoneKey] || RATE_MATRIX['tier3-tier3'];
  const etas  = CARRIER_ETAs[zoneKey] || CARRIER_ETAs['tier3-tier3'];

  // Factor in Volumetric Weight (L × W × H / 5000 in cm) if dimensions are provided
  let effectiveWeight = Math.max(0.1, parseFloat(weightKg) || 0.5);
  if (dimensions && dimensions.length && dimensions.width && dimensions.height) {
    const l = parseFloat(dimensions.length) || 0;
    const w = parseFloat(dimensions.width) || 0;
    const h = parseFloat(dimensions.height) || 0;
    if (l > 0 && w > 0 && h > 0) {
      const volumetricKg = (l * w * h) / 5000;
      effectiveWeight = Math.max(effectiveWeight, volumetricKg);
    }
  }

  // Weight slabs: base rate is per 500g, rounded up
  const weightSlabs = Math.max(1, Math.ceil(effectiveWeight / 0.5));

  // Reverse logistics surcharge: courier partners (Delhivery, Shadowfax, Shiprocket)
  // charge higher rates (+₹18 per slab, min ₹55) for doorstep reverse pickup & QC verification
  const REVERSE_SURCHARGE_PER_SLAB = isReverse ? 18 : 0;

  const quotes = Object.entries(rates).map(([slug, baseRate]) => {
    const rawForwardPrice = parseFloat((baseRate * weightSlabs).toFixed(2));
    const isSfx = slug.includes('shadowfax');
    const surcharge = isReverse ? (isSfx ? 0 : parseFloat((REVERSE_SURCHARGE_PER_SLAB * weightSlabs).toFixed(2))) : 0;
    
    // COD Handling fee dynamically aligned with Shiprocket rate card for declared amount
    let codCharge = 0;
    if (isCod) {
      const val = parseFloat(declaredValue) || 3000;
      if (slug.includes('delhivery')) codCharge = val >= 3000 ? 99.00 : 54.00;
      else if (slug.includes('xpressbees')) codCharge = val >= 3000 ? 75.00 : 48.00;
      else if (slug.includes('shadowfax')) codCharge = 0; // Shadowfax 360: ₹0 COD handling fee
      else codCharge = Math.max(54.00, parseFloat((val * 0.03).toFixed(2)));
    }

    // Secure Shipment insurance fee
    const secureCharge = (!isReverse && isSecureShipment) ? 54.00 : 0;
    const whatsappCharge = (!isReverse) ? 5.00 : 0;

    const finalPrice = parseFloat((isReverse 
      ? (isSfx ? Math.max(34, rawForwardPrice - 5) : Math.max(55, rawForwardPrice + surcharge))
      : (rawForwardPrice + codCharge + secureCharge + whatsappCharge)
    ).toFixed(2));

    return {
      slug,
      name:       CARRIER_NAMES[slug] || slug,
      price:      finalPrice,
      exactRate:  finalPrice,
      freightCharge: rawForwardPrice,
      codCharge:  codCharge,
      whatsappCharge: whatsappCharge,
      secureShipmentCharge: secureCharge,
      isSecureShipment,
      forwardBasePrice: rawForwardPrice,
      reverseSurcharge: surcharge,
      isReverse,
      isCod,
      eta:        etas[slug] || '3-5 days',
      rating:     CARRIER_RATINGS[slug] || 4.5,
      aggregator: 'shiprocket',
      aggregatorName: 'Shiprocket',
      courierPartner: CARRIER_NAMES[slug] || slug,
      apiSource:  'Shiprocket Rate Engine',
      zone:       zoneKey,
      serviceType: isReverse ? 'Reverse Logistics & Doorstep QC' : (isCod ? 'Cash on Delivery (COD)' : 'Prepaid Express Delivery')
    };
  });

  // Sort by price (cheapest first)
  quotes.sort((a, b) => a.price - b.price);

  // Mark the cheapest
  if (quotes.length > 0) quotes[0].isLowest = true;

  return quotes;
};

function mapCarrierNameToSlug(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('delhivery')) return 'delhivery';
  if (n.includes('shadowfax')) return 'shadowfax';
  if (n.includes('xpressbees')) return 'xpressbees';
  if (n.includes('ekart')) return 'ekart';
  if (n.includes('ecom')) return 'ecom_express';
  if (n.includes('dtdc')) return 'dtdc';
  if (n.includes('blue dart') || n.includes('bluedart')) return 'bluedart';
  if (n.includes('rapido')) return 'rapido';
  if (n.includes('post')) return 'indiapost';
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '_');
}

/**
 * Fetch live rates directly from Shiprocket Serviceability API
 */
async function fetchLiveShiprocketRates(fromPincode, toPincode, weightKg = 0.5, dimensions = null, isCod = false, declaredValue = 0, isSecureShipment = true) {
  try {
    const token = await getShiprocketToken();
    if (!token) return null;

    const params = {
      pickup_postcode: String(fromPincode).trim(),
      delivery_postcode: String(toPincode).trim(),
      weight: String(weightKg || 0.5),
      cod: isCod ? '1' : '0'
    };
    if (declaredValue && parseFloat(declaredValue) > 0) {
      params.declared_value = String(declaredValue);
    }
    if (isSecureShipment) {
      params.is_secureshipment = '1';
    }
    if (dimensions && dimensions.length && dimensions.width && dimensions.height) {
      params.length = String(dimensions.length);
      params.breadth = String(dimensions.width);
      params.height = String(dimensions.height);
    }

    const res = await axios.get('https://apiv2.shiprocket.in/v1/external/courier/serviceability/', {
      params,
      headers: { Authorization: `Bearer ${token}` },
      timeout: 8000
    });

    const couriers = res.data?.data?.available_courier_companies;
    if (!Array.isArray(couriers) || couriers.length === 0) return null;

    const quotes = couriers.map(c => {
      const baseSlug = mapCarrierNameToSlug(c.courier_name);
      const uniqueSlug = `${baseSlug}_${c.courier_company_id || (c.is_surface ? 'surface' : 'air')}`;
      const baseRate = parseFloat(c.rate) || 0;
      const codCharge = parseFloat(c.cod_charges) || 0;
      const rawFreight = parseFloat(c.freight_charge) || parseFloat((baseRate - codCharge).toFixed(2));
      // Platform ₹5 seller discount applied directly on freight charge
      const discountedFreight = Math.max(10, parseFloat((rawFreight - 5.00).toFixed(2)));
      const finalRate = Math.max(30, parseFloat((discountedFreight + codCharge).toFixed(2)));

      const targetWeight = parseFloat(weightKg || 0.5);
      const weightSlabText = `${targetWeight} K.G`;

      return {
        slug: uniqueSlug,
        baseSlug,
        courierCompanyId: c.courier_company_id,
        aggregator: 'shiprocket',
        aggregatorName: 'Shiprocket',
        courierPartner: `${c.courier_name} ${weightSlabText}`,
        rawName: c.courier_name,
        minWeightKg: targetWeight,
        minWeightGrams: Math.round(targetWeight * 1000),
        weightSlab: weightSlabText,
        isCloseToWeight: true,
        price: finalRate,
        exactRate: finalRate,
        originalRate: baseRate,
        originalFreight: rawFreight,
        discountOffset: 5.00,
        freightCharge: discountedFreight,
        codCharge: parseFloat(codCharge.toFixed(2)),
        whatsappCharge: 0,
        secureShipmentCharge: 0,
        isSecureShipment,
        isCod,
        eta: c.etd ? `Delivery by ${c.etd}` : (c.estimated_delivery_days ? `In ${c.estimated_delivery_days} Days` : '2 Days'),
        rating: parseFloat(c.rating) || 4.5,
        mode: c.is_surface ? 'Surface' : 'Air',
        apiSource: 'Shiprocket Live Network',
        zone: `${getZone(fromPincode)}-${getZone(toPincode)}`,
        serviceType: `${c.is_surface ? 'Surface' : 'Air'} Express (Live Shiprocket Rate)`
      };
    });

    // Sort cheapest first
    quotes.sort((a, b) => a.price - b.price);
    if (quotes.length > 0) quotes[0].isLowest = true;
    return quotes;
  } catch (err) {
    console.warn('[Shiprocket Live Rates Error]:', err.response?.data?.message || err.message);
    return null;
  }
}

/**
 * Async carrier rate query: queries BOTH Shiprocket & NimbusPost concurrently,
 * merges their rates side-by-side, and highlights the cheapest recommended option.
 *
 * Implements:
 * 1. Safe Cache Key generation (from/to pincodes, weight slabs, volumetric dimensions, COD, value).
 * 2. 15-Minute TTL adhering to courier API freshness rules and rate limit quotas.
 * 3. Single-Flight request coalescing to completely prevent Cache Stampedes.
 * 4. Fallback to deterministic local pricing engine if upstream aggregators fail.
 */
const getCarrierRatesAsync = async (fromPincode, toPincode, weightKg = 0.5, dimensions = null, isReverse = false, isCod = false, declaredValue = 0, isSecureShipment = true) => {
  if (isReverse) {
    return getCarrierRates(fromPincode, toPincode, weightKg, dimensions, isReverse, isCod, declaredValue, isSecureShipment);
  }

  const cleanFrom = String(fromPincode || '').trim().slice(0, 6);
  const cleanTo = String(toPincode || '').trim().slice(0, 6);
  const normalizedWeight = parseFloat((Math.max(0.1, parseFloat(weightKg) || 0.5)).toFixed(2));
  const decValSlab = Math.round((parseFloat(declaredValue) || 0) / 500) * 500; // 500 INR slabs

  let dimsKey = 'none';
  if (dimensions && dimensions.length && dimensions.width && dimensions.height) {
    dimsKey = `${dimensions.length}x${dimensions.width}x${dimensions.height}`;
  }

  const rateCacheKey = cacheManager.generateKey('logistics:rates', {
    from: cleanFrom,
    to: cleanTo,
    w: normalizedWeight,
    dims: dimsKey,
    cod: isCod ? 1 : 0,
    val: decValSlab,
    sec: isSecureShipment ? 1 : 0
  });

  return cacheManager.getOrSet(rateCacheKey, async () => {
    // Concurrently fetch rates from Direct Delhivery, Direct Shadowfax, NimbusPost, and Shiprocket
    const [delhiverySettled, shadowfaxSettled, nimbusSettled, shiprocketSettled] = await Promise.allSettled([
      fetchDirectDelhiveryRate({
        fromPincode: cleanFrom,
        toPincode: cleanTo,
        weightKg: normalizedWeight,
        dimensions,
        isCod,
        declaredValue,
        isSecureShipment
      }),
      fetchDirectShadowfaxRate({
        fromPincode: cleanFrom,
        toPincode: cleanTo,
        weightKg: normalizedWeight,
        dimensions,
        isCod,
        declaredValue,
        isSecureShipment
      }),
      fetchLiveNimbusRates(cleanFrom, cleanTo, normalizedWeight, dimensions, isCod, declaredValue, isSecureShipment),
      fetchLiveShiprocketRates(cleanFrom, cleanTo, normalizedWeight, dimensions, isCod, declaredValue, isSecureShipment)
    ]);

    const directDelhiveryQuote = (delhiverySettled.status === 'fulfilled' && delhiverySettled.value) 
      ? delhiverySettled.value 
      : null;

    const directShadowfaxQuote = (shadowfaxSettled.status === 'fulfilled' && shadowfaxSettled.value)
      ? shadowfaxSettled.value
      : null;

    let nimbusQuotes = (nimbusSettled.status === 'fulfilled' && nimbusSettled.value) 
      ? nimbusSettled.value 
      : null;
    if (!nimbusQuotes || nimbusQuotes.length === 0) {
      nimbusQuotes = getRealisticNimbusQuotes(cleanFrom, cleanTo, normalizedWeight, isCod, declaredValue, isSecureShipment);
    }

    let shiprocketQuotes = (shiprocketSettled.status === 'fulfilled' && shiprocketSettled.value) 
      ? shiprocketSettled.value 
      : null;
    if (!shiprocketQuotes || shiprocketQuotes.length === 0) {
      shiprocketQuotes = getCarrierRates(cleanFrom, cleanTo, normalizedWeight, dimensions, isReverse, isCod, declaredValue, isSecureShipment);
    }

    // --- DELHIVERY & SHADOWFAX RATE ARBITRAGE (Direct Carrier vs NimbusPost) ---
    // Separate Delhivery and Shadowfax quotes from other carriers in NimbusPost
    const nimbusDelhiveryQuotes = [];
    const nimbusShadowfaxQuotes = [];
    const nonArbitragedNimbusQuotes = [];

    for (const q of nimbusQuotes) {
      const isDelhivery = (q.baseSlug === 'delhivery') || 
                          (q.slug && q.slug.toLowerCase().includes('delhivery')) ||
                          (q.name && q.name.toLowerCase().includes('delhivery')) ||
                          (q.courierPartner && q.courierPartner.toLowerCase().includes('delhivery'));
      const isShadowfax = (q.baseSlug === 'shadowfax') ||
                          (q.slug && q.slug.toLowerCase().includes('shadowfax')) ||
                          (q.name && q.name.toLowerCase().includes('shadowfax')) ||
                          (q.courierPartner && q.courierPartner.toLowerCase().includes('shadowfax'));
      if (isDelhivery) {
        nimbusDelhiveryQuotes.push(q);
      } else if (isShadowfax) {
        nimbusShadowfaxQuotes.push(q);
      } else {
        nonArbitragedNimbusQuotes.push(q);
      }
    }

    // 1. Compare Direct Delhivery with Nimbus Delhivery and pick whichever is lower
    let winningDelhiveryQuote = null;

    if (directDelhiveryQuote && nimbusDelhiveryQuotes.length > 0) {
      nimbusDelhiveryQuotes.sort((a, b) => a.price - b.price);
      const cheapestNimbusDelhivery = nimbusDelhiveryQuotes[0];

      if (directDelhiveryQuote.price <= cheapestNimbusDelhivery.price) {
        // Direct Delhivery is cheaper or equal
        const savings = Math.max(0, parseFloat((cheapestNimbusDelhivery.price - directDelhiveryQuote.price).toFixed(2)));
        directDelhiveryQuote.rateSavings = savings;
        directDelhiveryQuote.savingsBadge = savings > 0 
          ? `Direct Delhivery (Save ₹${savings} vs Nimbus)` 
          : 'Direct Delhivery (Lowest Rate)';
        directDelhiveryQuote.isArbitrageWinner = true;
        directDelhiveryQuote.arbitrageSource = 'delhivery_direct';
        winningDelhiveryQuote = directDelhiveryQuote;
        console.log(`[Delhivery Arbitrage] Direct Delhivery selected (₹${directDelhiveryQuote.price} <= Nimbus ₹${cheapestNimbusDelhivery.price}). Saved ₹${savings}`);
      } else {
        // NimbusPost Delhivery is cheaper!
        const savings = Math.max(0, parseFloat((directDelhiveryQuote.price - cheapestNimbusDelhivery.price).toFixed(2)));
        cheapestNimbusDelhivery.rateSavings = savings;
        cheapestNimbusDelhivery.savingsBadge = savings > 0 
          ? `Nimbus Delhivery Promo (Save ₹${savings} vs Direct)` 
          : 'Nimbus Delhivery (Lowest Rate)';
        cheapestNimbusDelhivery.isArbitrageWinner = true;
        cheapestNimbusDelhivery.arbitrageSource = 'nimbuspost';
        winningDelhiveryQuote = cheapestNimbusDelhivery;
        console.log(`[Delhivery Arbitrage] Nimbus Delhivery selected (₹${cheapestNimbusDelhivery.price} < Direct ₹${directDelhiveryQuote.price}). Saved ₹${savings}`);
      }
    } else if (directDelhiveryQuote) {
      directDelhiveryQuote.savingsBadge = 'Direct Delhivery Live';
      directDelhiveryQuote.isArbitrageWinner = true;
      directDelhiveryQuote.arbitrageSource = 'delhivery_direct';
      winningDelhiveryQuote = directDelhiveryQuote;
    } else if (nimbusDelhiveryQuotes.length > 0) {
      nimbusDelhiveryQuotes.sort((a, b) => a.price - b.price);
      winningDelhiveryQuote = nimbusDelhiveryQuotes[0];
      winningDelhiveryQuote.savingsBadge = 'Nimbus Delhivery';
      winningDelhiveryQuote.isArbitrageWinner = true;
      winningDelhiveryQuote.arbitrageSource = 'nimbuspost';
    }

    // 2. Compare Direct Shadowfax with Nimbus Shadowfax and pick whichever is lower
    let winningShadowfaxQuote = null;

    if (directShadowfaxQuote && nimbusShadowfaxQuotes.length > 0) {
      nimbusShadowfaxQuotes.sort((a, b) => a.price - b.price);
      const cheapestNimbusShadowfax = nimbusShadowfaxQuotes[0];

      if (directShadowfaxQuote.price <= cheapestNimbusShadowfax.price) {
        // Direct Shadowfax is cheaper or equal
        const savings = Math.max(0, parseFloat((cheapestNimbusShadowfax.price - directShadowfaxQuote.price).toFixed(2)));
        directShadowfaxQuote.rateSavings = savings;
        directShadowfaxQuote.savingsBadge = savings > 0 
          ? `Direct Shadowfax (Save ₹${savings} vs Nimbus)` 
          : 'Direct Shadowfax (Lowest Rate)';
        directShadowfaxQuote.isArbitrageWinner = true;
        directShadowfaxQuote.arbitrageSource = 'shadowfax_direct';
        winningShadowfaxQuote = directShadowfaxQuote;
        console.log(`[Shadowfax Arbitrage] Direct Shadowfax selected (₹${directShadowfaxQuote.price} <= Nimbus ₹${cheapestNimbusShadowfax.price}). Saved ₹${savings}`);
      } else {
        // NimbusPost Shadowfax is cheaper!
        const savings = Math.max(0, parseFloat((directShadowfaxQuote.price - cheapestNimbusShadowfax.price).toFixed(2)));
        cheapestNimbusShadowfax.rateSavings = savings;
        cheapestNimbusShadowfax.savingsBadge = savings > 0 
          ? `Nimbus Shadowfax Promo (Save ₹${savings} vs Direct)` 
          : 'Nimbus Shadowfax (Lowest Rate)';
        cheapestNimbusShadowfax.isArbitrageWinner = true;
        cheapestNimbusShadowfax.arbitrageSource = 'nimbuspost';
        winningShadowfaxQuote = cheapestNimbusShadowfax;
        console.log(`[Shadowfax Arbitrage] Nimbus Shadowfax selected (₹${cheapestNimbusShadowfax.price} < Direct ₹${directShadowfaxQuote.price}). Saved ₹${savings}`);
      }
    } else if (directShadowfaxQuote) {
      directShadowfaxQuote.savingsBadge = 'Direct Shadowfax Live';
      directShadowfaxQuote.isArbitrageWinner = true;
      directShadowfaxQuote.arbitrageSource = 'shadowfax_direct';
      winningShadowfaxQuote = directShadowfaxQuote;
    } else if (nimbusShadowfaxQuotes.length > 0) {
      nimbusShadowfaxQuotes.sort((a, b) => a.price - b.price);
      winningShadowfaxQuote = nimbusShadowfaxQuotes[0];
      winningShadowfaxQuote.savingsBadge = 'Nimbus Shadowfax';
      winningShadowfaxQuote.isArbitrageWinner = true;
      winningShadowfaxQuote.arbitrageSource = 'nimbuspost';
    }

    // Filter out duplicate Delhivery and Shadowfax entries from Shiprocket to keep only the single best winning rates
    const nonArbitragedShiprocketQuotes = shiprocketQuotes.filter(q => {
      const isDelhivery = (q.baseSlug === 'delhivery') || 
                          (q.slug && q.slug.toLowerCase().includes('delhivery'));
      const isShadowfax = (q.baseSlug === 'shadowfax') || 
                          (q.slug && q.slug.toLowerCase().includes('shadowfax'));
      return !isDelhivery && !isShadowfax;
    });

    // Merge quotes: winning Delhivery rate + winning Shadowfax rate + other Nimbus carriers + other Shiprocket carriers
    const combinedQuotes = [
      ...(winningDelhiveryQuote ? [winningDelhiveryQuote] : []),
      ...(winningShadowfaxQuote ? [winningShadowfaxQuote] : []),
      ...nonArbitragedNimbusQuotes,
      ...nonArbitragedShiprocketQuotes
    ];

    // Sort all carrier quotes cheapest first
    combinedQuotes.sort((a, b) => a.price - b.price);

    // Clear previous lowest flags and set the recommended cheapest carrier overall
    combinedQuotes.forEach(q => {
      q.isLowest = false;
      q.isRecommended = false;
    });

    if (combinedQuotes.length > 0) {
      combinedQuotes[0].isLowest = true;
      combinedQuotes[0].isRecommended = true;
    }

    return combinedQuotes;
  }, 900, { tags: ['logistics:rates'] }); // 15-minute TTL complying with courier quote validity
};

/**
 * Returns supported courier partners metadata (slowly changing public data).
 * Cached for 24 hours.
 */
const getSupportedCouriersList = async () => {
  const cacheKey = cacheManager.generateKey('logistics:couriers', { v: 1 });
  return cacheManager.getOrSet(cacheKey, async () => {
    return Object.entries(CARRIER_NAMES).map(([slug, name]) => ({
      slug,
      name,
      rating: CARRIER_RATINGS[slug] || 4.5,
      aggregatorsSupported: ['Shiprocket', 'NimbusPost'],
      surfaceSupported: true,
      airSupported: ['bluedart', 'delhivery', 'shadowfax'].includes(slug),
      codSupported: true,
      reversePickupSupported: ['delhivery', 'shadowfax', 'xpressbees', 'ekart'].includes(slug),
      insuranceSupported: true
    }));
  }, 86400, ['logistics:couriers']);
};

/**
 * Compares rates across ALL popular courier partners (Delhivery, Shadowfax, Ekart,
 * Xpressbees, DTDC, BlueDart, Ecom Express, India Post) through the Shiprocket
 * Multi-Carrier Engine and selects the partner with the cheapest delivery charge.
 *
 * @param {string} fromPincode - Sender pickup pincode
 * @param {string} toPincode   - Receiver destination pincode
 * @param {number} weightKg    - Parcel weight in kg
 * @param {object|null} dimensions - Optional { length, width, height } in cm
 * @param {boolean} isReverse  - Whether this is a reverse pickup shipment
 * @returns {object} { cheapest, comparison, allQuotes, isReverse, apiProvider, totalCouriersCompared, savingsAmount }
 */
const getCheapestPickupCarrier = (fromPincode, toPincode, weightKg = 0.5, dimensions = null, isReverse = false) => {
  const srQuotes = getCarrierRates(fromPincode, toPincode, weightKg, dimensions, isReverse);
  const nimbusQuotes = getRealisticNimbusQuotes(fromPincode, toPincode, weightKg, false, 0, !isReverse);
  
  // Combine all quotes from both Shiprocket and NimbusPost
  const allQuotes = [...srQuotes, ...nimbusQuotes];
  allQuotes.sort((a, b) => a.price - b.price);

  allQuotes.forEach(q => {
    q.isLowest = false;
    q.isRecommended = false;
  });

  if (allQuotes.length > 0) {
    allQuotes[0].isLowest = true;
    allQuotes[0].isRecommended = true;
  }

  const cheapest = allQuotes[0];
  const highest = allQuotes[allQuotes.length - 1];
  const savingsAmount = parseFloat((highest.price - cheapest.price).toFixed(2));

  return {
    cheapest,
    comparison: allQuotes, // All popular courier partners compared across Shiprocket & NimbusPost
    allQuotes,
    isReverse,
    apiProvider: 'SecureKaro Hybrid Logistics Engine (Shiprocket + NimbusPost)',
    totalCouriersCompared: allQuotes.length,
    savingsAmount
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// ODA (Out of Delivery Area) pincode detection
// NE states: 785xxx–799xxx, J&K/Ladakh: 180xxx–194xxx, Andaman: 744xxx
// ─────────────────────────────────────────────────────────────────────────────
const ODA_PREFIXES = new Set([
  // North-East India
  '785','786','787','788','789','790','791','792','793','794','795','796','797','798','799',
  // Jammu & Kashmir / Ladakh
  '180','181','182','183','184','185','186','187','188','189','190','191','192','193','194',
  // Andaman & Nicobar
  '744',
  // Lakshadweep
  '682',
]);

function isODAPincode(pincode) {
  const prefix = String(pincode || '').trim().substring(0, 3);
  return ODA_PREFIXES.has(prefix);
}

// ─────────────────────────────────────────────────────────────────────────────
// Smart Routing Badges — attached to each rate card quote
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Attach smart routing badges to each quote in the rates array.
 * Badges guide sellers to pick the cheapest/best option for their scenario.
 *
 * @param {Array} quotes - Array of carrier rate quotes
 * @param {boolean} isCod - Whether order is COD
 * @param {number} weightKg - Parcel weight
 * @param {number} orderValue - Declared order value
 * @param {string} toPin - Destination pincode
 * @returns {Array} quotes with `badges` array and `smartScore` attached
 */
function attachSmartBadges(quotes, isCod = false, weightKg = 0.5, orderValue = 0, toPin = '') {
  if (!Array.isArray(quotes) || quotes.length === 0) return quotes;

  const isODA = isODAPincode(toPin);
  const sorted = [...quotes].sort((a, b) => (a.totalCharge || a.price) - (b.totalCharge || b.price));
  const cheapestTotal = sorted[0]?.totalCharge || sorted[0]?.price || 0;

  return quotes.map(q => {
    const badges = [];
    const slug = (q.slug || q.baseSlug || q.aggregator || '').toLowerCase();
    const name = (q.name || q.courierPartner || '').toLowerCase();
    const isShadowfax = slug.includes('shadowfax') || name.includes('shadowfax');
    const isNimbus = (q.aggregator || '').toLowerCase() === 'nimbuspost' || name.includes('nimbuspost');
    const isIndiaPost = slug.includes('indiapost') || name.includes('india post');
    const isBlueDart = slug.includes('bluedart') || name.includes('blue dart') || name.includes('bluedart');
    const total = q.totalCharge || q.price || 0;
    const isCheapest = Math.abs(total - cheapestTotal) < 0.5;

    // 🏆 Best for COD — Shadowfax has ₹0 COD handling fee
    if (isCod && isShadowfax) {
      badges.push({ label: 'Best for COD', icon: '🏆', color: 'gold', reason: '₹0 COD handling fee' });
    }

    // 🛡️ RTO Shield — Shadowfax has ₹0 RTO charge
    if (isShadowfax) {
      badges.push({ label: 'RTO Shield', icon: '🛡️', color: 'green', reason: '₹0 RTO return charge' });
    }

    // 💰 Cheapest — Lowest total rate among all quotes
    if (isCheapest) {
      badges.push({ label: 'Lowest Rate', icon: '💰', color: 'blue', reason: 'Cheapest option available' });
    }

    // 📦 Best for Heavy — NimbusPost has better slab pricing for heavy parcels
    if (isNimbus && weightKg > 3) {
      badges.push({ label: 'Best for Heavy', icon: '📦', color: 'teal', reason: 'Best slab rates for heavy parcels' });
    }

    // 🗺️ Remote Coverage — India Post for ODA pincodes
    if (isODA && isIndiaPost) {
      badges.push({ label: 'Remote Area', icon: '🗺️', color: 'purple', reason: 'No ODA surcharge for NE/J&K' });
    }

    // 🔒 High Value Safe — BlueDart for high value orders
    if (orderValue > 5000 && isBlueDart) {
      badges.push({ label: 'High Value Safe', icon: '🔒', color: 'darkblue', reason: 'Best for high-value shipments' });
    }

    // ⚡ Platform Recommended — Shadowfax COD orders or cheapest prepaid
    const isRecommended = isCod ? isShadowfax : isCheapest;

    return {
      ...q,
      badges,
      isRecommended: q.isRecommended || isRecommended,
      smartScore: (isShadowfax && isCod ? 100 : 0) + (isCheapest ? 80 : 0) + badges.length * 5
    };
  }).sort((a, b) => b.smartScore - a.smartScore);
}

/**
 * Get the smart routing recommendation for a shipment.
 * Returns the best carrier slug + rationale.
 *
 * @param {Array} quotes - Rated carrier quotes
 * @param {boolean} isCod - COD order?
 * @param {number} weightKg - Weight in kg
 * @param {number} orderValue - Order value (for high-value routing)
 * @param {string} toPin - Destination pincode
 * @returns {{ carrier: string, reason: string, badges: Array }}
 */
function getSmartRecommendation(quotes, isCod = false, weightKg = 0.5, orderValue = 0, toPin = '') {
  if (!Array.isArray(quotes) || quotes.length === 0) {
    return { carrier: null, reason: 'No quotes available', badges: [] };
  }

  // Rule 1: ODA pincode → India Post
  if (isODAPincode(toPin)) {
    const indiaPost = quotes.find(q => {
      const s = (q.slug || q.baseSlug || '').toLowerCase();
      const n = (q.name || q.courierPartner || '').toLowerCase();
      return s.includes('indiapost') || n.includes('india post');
    });
    if (indiaPost) return {
      carrier: indiaPost.slug || indiaPost.baseSlug,
      reason: '🗺️ Remote/ODA area — India Post has no extra ODA surcharge for NE states / J&K / Andaman',
      badges: [{ label: 'Remote Area', icon: '🗺️', color: 'purple' }]
    };
  }

  // Rule 2: COD order → Shadowfax (₹0 COD + ₹0 RTO = maximum savings)
  if (isCod) {
    const shadowfax = quotes.find(q => {
      const s = (q.slug || q.baseSlug || '').toLowerCase();
      const n = (q.name || q.courierPartner || '').toLowerCase();
      return s.includes('shadowfax') || n.includes('shadowfax');
    });
    if (shadowfax) return {
      carrier: shadowfax.slug || shadowfax.baseSlug,
      reason: '🏆 COD order — Shadowfax charges ₹0 COD fee + ₹0 RTO. Saves ₹50–₹100 vs other couriers.',
      badges: [
        { label: 'Best for COD', icon: '🏆', color: 'gold' },
        { label: 'RTO Shield', icon: '🛡️', color: 'green' }
      ]
    };
  }

  // Rule 3: High-value prepaid (>₹5000) → BlueDart
  if (!isCod && orderValue > 5000) {
    const blueDart = quotes.find(q => {
      const s = (q.slug || q.baseSlug || '').toLowerCase();
      return s.includes('bluedart');
    });
    if (blueDart) return {
      carrier: blueDart.slug || blueDart.baseSlug,
      reason: '🔒 High-value order — BlueDart offers premium reliability and implicit shipment insurance.',
      badges: [{ label: 'High Value Safe', icon: '🔒', color: 'darkblue' }]
    };
  }

  // Rule 4: Heavy parcel (>3kg) → NimbusPost
  if (weightKg > 3) {
    const nimbus = quotes.find(q => (q.aggregator || '').toLowerCase() === 'nimbuspost');
    if (nimbus) return {
      carrier: nimbus.slug || nimbus.baseSlug,
      reason: '📦 Heavy parcel — NimbusPost has better per-slab pricing for heavy shipments with no hidden surcharges.',
      badges: [{ label: 'Best for Heavy', icon: '📦', color: 'teal' }]
    };
  }

  // Rule 5: Default → Cheapest prepaid option
  const sorted = [...quotes].sort((a, b) => (a.totalCharge || a.price) - (b.totalCharge || b.price));
  const cheapest = sorted[0];
  return {
    carrier: cheapest.slug || cheapest.baseSlug,
    reason: '💰 Cheapest prepaid option available for this pincode route.',
    badges: [{ label: 'Lowest Rate', icon: '💰', color: 'blue' }]
  };
}

module.exports = {
  getCarrierRates,
  getCarrierRatesAsync,
  fetchLiveShiprocketRates,
  getPincodeInfo,
  getZone,
  getCheapestPickupCarrier,
  getSupportedCouriersList,
  attachSmartBadges,
  getSmartRecommendation,
  isODAPincode,
};

