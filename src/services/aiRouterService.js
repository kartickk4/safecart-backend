/**
 * aiRouterService.js
 * Intelligent Multi-Provider AI Routing Service for SecureKaro.
 * 
 * Dynamically routes requests across Groq, Google Gemini, and Cloudflare Workers AI:
 * - Ultra-Fast Text & Chat: Groq (Llama 3.3 70B / Llama 3.1 8B) for ~300ms responses
 * - Vision & OCR: Google Gemini (Gemini 2.0/3.5 Flash) for handwritten chits & invoice scans
 * - Fallback & Redundancy: Seamless failover (Groq -> Gemini -> Cloudflare AI) to eliminate 429 quota exhaustion
 * - Voice Audio: Groq Whisper / Cloudflare Whisper for merchant voice notes
 * - Embeddings & Translation: Cloudflare Workers AI
 */

const https = require('https');
const geminiService = require('./geminiService');

// ── Provider Configuration Helpers ─────────────────────────────────────────

function getGroqApiKey() {
  return (process.env.GROQ_API_KEY || '').trim();
}

function getCloudflareConfig() {
  const accountId = (process.env.CLOUDFLARE_AI_ACCOUNT_ID || process.env.CLOUDFLARE_R2_ACCOUNT_ID || '').trim();
  const apiToken = (process.env.CLOUDFLARE_AI_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN || '').trim();
  return {
    accountId,
    apiToken,
    isConfigured: Boolean(accountId && apiToken)
  };
}

function getGeminiApiKey() {
  return (process.env.GEMINI_API_KEY || '').trim();
}

/**
 * Returns current operational status of all AI providers
 */
function getProviderStatus() {
  const groq = Boolean(getGroqApiKey());
  const gemini = Boolean(getGeminiApiKey());
  const cf = getCloudflareConfig().isConfigured;

  let primaryTextProvider = 'None';
  if (groq) primaryTextProvider = 'Groq (GPT-OSS 120B / Fast)';
  else if (gemini) primaryTextProvider = 'Google Gemini (Flash Lite)';
  else if (cf) primaryTextProvider = 'Cloudflare Workers AI (Llama 3.1 8B)';

  return {
    groq,
    gemini,
    cloudflare: cf,
    primaryTextProvider,
    visionProvider: gemini ? 'Google Gemini Vision' : 'Not Configured',
    totalActiveProviders: (groq ? 1 : 0) + (gemini ? 1 : 0) + (cf ? 1 : 0)
  };
}

// ── Generic HTTP Request Helper (No External Dependencies) ──────────────────

function makeHttpsRequest({ hostname, path, method = 'POST', headers = {}, body, timeout = 8000 }) {
  return new Promise((resolve, reject) => {
    const postData = typeof body === 'string' ? body : JSON.stringify(body);
    const reqHeaders = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
      ...headers
    };

    const req = https.request({
      hostname,
      path,
      method,
      headers: reqHeaders,
      timeout
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const errorMsg = parsed?.error?.message || parsed?.errors?.[0]?.message || `HTTP ${res.statusCode}: ${data.slice(0, 200)}`;
            const err = new Error(errorMsg);
            err.statusCode = res.statusCode;
            err.response = parsed;
            reject(err);
          }
        } catch (e) {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(`Failed to parse response (HTTP ${res.statusCode}): ${data.slice(0, 200)}`));
          }
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request timeout (${timeout}ms) to ${hostname}`));
    });

    req.on('error', (err) => reject(err));
    req.write(postData);
    req.end();
  });
}

// ── Robust JSON Extractor ──────────────────────────────────────────────────

function cleanAndParseJson(text) {
  if (!text || typeof text !== 'string') return null;
  let cleaned = text.trim();
  // Strip markdown ```json ... ``` code blocks if present
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }
  // Find first { and last }
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.substring(firstBrace, lastBrace + 1);
  }
  return JSON.parse(cleaned);
}

// ── Provider 1: Groq AI (Ultra-Low Latency Inference) ──────────────────────

const GROQ_MODELS = [
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'qwen/qwen3.8-27b',
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant'
];

async function callGroq({ messages, json = false, temperature = 0.2, maxTokens = 1200 }) {
  const apiKey = getGroqApiKey();
  if (!apiKey) {
    throw new Error('GROQ_API_KEY is not configured');
  }

  let lastError = null;
  for (const model of GROQ_MODELS) {
    try {
      const requestPayload = {
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false
      };
      if (json) {
        requestPayload.response_format = { type: 'json_object' };
      }

      const res = await makeHttpsRequest({
        hostname: 'api.groq.com',
        path: '/openai/v1/chat/completions',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`
        },
        body: requestPayload,
        timeout: 7000
      });

      const reply = res.choices?.[0]?.message?.content;
      if (reply) {
        return { text: reply.trim(), model, provider: 'groq' };
      }
    } catch (err) {
      console.warn(`[AI Router] Groq model ${model} failed:`, err.message);
      lastError = err;
      // If error is 429 (rate limit) or model error, try next model
    }
  }
  throw lastError || new Error('All Groq models failed');
}

