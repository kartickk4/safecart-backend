/**
 * geminiService.js
 * Google Gemini Generative AI Service for SecureKaro Logistics Copilot.
 * Optimized for ultra-low latency (<2s responses) using gemini-2.0-flash-lite
 * with automatic fallback to gemini-2.5-flash-lite and gemini-2.0-flash.
 */

const https = require('https');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

// Model priority: fastest → most capable. Vision OCR needs at least gemini-2.0-flash-lite.
// gemini-2.0-flash-lite: free tier, 1-2s, supports image input (vision OCR)
// gemini-2.5-flash-lite: newer, slightly slower, also supports vision
// gemini-2.0-flash: full model, highest accuracy, used as final fallback
const MODELS = ['gemini-2.0-flash-lite', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'];
// Legacy alias fallbacks tried if above all fail
const LEGACY_MODELS = ['gemini-3.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-3.5-flash'];

/**
 * Make a direct HTTPS POST request to Gemini generateContent endpoint
 */
async function callGemini(model, body) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured in environment variables');
  }

  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 8000 // Fast 8s timeout to prevent hanging users
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const err = new Error(parsed?.error?.message || `HTTP ${res.statusCode}`);
            err.statusCode = res.statusCode;
            reject(err);
          }
        } catch (e) {
          reject(new Error(`Failed to parse Gemini response: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Gemini request timeout on model ${model}`));
    });

    req.on('error', (err) => reject(err));
    req.write(postData);
    req.end();
  });
}

/**
 * Executes a Gemini request with ultra-fast fallback across standard & legacy models
 */
async function generateWithFallback(body) {
  let lastError = null;
  const candidateModels = [...MODELS, ...LEGACY_MODELS];
  for (const model of candidateModels) {
    try {
      const response = await callGemini(model, body);
      const text = response.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) {
        return text;
      }
    } catch (err) {
      console.warn(`[Gemini] Model ${model} returned error:`, err.message);
      lastError = err;
    }
  }
  throw lastError || new Error('All Gemini models failed');
}

/**
 * 1-Click WhatsApp / Unstructured Order Extractor
 * Extracts shipping recipient and parcel details from messy text, chats, or address blocks.
 */
async function extractOrderFromText(rawText) {
  if (!rawText || rawText.trim().length < 8) return null;
  if (!GEMINI_API_KEY) return null;

  const systemInstruction = 
    "You are an expert Indian e-commerce logistics parser for SecureKaro.\n" +
    "Extract shipping and parcel details from unstructured messages, customer WhatsApp chats, or address blocks.\n" +
    "Return strict JSON matching this schema:\n" +
    "{\n" +
    '  "isOrder": boolean, // ALWAYS set true if text contains any delivery address, recipient name, phone, or pincode\n' +
    '  "receiverName": string or null,\n' +
    '  "receiverPhone": string or null (10-digit Indian mobile number without +91 or leading 0),\n' +
    '  "receiverAddress": string or null (street address, landmarks, area, building),\n' +
    '  "receiverPincode": string or null (6-digit Indian PIN code),\n' +
    '  "city": string or null,\n' +
    '  "weightKg": number or null (e.g. 0.5, 1.2),\n' +
    '  "amount": number or null (item value or COD collect amount in INR),\n' +
    '  "paymentMode": "cod" or "prepaid" (default to "cod" if cash on delivery mentioned or ambiguous with an amount, "prepaid" if prepaid/online/paid mentioned),\n' +
    '  "description": string or null (item name, e.g. "2 Saree", "Sneakers")\n' +
    "}\n" +
    "Only set isOrder: false if the input is purely a greeting or irrelevant conversation with zero address/contact info.";

  const body = {
    contents: [
      { parts: [{ text: `Parse this customer text:\n"""\n${rawText}\n"""` }] }
    ],
    systemInstruction: {
      parts: [{ text: systemInstruction }]
    },
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.1
    }
  };

  try {
    const rawJson = await generateWithFallback(body);
    const parsed = JSON.parse(rawJson);
    if (parsed) {
      if (parsed.receiverPhone) {
        parsed.receiverPhone = String(parsed.receiverPhone).replace(/\D/g, '').slice(-10);
      }
      if (parsed.receiverPincode) {
        const pinMatch = String(parsed.receiverPincode).match(/\b\d{6}\b/);
        parsed.receiverPincode = pinMatch ? pinMatch[0] : null;
      }
      if (parsed.isOrder || parsed.receiverName || parsed.receiverPhone || parsed.receiverPincode || parsed.receiverAddress) {
        parsed.isOrder = true;
        return parsed;
      }
    }
    return null;
  } catch (err) {
    console.warn('[Gemini] Order extraction failed, falling back to rule parser:', err.message);
    return null;
  }
}

/**
 * Intelligent Conversational Assistant
 * Understands English, Hindi, and Hinglish queries about SecureKaro logistics.
 */
