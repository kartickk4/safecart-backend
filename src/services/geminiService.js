/**
 * geminiService.js
 * Google Gemini Generative AI Service for SecureKaro Logistics Copilot.
 * Uses gemini-3.5-flash with automatic fallback to gemini-3.5-flash-lite.
 */

const https = require('https');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const MODELS = ['gemini-3.5-flash', 'gemini-3.5-flash-lite'];

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
      timeout: 20000
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
 * Executes a Gemini request with dual-model fallback (flash -> flash-lite)
 */
async function generateWithFallback(body) {
  let lastError = null;
  for (const model of MODELS) {
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
    "You are an expert Indian e-commerce logistics parser for SecureKaro. " +
    "Extract shipping and parcel details from unstructured messages, customer WhatsApp chats, or address blocks. " +
    "Return strict JSON matching this schema:\n" +
    "{\n" +
    '  "isOrder": boolean, // true if this text contains an order/recipient address or intent to ship\n' +
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
    "If the text is just a general question or greeting (not an order/address), set isOrder: false.";

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
    if (parsed && parsed.isOrder) {
      // Clean phone number
      if (parsed.receiverPhone) {
        parsed.receiverPhone = String(parsed.receiverPhone).replace(/\D/g, '').slice(-10);
      }
      // Clean pincode
      if (parsed.receiverPincode) {
        const pinMatch = String(parsed.receiverPincode).match(/\b\d{6}\b/);
        parsed.receiverPincode = pinMatch ? pinMatch[0] : null;
      }
      return parsed;
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
      temperature: 0.4,
      maxOutputTokens: 600
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
 * Reads photos, screenshots (WhatsApp chat, SMS, handwritten slips, shipping labels, invoices)
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
    "You are an expert Indian e-commerce OCR and logistics parcel parser for SecureKaro.\n" +
    "You are given an image (e.g. WhatsApp conversation screenshot, customer address chit, paper invoice, handwritten label, or courier slip).\n" +
    "Carefully inspect the image, transcribe any shipping recipient details, item description, and order values, and return strict JSON matching this schema:\n" +
    "{\n" +
    '  "isOrder": boolean, // true if this image contains an order/recipient address or intent to ship\n' +
    '  "receiverName": string or null,\n' +
    '  "receiverPhone": string or null (10-digit Indian mobile number without +91 or leading 0),\n' +
    '  "receiverAddress": string or null (full street address, house/flat/building, landmark, area),\n' +
    '  "receiverPincode": string or null (6-digit Indian PIN code),\n' +
    '  "city": string or null,\n' +
    '  "weightKg": number or null (e.g. 0.5, 1.0, 2.0 - default to 0.5 if not found),\n' +
    '  "amount": number or null (item value or COD amount in INR),\n' +
    '  "paymentMode": "cod" or "prepaid" (default to "cod" if cash on delivery or amount is mentioned, "prepaid" if paid/online mentioned),\n' +
    '  "description": string or null (item/product description, e.g. \"Saree\", \"Shoes\", \"Kurtis\")\n' +
    "}\n" +
    "If the image does not show an address, customer details, or order, set isOrder: false.";

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
    if (parsed && parsed.isOrder) {
      if (parsed.receiverPhone) {
        parsed.receiverPhone = String(parsed.receiverPhone).replace(/\D/g, '').slice(-10);
      }
      if (parsed.receiverPincode) {
        const pinMatch = String(parsed.receiverPincode).match(/\b\d{6}\b/);
        parsed.receiverPincode = pinMatch ? pinMatch[0] : null;
      }
      return parsed;
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
