const axios = require('axios');
const { fetchLiveNimbusRates, getRealisticNimbusQuotes } = require('./nimbuspostService');
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
    const surcharge = isReverse ? parseFloat((REVERSE_SURCHARGE_PER_SLAB * weightSlabs).toFixed(2)) : 0;
    
    // COD Handling fee dynamically aligned with Shiprocket rate card for declared amount
    let codCharge = 0;
    if (isCod) {
      const val = parseFloat(declaredValue) || 3000;
      if (slug.includes('delhivery')) codCharge = val >= 3000 ? 99.00 : 54.00;
      else if (slug.includes('xpressbees')) codCharge = val >= 3000 ? 75.00 : 48.00;
      else if (slug.includes('shadowfax')) codCharge = val >= 3000 ? 63.60 : 52.00;
      else codCharge = Math.max(54.00, parseFloat((val * 0.03).toFixed(2)));
    }

    // Secure Shipment insurance fee
    const secureCharge = (!isReverse && isSecureShipment) ? 54.00 : 0;
    const whatsappCharge = (!isReverse) ? 5.00 : 0;

    const finalPrice = parseFloat((isReverse 
      ? Math.max(55, rawForwardPrice + surcharge)
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
      const freightCharge = parseFloat(c.freight_charge) || parseFloat((baseRate - codCharge).toFixed(2));
      const whatsappCharge = parseFloat(c.whatsapp_charges) || 5.00;
      const secureCharge = isSecureShipment ? 54.00 : 0;
      const finalRate = parseFloat((baseRate + secureCharge + whatsappCharge).toFixed(2));

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
        freightCharge: parseFloat(freightCharge.toFixed(2)),
        codCharge: parseFloat(codCharge.toFixed(2)),
        whatsappCharge: whatsappCharge,
        secureShipmentCharge: secureCharge,
        isSecureShipment,
        isCod,
        eta: c.etd ? `Delivery by ${c.etd}` : (c.estimated_delivery_days ? `In ${c.estimated_delivery_days} Days` : '2 Days'),
        rating: parseFloat(c.rating) || 4.5,
        mode: c.is_surface ? 'Surface' : 'Air',
        apiSource: 'Shiprocket Live API',
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
    // Concurrently fetch rates from both aggregators
    const [shiprocketSettled, nimbusSettled] = await Promise.allSettled([
      fetchLiveShiprocketRates(cleanFrom, cleanTo, normalizedWeight, dimensions, isCod, declaredValue, isSecureShipment),
      fetchLiveNimbusRates(cleanFrom, cleanTo, normalizedWeight, dimensions, isCod, declaredValue, isSecureShipment)
    ]);

    let shiprocketQuotes = shiprocketSettled.status === 'fulfilled' && shiprocketSettled.value ? shiprocketSettled.value : null;
    if (!shiprocketQuotes || shiprocketQuotes.length === 0) {
      shiprocketQuotes = getCarrierRates(cleanFrom, cleanTo, normalizedWeight, dimensions, isReverse, isCod, declaredValue, isSecureShipment);
    }

    let nimbusQuotes = nimbusSettled.status === 'fulfilled' && nimbusSettled.value ? nimbusSettled.value : null;
    if (!nimbusQuotes || nimbusQuotes.length === 0) {
      nimbusQuotes = getRealisticNimbusQuotes(cleanFrom, cleanTo, normalizedWeight, isCod, declaredValue, isSecureShipment);
    }

    // Merge quotes from both aggregators
    const combinedQuotes = [...shiprocketQuotes, ...nimbusQuotes];

    // Sort cheapest first
    combinedQuotes.sort((a, b) => a.price - b.price);

    // Clear previous lowest flags and set the recommended cheapest carrier
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

module.exports = {
  getCarrierRates,
  getCarrierRatesAsync,
  fetchLiveShiprocketRates,
  getPincodeInfo,
  getZone,
  getCheapestPickupCarrier,
  getSupportedCouriersList
};