async function answerMerchantQuery({ query, user, context }) {
  if (!GEMINI_API_KEY) return null;

  const systemInstruction = 
    "You are the official SecureKaro AI Agent — an autonomous, polite, and highly skilled e-commerce logistics copilot in India.\n" +
    "SecureKaro provides escrow delivery protection, automated multi-carrier shipping (Delhivery, BlueDart, DTDC, Shadowfax), 24h buyer inspection window, and instant wallet payouts.\n\n" +
    "Guidelines:\n" +
    "- Respond politely and concisely using bolding (*bold*) and clean bullet points.\n" +
    "- Keep responses brief, crisp, and direct (max 2-3 short paragraphs).\n" +
    "- If the user asks in Hinglish or Hindi, answer naturally in friendly Hinglish/Hindi.\n" +
    "- If the user asks about live tracking, wallet balance, carrier rates, replacement policy, or disputes, provide precise, actionable guidance based on the provided live context.\n" +
    "- Never invent fake tracking numbers or false account balances.\n" +
    "- Always encourage safety, protected deliveries, and verified unboxing videos for returns.";

  const userContextInfo = 
    `Merchant Name: ${user.fullName || 'Merchant'}\n` +
    `Merchant Pincode: ${user.pincode || '110001'}\n` +
    `Available Wallet Balance: ₹${user.walletBalance || 0}\n` +
    `Recent Shipments Context: ${JSON.stringify(context?.recentShipments || [])}\n` +
    `Active Escrow Funds In Pipeline: ₹${context?.pipelineFunds || 0}\n` +
    `Referral Code: ${user.referralCode || 'SK-GROW'}`;

  const body = {
    contents: [
      { parts: [{ text: `Live Merchant Context:\n${userContextInfo}\n\nMerchant Query:\n"${query}"` }] }
    ],
    systemInstruction: {
      parts: [{ text: systemInstruction }]
    },
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 400 // Keep concise for sub-second streaming
    }
  };

  try {
    const reply = await generateWithFallback(body);
    return reply;
  } catch (err) {
    console.warn('[Gemini] Conversational query failed:', err.message);
    return null; // Triggers fallback to deterministic rule engine
  }
}

/**
 * 1-Click Vision / OCR Order Extractor
 * Reads photos, screenshots (WhatsApp chat, SMS, handwritten slips/chits, shipping labels, invoices)
 * and extracts shipping recipient and parcel details into structured JSON.
 */
async function extractOrderFromImage(imageBase64, imageMimeType = 'image/jpeg') {
  if (!imageBase64 || typeof imageBase64 !== 'string') return null;
  if (!GEMINI_API_KEY) return null;

  // Clean base64 string and detect mime type if data URI was passed
  let cleanBase64 = imageBase64.trim();
  let mimeType = imageMimeType || 'image/jpeg';

  if (cleanBase64.includes(';base64,')) {
    const parts = cleanBase64.split(';base64,');
    const match = parts[0].match(/data:(.*?)$/);
    if (match && match[1]) {
      mimeType = match[1];
    }
    cleanBase64 = parts[1];
  }

  // Basic sanity check on base64 content
  if (cleanBase64.length < 50) return null;

  const systemInstruction = 
    "You are an expert Indian logistics OCR parser for SecureKaro.\n" +
    "You are given an image that may contain an Indian customer address, handwritten paper slip/chit, WhatsApp chat screenshot, parcel label, or invoice.\n" +
    "Indian handwritten chits often have:\n" +
    "- Receiver Name (e.g. Raju Das, Rahul Sharma)\n" +
    "- Street / Locality (e.g. Padma 1st lane, Nimta, Flat 2B)\n" +
    "- City and PIN code (e.g. Kolkata - 700041, Delhi 110001)\n" +
    "- 10-digit Mobile number (e.g. 7921814321, 9876543210)\n\n" +
    "Carefully transcribe all readable text, extract the shipping recipient details, and return strict JSON matching this schema:\n" +
    "{\n" +
    '  "isOrder": boolean, // ALWAYS set true if image contains an address, person name, Indian phone number, or 6-digit pincode\n' +
    '  "receiverName": string or null,\n' +
    '  "receiverPhone": string or null (10-digit Indian mobile number without +91 or leading 0),\n' +
    '  "receiverAddress": string or null (full street address, house/flat/building, landmark, area),\n' +
    '  "receiverPincode": string or null (6-digit Indian PIN code),\n' +
    '  "city": string or null,\n' +
    '  "weightKg": number or null (default 0.5 if not explicitly written),\n' +
    '  "amount": number or null (item value or COD amount in INR),\n' +
    '  "paymentMode": "cod" or "prepaid" (default to "cod" if amount mentioned, else "prepaid"),\n' +
    '  "description": string or null (item/product description if mentioned, else null)\n' +
    "}\n" +
    "Only set isOrder: false if the image has zero text or contains completely unrelated content (e.g. random landscape photo).";

  const body = {
    contents: [
      {
        parts: [
          {
            inlineData: {
              mimeType: mimeType,
              data: cleanBase64
            }
          },
          {
            text: "Extract shipping recipient details and parcel information from this order image/screenshot."
          }
        ]
      }
    ],
    systemInstruction: {
      parts: [{ text: systemInstruction }]
    },
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.1
    }
  };

  try {
    const rawJson = await generateWithFallback(body);
    const parsed = JSON.parse(rawJson);
    if (parsed) {
      if (parsed.receiverPhone) {
        parsed.receiverPhone = String(parsed.receiverPhone).replace(/\D/g, '').slice(-10);
      }
      if (parsed.receiverPincode) {
        const pinMatch = String(parsed.receiverPincode).match(/\b\d{6}\b/);
        parsed.receiverPincode = pinMatch ? pinMatch[0] : null;
      }
      if (parsed.isOrder || parsed.receiverName || parsed.receiverPhone || parsed.receiverPincode || parsed.receiverAddress) {
        parsed.isOrder = true;
        return parsed;
      }
    }
    return null;
  } catch (err) {
    console.warn('[Gemini Vision] Image order extraction failed:', err.message);
    return null;
  }
}

module.exports = {
  extractOrderFromText,
  extractOrderFromImage,
  answerMerchantQuery
};