// ── Provider 2: Cloudflare Workers AI ──────────────────────────────────────

async function callCloudflareAI({ messages, model = '@cf/meta/llama-3.1-8b-instruct', maxTokens = 1200 }) {
  const cf = getCloudflareConfig();
  if (!cf.isConfigured) {
    throw new Error('Cloudflare Workers AI credentials not configured (CLOUDFLARE_AI_ACCOUNT_ID and CLOUDFLARE_AI_API_TOKEN required)');
  }

  const res = await makeHttpsRequest({
    hostname: 'api.cloudflare.com',
    path: `/client/v4/accounts/${cf.accountId}/ai/run/${model}`,
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cf.apiToken}`
    },
    body: {
      messages,
      max_tokens: maxTokens
    },
    timeout: 8000
  });

  const reply = res?.result?.response || (typeof res?.result === 'string' ? res.result : null);
  if (reply) {
    return { text: reply.trim(), model, provider: 'cloudflare' };
  }
  throw new Error('Empty response from Cloudflare Workers AI');
}

// ── Unified Text Completion Router (Groq -> Gemini -> Cloudflare AI) ───────

async function routeTextCompletion({ messages, systemInstruction = '', temperature = 0.3, maxTokens = 1200, json = false }) {
  const formattedMessages = [];
  if (systemInstruction) {
    formattedMessages.push({ role: 'system', content: systemInstruction });
  }
  formattedMessages.push(...messages);

  // 1. Try Groq (Primary for speed & low cost)
  if (getGroqApiKey()) {
    try {
      const result = await callGroq({
        messages: formattedMessages,
        json,
        temperature,
        maxTokens
      });
      return result;
    } catch (groqErr) {
      console.warn('[AI Router] Groq failed, failing over to Gemini:', groqErr.message);
    }
  }

  // 2. Try Gemini (Secondary fallback)
  if (getGeminiApiKey()) {
    try {
      const geminiBody = {
        contents: messages.map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }]
        })),
        systemInstruction: systemInstruction ? {
          parts: [{ text: systemInstruction }]
        } : undefined,
        generationConfig: {
          temperature,
          maxOutputTokens: maxTokens,
          responseMimeType: json ? 'application/json' : 'text/plain'
        }
      };

      // Call internal Gemini fallback executor
      const text = await geminiService.generateWithFallback
        ? await geminiService.generateWithFallback(geminiBody)
        : null;

      if (text) {
        return { text: text.trim(), model: 'gemini', provider: 'gemini' };
      }
    } catch (geminiErr) {
      console.warn('[AI Router] Gemini failed, failing over to Cloudflare AI:', geminiErr.message);
    }
  }

  // 3. Try Cloudflare Workers AI (Tertiary fallback)
  const cf = getCloudflareConfig();
  if (cf.isConfigured) {
    try {
      const result = await callCloudflareAI({
        messages: formattedMessages,
        maxTokens
      });
      return result;
    } catch (cfErr) {
      console.warn('[AI Router] Cloudflare Workers AI failed:', cfErr.message);
    }
  }

  throw new Error('All AI providers (Groq, Gemini, Cloudflare AI) failed or are unconfigured.');
}

// ── 1-Click WhatsApp / Unstructured Order Extractor ─────────────────────────

async function extractOrderFromText(rawText) {
  if (!rawText || rawText.trim().length < 8) return null;

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
    '  "weightKg": number or null (ONLY if explicitly stated in text; return null if missing — DO NOT guess or default),\n' +
    '  "amount": number or null (item/COD amount in INR ONLY if explicitly stated; return null if missing — DO NOT guess),\n' +
    '  "paymentMode": "cod" or "prepaid" or null (ONLY set if COD/cash/prepaid/paid is explicitly stated; return null if not clearly stated — DO NOT guess),\n' +
    '  "description": string or null (item name ONLY if stated, else null)\n' +
    "}\n" +
    "Only set isOrder: false if the input is purely a greeting or irrelevant conversation with zero address/contact info.";

  // 1. Try Groq for instant parsing (<300ms)
  if (getGroqApiKey()) {
    try {
      const result = await callGroq({
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: `Parse this customer text into JSON:\n"""\n${rawText}\n"""` }
        ],
        json: true,
        temperature: 0.1,
        maxTokens: 800
      });

      const parsed = cleanAndParseJson(result.text);
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
    } catch (groqErr) {
      console.warn('[AI Router] Groq text extraction failed, trying Gemini:', groqErr.message);
    }
  }

  // 2. Fallback to Gemini
  try {
    const geminiResult = await geminiService.extractOrderFromText(rawText);
    if (geminiResult) return geminiResult;
  } catch (geminiErr) {
    console.warn('[AI Router] Gemini text extraction failed:', geminiErr.message);
  }

  // 3. Fallback to Cloudflare Workers AI
  const cf = getCloudflareConfig();
  if (cf.isConfigured) {
    try {
      const cfResult = await callCloudflareAI({
        messages: [
          { role: 'system', content: `${systemInstruction}\nYou must output valid JSON only.` },
          { role: 'user', content: `Parse this customer text:\n"""\n${rawText}\n"""` }
        ],
        maxTokens: 800
      });
      const parsed = cleanAndParseJson(cfResult.text);
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
    } catch (cfErr) {
      console.warn('[AI Router] Cloudflare text extraction failed:', cfErr.message);
    }
  }

  return null;
}

// ── 1-Click Vision / OCR Order Extractor (Delegates to Multimodal Gemini) ──

async function extractOrderFromImage(imageBase64, imageMimeType = 'image/jpeg') {
  // Vision OCR requires multimodal vision capabilities, which Google Gemini specializes in.
  // We delegate to geminiService.extractOrderFromImage which handles handwritten slips, WhatsApp chits, labels.
  return geminiService.extractOrderFromImage(imageBase64, imageMimeType);
}

// ── Intelligent Conversational Assistant ────────────────────────────────────

async function answerMerchantQuery({ query, user, context }) {
  const systemInstruction =
    "You are the official SecureKaro AI Agent — an autonomous, polite, and highly skilled e-commerce logistics copilot in India.\n" +
    "Verified SecureKaro Facts (NEVER invent fake numbers or claim 'SecureKaro Escrow'):\n" +
    "- Serviceable Reach: 29,000+ Indian pincodes pan-India across Tier 1, 2, 3 towns and remote areas.\n" +
    "- Courier Partners: Delhivery, Shadowfax, Xpressbees, Ekart, BlueDart, DTDC, Ecom Express, India Post, and Amazon Shipping (Direct API + NimbusPost/Shiprocket multi-carrier routing).\n" +
    "- Prepaid Booking: Seller pays only the courier delivery charge upfront from the SecureKaro Wallet and courier pickup is scheduled immediately (NO buyer payment link is sent via WhatsApp or SMS).\n" +
    "- COD Booking: Courier collects the order amount from the buyer at delivery. COD handling fee depends strictly on the courier partner chosen: Shadowfax Direct charges ₹0 COD fee (Free), while other aggregators/couriers (Delhivery, Ekart, BlueDart, Xpressbees, DTDC) charge their partner fee (~₹40–₹50). Upfront freight + partner COD fee is settled from the seller wallet.\n" +
    "- Optional Protections (BOTH OFF by default until seller enables): 24h Return Protection and Smart RTO Protection (₹40 relief per undelivered Prepaid parcel). Also includes Weight Shield and WhatsApp NDR recovery.\n\n" +
    "Guidelines:\n" +
    "- NEVER use the word 'Escrow' or 'SecureKaro Escrow'. Refer to 'SecureKaro Delivery Protection' instead.\n" +
    "- NEVER claim a buyer payment link is sent for bookings.\n" +
    "- Respond completely without cutting off mid-sentence, using crisp formatting (*bold*) and concise bullet points (2-4 short paragraphs max).\n" +
    "- If the user asks in Hinglish or Hindi, answer naturally in friendly Hinglish/Hindi.\n" +
    "- Never invent fake tracking numbers or false account balances.";

  const userContextInfo =
    `Merchant Name: ${user.fullName || 'Merchant'}\n` +
    `Merchant Pincode: ${user.pincode || '110001'}\n` +
    `Available Wallet Balance: ₹${user.walletBalance || 0}\n` +
    `Recent Shipments Context: ${JSON.stringify(context?.recentShipments || [])}\n` +
    `In-Transit Shipment Value: ₹${context?.pipelineFunds || 0}\n` +
    `Referral Code: ${user.referralCode || 'SK-GROW'}`;

  const prompt = `Live Merchant Context:\n${userContextInfo}\n\nMerchant Query:\n"${query}"`;

  // 1. Try Groq (Ultra-fast ~300ms response, natural tone)
  if (getGroqApiKey()) {
    try {
      const result = await callGroq({
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
        maxTokens: 1200
      });
      if (result?.text) return result.text;
    } catch (groqErr) {
      console.warn('[AI Router] Groq query failed, trying Gemini:', groqErr.message);
    }
  }

  // 2. Try Gemini
  try {
    const geminiReply = await geminiService.answerMerchantQuery({ query, user, context });
    if (geminiReply) return geminiReply;
  } catch (geminiErr) {
    console.warn('[AI Router] Gemini query failed, trying Cloudflare AI:', geminiErr.message);
  }

  // 3. Try Cloudflare Workers AI
  const cf = getCloudflareConfig();
  if (cf.isConfigured) {
    try {
      const cfResult = await callCloudflareAI({
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: prompt }
        ],
        maxTokens: 1200
      });
      if (cfResult?.text) return cfResult.text;
    } catch (cfErr) {
      console.warn('[AI Router] Cloudflare query failed:', cfErr.message);
    }
  }

  return null;
}

// ── Audio / Voice Transcription (Groq Whisper / Cloudflare Whisper) ─────────

async function transcribeAudio(audioBuffer, mimeType = 'audio/wav') {
  // 1. Try Groq Whisper (Whisper-large-v3 is free and lightning fast)
  const groqKey = getGroqApiKey();
  if (groqKey && audioBuffer) {
    try {
      // Create multipart boundary for raw audio buffer
      const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
      const filename = mimeType.includes('ogg') ? 'audio.ogg' : (mimeType.includes('mp3') ? 'audio.mp3' : 'audio.wav');
      
      const preBuffer = Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${mimeType}\r\n\r\n`
      );
      const midBuffer = Buffer.from(
        `\r\n--${boundary}\r\n` +
        `Content-Disposition: form-data; name="model"\r\n\r\n` +
        `whisper-large-v3-turbo\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="language"\r\n\r\n` +
        `en\r\n` +
        `--${boundary}--\r\n`
      );

      const fullBody = Buffer.concat([preBuffer, Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer), midBuffer]);

      const res = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'api.groq.com',
          path: '/openai/v1/audio/transcriptions',
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${groqKey}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': fullBody.length
          },
          timeout: 10000
        }, (res) => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error(`Failed to parse Groq Whisper response: ${data}`));
            }
          });
        });
        req.on('error', reject);
        req.write(fullBody);
        req.end();
      });

      if (res?.text) {
        return { text: res.text.trim(), provider: 'groq-whisper' };
      }
    } catch (groqWhisperErr) {
      console.warn('[AI Router] Groq Whisper failed, trying Cloudflare Whisper:', groqWhisperErr.message);
    }
  }

  // 2. Try Cloudflare Whisper
  const cf = getCloudflareConfig();
  if (cf.isConfigured && audioBuffer) {
    try {
      const buffer = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer);
      const res = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'api.cloudflare.com',
          path: `/client/v4/accounts/${cf.accountId}/ai/run/@cf/openai/whisper`,
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${cf.apiToken}`,
            'Content-Type': 'application/octet-stream',
            'Content-Length': buffer.length
          },
          timeout: 12000
        }, (res) => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error(`Failed to parse Cloudflare Whisper response: ${data}`));
            }
          });
        });
        req.on('error', reject);
        req.write(buffer);
        req.end();
      });

      if (res?.result?.text) {
        return { text: res.result.text.trim(), provider: 'cloudflare-whisper' };
      }
    } catch (cfWhisperErr) {
      console.warn('[AI Router] Cloudflare Whisper failed:', cfWhisperErr.message);
    }
  }

  return null;
}

// ── Multilingual Translation Helper ─────────────────────────────────────────

async function translateText(text, targetLang = 'hi') {
  if (!text) return text;
  const langNames = {
    hi: 'Hindi',
    bn: 'Bengali',
    te: 'Telugu',
    ta: 'Tamil',
    mr: 'Marathi',
    gu: 'Gujarati',
    en: 'English'
  };
  const targetName = langNames[targetLang] || targetLang;

  // Quick Groq translation
  if (getGroqApiKey()) {
    try {
      const res = await callGroq({
        messages: [
          { role: 'system', content: `You are a professional Indian language translator. Translate the given text accurately into ${targetName}. Maintain all courier/shipping terminology, numbers, PIN codes, and phone numbers unchanged. Return ONLY the translated string with no explanations.` },
          { role: 'user', content: text }
        ],
        temperature: 0.1,
        maxTokens: 500
      });
      if (res?.text) return res.text;
    } catch (err) {
      console.warn('[AI Router] Groq translation failed:', err.message);
    }
  }

  return text;
}

// ── Vector Embeddings Helper (Cloudflare Workers AI) ────────────────────────

async function generateEmbeddings(text) {
  const cf = getCloudflareConfig();
  if (!cf.isConfigured || !text) return null;

  try {
    const res = await makeHttpsRequest({
      hostname: 'api.cloudflare.com',
      path: `/client/v4/accounts/${cf.accountId}/ai/run/@cf/baai/bge-base-en-v1.5`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cf.apiToken}`
      },
      body: {
        text: Array.isArray(text) ? text : [text]
      },
      timeout: 6000
    });
    return res?.result?.data?.[0] || res?.result || null;
  } catch (err) {
    console.warn('[AI Router] Cloudflare embeddings failed:', err.message);
    return null;
  }
}

module.exports = {
  // Drop-in compatible with geminiService
  extractOrderFromText,
  extractOrderFromImage,
  answerMerchantQuery,

  // New multi-provider capabilities
  routeTextCompletion,
  transcribeAudio,
  translateText,
  generateEmbeddings,
  getProviderStatus,

  // Raw callers for advanced use
  callGroq,
  callCloudflareAI
};
