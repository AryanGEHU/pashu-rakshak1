const express = require('express');
const router = express.Router();
const { store, generateHash } = require('../data/sharedStore');

/**
 * -------------------------------------------------------------
 * 0. TEMPORARY SERVER-SIDE REQUEST AUDIT LOGGING FOR EXOTEL
 * -------------------------------------------------------------
 */
router.use((req, res, next) => {
  const startTime = Date.now();
  const originalSend = res.send.bind(res);

  res.json = function(body) {
    res.setHeader('Content-Type', 'application/json');
    const duration = Date.now() - startTime;
    console.log(`[Exotel IVR Audit] ${new Date().toISOString()} | ${req.method} ${req.originalUrl || req.url} | Status: ${res.statusCode} | ${duration}ms`);
    console.log(`  -> Query:`, JSON.stringify(req.query));
    console.log(`  -> Response JSON:`, JSON.stringify(body));
    return originalSend(JSON.stringify(body));
  };

  res.send = function(body) {
    const duration = Date.now() - startTime;
    console.log(`[Exotel IVR Audit] ${new Date().toISOString()} | ${req.method} ${req.originalUrl || req.url} | Status: ${res.statusCode} | ${duration}ms`);
    console.log(`  -> Query:`, JSON.stringify(req.query));
    console.log(`  -> Response Body:`, typeof body === 'string' ? body.slice(0, 150) : JSON.stringify(body).slice(0, 150));
    return originalSend(body);
  };

  next();
});

/**
 * =============================================================
 * PASHU RAKSHAK - EXOTEL PROGRAMMABLE IVR INTEGRATION
 * =============================================================
 * Compatible with official Exotel Gather & Passthru specifications:
 * 1. HTTP GET query parameter handling (CallSid, CallFrom, From, digits)
 * 2. Unquoting and normalization of DTMF 'digits'
 * 3. Standard Exotel Gather JSON schema:
 *    - gather_prompt: { text: "..." }
 *    - max_input_digits: int
 *    - finish_on_key: string ("#" or "")
 *    - input_timeout: int (seconds)
 *    - repeat_menu: int
 *    - repeat_gather_prompt: { text: "..." }
 * 4. Chained flow support:
 *    Greeting / Gather (Language)
 *    -> Gather (Main Menu)
 *    -> Gather (Species)
 *    -> Gather (Symptoms)
 *    -> Gather (PIN)
 *    -> Gather (Confirmation)
 *    -> Final Confirmation TTS (Submit)
 *    -> Hangup
 * 5. Case creation with real Request ID in sharedStore
 * 6. Hindi (Devanagari) & English bilingual Text-to-Speech support
 */

/**
 * -------------------------------------------------------------
 * 1. IN-MEMORY SESSION MANAGER KEYED BY EXOTEL CallSid
 * -------------------------------------------------------------
 */
class ExotelSessionManager {
  constructor(ttlMs = 15 * 60 * 1000) {
    this.sessions = new Map();
    this.ttlMs = ttlMs;

    // Periodic cleanup of expired sessions every 5 minutes
    this.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60 * 1000);
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  get(callSid) {
    if (!callSid) return null;
    const session = this.sessions.get(callSid);
    if (!session) return null;
    if (Date.now() - session.updatedAt > this.ttlMs) {
      this.sessions.delete(callSid);
      return null;
    }
    return session;
  }

  getOrCreate(callSid, callerPhone) {
    let session = this.get(callSid);
    if (!session) {
      session = {
        callSid: callSid || `EXO-${Date.now()}`,
        callerPhone: callerPhone || '+919876543210',
        language: 'hi',
        species: null,
        symptoms: [],
        symptomsRaw: '',
        pin: null,
        diseaseResult: null,
        requestId: null,
        animalTag: null,
        step: 'INCOMING',
        retries: 0,
        createdAt: new Date().toISOString(),
        updatedAt: Date.now()
      };
      this.sessions.set(session.callSid, session);
    } else {
      if (callerPhone && (!session.callerPhone || session.callerPhone === '+919876543210')) {
        session.callerPhone = callerPhone;
      }
      session.updatedAt = Date.now();
    }
    return session;
  }

  update(callSid, updates) {
    const session = this.getOrCreate(callSid);
    Object.assign(session, updates, { updatedAt: Date.now() });
    return session;
  }

  delete(callSid) {
    return this.sessions.delete(callSid);
  }

  cleanup() {
    const now = Date.now();
    for (const [callSid, session] of this.sessions.entries()) {
      if (now - session.updatedAt > this.ttlMs) {
        this.sessions.delete(callSid);
      }
    }
  }
}

const sessionManager = new ExotelSessionManager();

/**
 * -------------------------------------------------------------
 * 2. EXOTEL REQUEST PARAMETER EXTRACTOR
 * -------------------------------------------------------------
 */
function extractExotelParams(req) {
  const source = { ...(req.query || {}), ...(req.body || {}) };

  const callSid = source.CallSid || source.callSid || source.CallUUID || source.call_sid || source.sid || 'EXO_DEV_SESSION';
  const from = source.CallFrom || source.From || source.from || source.callFrom || source.caller || source.phoneNumber || '+919876543210';

  let rawDigits = source.digits !== undefined
    ? source.digits
    : (source.Digits !== undefined
        ? source.Digits
        : (source.dtmf !== undefined
            ? source.dtmf
            : (source.DigitsGathered !== undefined ? source.DigitsGathered : source.digit)));

  let digits = '';
  if (typeof rawDigits === 'string') {
    digits = rawDigits
      .replace(/^[\s"']+|[\s"']+$/g, '') // remove outer whitespace and quotes
      .replace(/#+$/, '')               // strip trailing '#'
      .replace(/^[\s"']+|[\s"']+$/g, '') // remove any secondary quotes
      .trim();
  } else if (rawDigits !== undefined && rawDigits !== null) {
    digits = String(rawDigits).replace(/#+$/, '').trim();
  }

  const lang = source.lang || source.language || null;

  return { callSid, from, digits, lang, raw: source };
}

/**
 * -------------------------------------------------------------
 * 3. STANDARD EXOTEL GATHER JSON FORMATTER (100% SPEC COMPLIANT)
 * -------------------------------------------------------------
 * Returns ONLY the exact 6 keys accepted by Exotel's Programmable Gather validator:
 * 1. gather_prompt: { text: "..." }
 * 2. max_input_digits: int
 * 3. finish_on_key: string ("#" or "*") - NEVER empty string ""
 * 4. input_timeout: int (seconds)
 * 5. repeat_menu: int
 * 6. repeat_gather_prompt: { text: "..." } - NEVER empty text
 */
function formatExotelGatherResponse({
  prompt,
  maxDigits = 1,
  finishOnKey = '#',
  timeout = 6,
  repeatMenu = 2,
  repeatPrompt = null
}) {
  const cleanPrompt = String(prompt || '').trim();
  const cleanRepeat = (String(repeatPrompt || '').trim()) || cleanPrompt;
  const cleanFinishOnKey = (finishOnKey && typeof finishOnKey === 'string' && finishOnKey.trim() !== '')
    ? finishOnKey.trim()
    : '#';

  return {
    gather_prompt: {
      text: cleanPrompt
    },
    max_input_digits: Number(maxDigits) || 1,
    finish_on_key: cleanFinishOnKey,
    input_timeout: Number(timeout) || 6,
    repeat_menu: Number(repeatMenu) >= 0 ? Number(repeatMenu) : 2,
    repeat_gather_prompt: {
      text: cleanRepeat
    }
  };
}

/**
 * -------------------------------------------------------------
 * 4. LOGGING
 * -------------------------------------------------------------
 */
function logExotelEvent(callSid, state, details = {}) {
  const timestamp = new Date().toISOString();
  console.log(`[Exotel IVR] [${timestamp}] CallSid: ${callSid} | State: ${state} | Details:`, JSON.stringify(details));
}

/**
 * -------------------------------------------------------------
 * 5. REUSABLE BUSINESS LOGIC & CATALOGS
 * -------------------------------------------------------------
 */

// Species mapping
const SPECIES_MAP = {
  '1': 'Cattle',
  '2': 'Buffalo',
  '3': 'Swine',
  '4': 'Poultry'
};

// Symptom Catalog (Bilingual English & Hindi)
const SYMPTOM_CATALOG = {
  Cattle: {
    '1': { en: "High Fever", hi: "तेज़ बुखार" },
    '2': { en: "Skin Nodules / Lumps", hi: "त्वचा पर गांठें" },
    '3': { en: "Excessive Salivation / Drooling", hi: "मुंह से लार टपकना" },
    '4': { en: "Mouth / Foot Blisters or Lameness", hi: "खुर या मुंह में छाले और लंगड़ापन" },
    '5': { en: "Reduced Milk or Loss of Appetite", hi: "दूध या भूख में कमी" }
  },
  Buffalo: {
    '1': { en: "High Fever", hi: "तेज़ बुखार" },
    '2': { en: "Skin Nodules / Lumps", hi: "त्वचा पर गांठें" },
    '3': { en: "Excessive Salivation / Drooling", hi: "मुंह से लार टपकना" },
    '4': { en: "Mouth / Foot Blisters or Lameness", hi: "खुर या मुंह में छाले और लंगड़ापन" },
    '5': { en: "Reduced Milk or Loss of Appetite", hi: "दूध या भूख में कमी" }
  },
  Swine: {
    '1': { en: "High Fever", hi: "तेज़ बुखार" },
    '2': { en: "Skin Redness / Cyanosis", hi: "त्वचा का लाल या नीला पड़ना" },
    '3': { en: "Hemorrhages / Bleeding", hi: "रक्तस्राव" },
    '4': { en: "Sudden Deaths", hi: "अचानक मौतें" }
  },
  Poultry: {
    '1': { en: "Sudden High Mortality / Sudden Deaths", hi: "अचानक भारी मौतें" },
    '2': { en: "Swollen Face / Facial Edema", hi: "चेहरे पर सूजन" },
    '3': { en: "Greenish Droppings / Diarrhea", hi: "हरा दस्त" },
    '4': { en: "Breathing Trouble / Respiratory Distress", hi: "सांस लेने में तकलीफ" }
  }
};

// Evaluate Disease & Risk based on ICAR/WOAH clinical guidelines
function evaluateDisease(species, symptomDigits) {
  const digitsStr = String(symptomDigits || '');
  let suspectedDisease = "Bovine Infection / Unspecified";
  let aiRiskLevel = "MODERATE";

  if (species === 'Cattle' || species === 'Buffalo') {
    if (digitsStr.includes('4') || digitsStr.includes('3')) {
      suspectedDisease = "Foot and Mouth Disease (FMD)";
      aiRiskLevel = "CRITICAL";
    } else if (digitsStr.includes('2')) {
      suspectedDisease = "Lumpy Skin Disease (LSD)";
      aiRiskLevel = "HIGH";
    } else if (digitsStr.includes('1') || digitsStr.includes('5')) {
      suspectedDisease = "Bovine Respiratory Disease (BRD)";
      aiRiskLevel = "MODERATE";
    }
  } else if (species === 'Swine') {
    if (digitsStr.includes('4') || digitsStr.includes('3') || digitsStr.includes('2') || digitsStr.includes('1')) {
      suspectedDisease = "African Swine Fever (ASF)";
      aiRiskLevel = "CRITICAL";
    } else {
      suspectedDisease = "Swine Erysipelas (Diamond Skin)";
      aiRiskLevel = "HIGH";
    }
  } else if (species === 'Poultry') {
    if (digitsStr.includes('1') || digitsStr.includes('2') || digitsStr.includes('3') || digitsStr.includes('4')) {
      suspectedDisease = "Highly Pathogenic Avian Influenza (HPAI)";
      aiRiskLevel = "CRITICAL";
    } else {
      suspectedDisease = "Newcastle Disease (Ranikhet)";
      aiRiskLevel = "HIGH";
    }
  }

  return { suspectedDisease, aiRiskLevel };
}

// Extract symptom localized & English names
function getSymptomNames(species, digitsStr, lang = 'hi') {
  const digits = String(digitsStr || '').split('').filter(d => ['1', '2', '3', '4', '5'].includes(d));
  const uniqueDigits = Array.from(new Set(digits));

  const namesEn = [];
  const namesLocal = [];

  const catalog = SYMPTOM_CATALOG[species] || SYMPTOM_CATALOG.Cattle;
  uniqueDigits.forEach(d => {
    if (catalog[d]) {
      namesEn.push(catalog[d].en);
      namesLocal.push(lang === 'hi' ? catalog[d].hi : catalog[d].en);
    }
  });

  if (namesEn.length === 0) {
    namesEn.push("General Symptoms Reported");
    namesLocal.push(lang === 'hi' ? "सामान्य लक्षण" : "General Symptoms Reported");
  }

  return { symptomsEn: namesEn, symptomsSpoken: namesLocal.join(', ') };
}

// Display name for species
function getSpeciesDisplayName(species, lang = 'hi') {
  const map = {
    Cattle: { en: "Cattle", hi: "गाय" },
    Buffalo: { en: "Buffalo", hi: "भैंस" },
    Swine: { en: "Swine", hi: "सूअर" },
    Poultry: { en: "Poultry", hi: "मुर्गी" }
  };
  const sp = map[species] || { en: species, hi: species };
  return lang === 'hi' ? sp.hi : sp.en;
}

// Haversine distance in KM
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return parseFloat((R * c).toFixed(1));
}

// Format digits for clear Text-to-Speech cadence (digit-by-digit)
function speakDigits(val) {
  return String(val || '')
    .split('')
    .join(' . ');
}

// Geocode PIN to lat/lng and Village/District/State
async function resolvePinLocation(pin) {
  const cleanPin = String(pin || '').replace(/\D/g, '').slice(0, 6);

  let poName = null;
  let district = null;
  let state = null;
  let lat = null;
  let lng = null;
  let approximateLocation = true;

  try {
    const controller1 = new AbortController();
    const timer1 = setTimeout(() => controller1.abort(), 3500);
    const pinRes = await fetch(`https://api.postalpincode.in/pincode/${encodeURIComponent(cleanPin)}`, {
      signal: controller1.signal,
      headers: { 'User-Agent': 'PashuRakshak-Exotel/1.0' }
    });
    clearTimeout(timer1);

    if (pinRes.ok) {
      const pinData = await pinRes.json();
      if (Array.isArray(pinData) && pinData[0] && pinData[0].Status === 'Success' && Array.isArray(pinData[0].PostOffice) && pinData[0].PostOffice.length > 0) {
        const po = pinData[0].PostOffice[0];
        poName = po.Name ? po.Name.trim() : null;
        district = po.District ? po.District.trim() : null;
        state = po.State ? po.State.trim() : null;
      }
    }
  } catch (err) {
    console.warn("[Exotel IVR] Postal PIN API lookup warning:", err.message);
  }

  // Known fallback dictionary for key PINs if API timed out or network offline
  const KNOWN_PIN_MAP = {
    '248002': { name: 'Clementtown', district: 'Dehradun', state: 'Uttarakhand', lat: 30.2682, lng: 78.0069 },
    '141001': { name: 'Ludhiana Central', district: 'Ludhiana', state: 'Punjab', lat: 30.8920, lng: 75.8450 },
    '141002': { name: 'Miller Ganj', district: 'Ludhiana', state: 'Punjab', lat: 30.9090, lng: 75.8516 },
    '132001': { name: 'Karnal', district: 'Karnal', state: 'Haryana', lat: 29.6857, lng: 76.9905 },
    '388001': { name: 'Anand', district: 'Anand', state: 'Gujarat', lat: 22.5645, lng: 72.9289 }
  };

  // If live API failed, check known PIN dictionary
  if (!district && KNOWN_PIN_MAP[cleanPin]) {
    const known = KNOWN_PIN_MAP[cleanPin];
    poName = known.name;
    district = known.district;
    state = known.state;
    lat = known.lat;
    lng = known.lng;
    approximateLocation = false;
  }

  // Geocode district/state coordinates via Nominatim if not already resolved
  if (district && state && (lat === null || lng === null)) {
    try {
      const controller2 = new AbortController();
      const timer2 = setTimeout(() => controller2.abort(), 3500);
      const geoQuery = `${district}, ${state}, India`;
      const geoRes = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(geoQuery)}&format=json&limit=1`, {
        signal: controller2.signal,
        headers: { 'User-Agent': 'PashuRakshak-Exotel/1.0 (biosecurity@pashurakshak.gov.in)' }
      });
      clearTimeout(timer2);

      if (geoRes.ok) {
        const geoData = await geoRes.json();
        if (Array.isArray(geoData) && geoData.length > 0 && geoData[0].lat && geoData[0].lon) {
          lat = parseFloat(geoData[0].lat);
          lng = parseFloat(geoData[0].lon);
          approximateLocation = false;
        }
      }
    } catch (geoErr) {
      console.warn("[Exotel IVR] Nominatim geocoding warning:", geoErr.message);
    }
  }

  // Construct village / location text identifying Post Office, District, and State
  let village;
  if (poName && district && state) {
    village = `${poName}, ${district}, ${state}`;
  } else if (poName && district) {
    village = `${poName}, ${district}`;
  } else if (district && state) {
    village = `${district}, ${state}`;
  } else if (district) {
    village = `PIN ${cleanPin}, ${district}`;
  } else {
    // If API completely failed and PIN not known, mark as approximate rather than claiming Ludhiana
    district = `Unknown District (PIN ${cleanPin})`;
    state = "India";
    village = `Approx. Location (PIN ${cleanPin})`;
    lat = 30.8920;
    lng = 75.8450;
    approximateLocation = true;
  }

  if (lat === null || lng === null) {
    lat = 30.8920;
    lng = 75.8450;
    approximateLocation = true;
  }

  return {
    village,
    location: village,
    district,
    state,
    lat,
    latitude: lat,
    lng,
    longitude: lng,
    approximateLocation
  };
}

/**
 * Helper to build species symptoms prompt
 */
function getSymptomsPrompt(species, lang = 'hi') {
  if (species === 'Swine') {
    return lang === 'en'
      ? "Swine selected. Enter symptoms: press 1 for high fever, 2 for skin redness or bluish color, 3 for bleeding, 4 for sudden deaths. When done, press pound."
      : "सूअर चुना गया। लक्षण चुनें: तेज़ बुखार के लिए 1, त्वचा का लाल या नीला पड़ने पर 2, रक्तस्राव के लिए 3, अचानक मौतों के लिए 4 दबाएं। लक्षण चुनने के बाद हैश दबाएं।";
  } else if (species === 'Poultry') {
    return lang === 'en'
      ? "Poultry selected. Enter symptoms: press 1 for sudden deaths, 2 for swollen face, 3 for greenish droppings, 4 for breathing trouble. When done, press pound."
      : "मुर्गी चुनी गई। लक्षण चुनें: अचानक मौतों के लिए 1, चेहरे पर सूजन के लिए 2, हरा दस्त के लिए 3, सांस लेने में तकलीफ के लिए 4 दबाएं। लक्षण चुनने के बाद हैश दबाएं।";
  }
  // Cattle or Buffalo
  const spNameEn = species === 'Buffalo' ? 'Buffalo' : 'Cattle';
  const spNameHi = species === 'Buffalo' ? 'भैंस' : 'गाय';
  return lang === 'en'
    ? `${spNameEn} selected. Enter symptoms: press 1 for fever, 2 for skin nodules or lumps, 3 for drooling, 4 for mouth or foot blisters or lameness, 5 for reduced milk or appetite. When done, press pound.`
    : `${spNameHi} चुनी गई। लक्षण चुनें: तेज़ बुखार के लिए 1, त्वचा पर गांठों के लिए 2, लार टपकने पर 3, खुर या मुंह के छालों और लंगड़ेपन के लिए 4, दूध या भूख में कमी के लिए 5 दबाएं। लक्षण चुनने के बाद हैश दबाएं।`;
}

/**
 * -------------------------------------------------------------
 * 6. EXOTEL ROUTE HANDLERS
 * -------------------------------------------------------------
 */

/**
 * GET /api/exotel/health
 * Health check endpoint for IVR monitoring
 */
router.get('/health', (req, res) => {
  res.json({ status: "EXOTEL_ONLINE" });
});

/**
 * 1. /api/exotel/incoming
 * Applet: Gather (Language)
 * Plays bilingual greeting & collects language preference: 1 = Hindi, 2 = English
 */
router.all('/incoming', (req, res) => {
  try {
    const { callSid, from } = extractExotelParams(req);
    const session = sessionManager.getOrCreate(callSid, from);
    sessionManager.update(callSid, { step: 'INCOMING' });

    logExotelEvent(callSid, 'INCOMING', { from });

    const welcomePrompt = "पशु रक्षक में आपका स्वागत है। हिंदी के लिए 1 दबाएं। Welcome to Pashu Rakshak. For English press 2.";
    const repeatPrompt = "हिंदी के लिए 1 दबाएं। For English press 2.";

    res.json(formatExotelGatherResponse({
      prompt: welcomePrompt,
      maxDigits: 1,
      finishOnKey: '',
      timeout: 6,
      repeatMenu: 2,
      repeatPrompt,
      extra: {
        success: true,
        callSid,
        step: 'INCOMING',
        nextEndpoint: '/api/exotel/menu'
      }
    }));
  } catch (err) {
    console.error("[Exotel IVR] Error in /incoming:", err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

/**
 * 2. /api/exotel/menu
 * Applet: Gather (Main Menu)
 * Chained from Gather (Language). Receives language choice (1=Hindi, 2=English) via 'digits'.
 * Plays Main Menu and collects: 1 = Register Case, 2 = Check Status, 3 = Talk to Vet
 */
router.all('/menu', (req, res) => {
  try {
    const { callSid, from, digits } = extractExotelParams(req);
    const session = sessionManager.getOrCreate(callSid, from);

    // If caller came from Language Gather, set chosen language
    if (digits === '2') {
      sessionManager.update(callSid, { language: 'en', step: 'MENU' });
    } else if (digits === '1' || !session.language) {
      sessionManager.update(callSid, { language: 'hi', step: 'MENU' });
    } else {
      sessionManager.update(callSid, { step: 'MENU' });
    }

    const lang = session.language || 'hi';
    logExotelEvent(callSid, 'MENU', { digits, lang });

    const menuPrompt = lang === 'en'
      ? "To register a new animal disease case, press 1. To check the status of your last case, press 2. To talk to a veterinary officer, press 3."
      : "नया पशु रोग केस दर्ज करने के लिए 1 दबाएं। अपने पिछले केस की स्थिति जानने के लिए 2 दबाएं। पशु चिकित्सा अधिकारी से बात करने के लिए 3 दबाएं।";

    const repeatPrompt = lang === 'en'
      ? "Press 1 to register a case, 2 for status, 3 to talk to a vet."
      : "केस दर्ज करने के लिए 1, स्थिति जानने के लिए 2, डॉक्टर से बात करने के लिए 3 दबाएं।";

    res.json(formatExotelGatherResponse({
      prompt: menuPrompt,
      maxDigits: 1,
      finishOnKey: '',
      timeout: 6,
      repeatMenu: 2,
      repeatPrompt,
      extra: {
        success: true,
        callSid,
        step: 'MENU',
        language: lang,
        nextEndpoint: '/api/exotel/species'
      }
    }));
  } catch (err) {
    console.error("[Exotel IVR] Error in /menu:", err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

/**
 * 3. /api/exotel/species
 * Applet: Gather (Species)
 * Chained from Gather (Main Menu). Receives menu choice:
 * - 1: Register Case -> Play Species selection menu (1=Cattle, 2=Buffalo, 3=Swine, 4=Poultry)
 * - 2: Check Status -> Route to status lookup
 * - 3: Vet Call -> Route to vet transfer
 */
router.all('/species', (req, res) => {
  try {
    const { callSid, from, digits } = extractExotelParams(req);
    const session = sessionManager.getOrCreate(callSid, from);
    const lang = session.language || 'hi';

    logExotelEvent(callSid, 'SPECIES', { digits, lang });

    // Handle non-registration options from Main Menu
    if (digits === '2') {
      sessionManager.update(callSid, { step: 'STATUS' });
      return handleStatusCheck(req, res, session);
    } else if (digits === '3') {
      sessionManager.update(callSid, { step: 'VET' });
      return handleVetCall(req, res, session);
    }

    // Default: Caller selected 1 (Register Case) -> Ask for Species
    sessionManager.update(callSid, { step: 'SPECIES' });

    const prompt = lang === 'en'
      ? "Please select animal species. Press 1 for Cattle. Press 2 for Buffalo. Press 3 for Swine. Press 4 for Poultry."
      : "पशु का प्रकार चुनें। गाय के लिए 1 दबाएं। भैंस के लिए 2 दबाएं। सूअर के लिए 3 दबाएं। मुर्गी के लिए 4 दबाएं।";

    const repeatPrompt = lang === 'en'
      ? "Press 1 for Cattle, 2 for Buffalo, 3 for Swine, 4 for Poultry."
      : "गाय के लिए 1, भैंस के लिए 2, सूअर के लिए 3, मुर्गी के लिए 4 दबाएं।";

    res.json(formatExotelGatherResponse({
      prompt,
      maxDigits: 1,
      finishOnKey: '',
      timeout: 6,
      repeatMenu: 2,
      repeatPrompt,
      extra: {
        success: true,
        callSid,
        step: 'SPECIES',
        language: lang,
        nextEndpoint: '/api/exotel/symptoms'
      }
    }));
  } catch (err) {
    console.error("[Exotel IVR] Error in /species:", err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

/**
 * 4. /api/exotel/symptoms
 * Applet: Gather (Symptoms)
 * Chained from Gather (Species). Receives species choice (1..4).
 * Plays species symptoms menu and collects symptoms digits terminating with '#'.
 */
router.all('/symptoms', (req, res) => {
  try {
    const { callSid, from, digits } = extractExotelParams(req);
    const session = sessionManager.getOrCreate(callSid, from);
    const lang = session.language || 'hi';

    // Set species from digits passed from Species Gather
    if (digits && SPECIES_MAP[digits]) {
      sessionManager.update(callSid, { species: SPECIES_MAP[digits], step: 'SYMPTOMS' });
    } else if (!session.species) {
      sessionManager.update(callSid, { species: 'Cattle', step: 'SYMPTOMS' });
    }

    const species = session.species || 'Cattle';
    logExotelEvent(callSid, 'SYMPTOMS', { digits, species, lang });

    const prompt = getSymptomsPrompt(species, lang);
    const repeatPrompt = lang === 'en'
      ? "Enter symptoms digits followed by pound."
      : "लक्षण के अंक दबाएं और अंत में हैश दबाएं।";

    res.json(formatExotelGatherResponse({
      prompt,
      maxDigits: 5,
      finishOnKey: '#',
      timeout: 8,
      repeatMenu: 2,
      repeatPrompt,
      extra: {
        success: true,
        callSid,
        step: 'SYMPTOMS',
        species,
        language: lang,
        nextEndpoint: '/api/exotel/pin'
      }
    }));
  } catch (err) {
    console.error("[Exotel IVR] Error in /symptoms:", err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

/**
 * 5. /api/exotel/pin
 * Applet: Gather (PIN)
 * Chained from Gather (Symptoms). Receives symptom digits (e.g. "12#" or "12").
 * Saves symptoms and collects 6-digit postal PIN code.
 */
router.all('/pin', (req, res) => {
  try {
    const { callSid, from, digits } = extractExotelParams(req);
    const session = sessionManager.getOrCreate(callSid, from);
    const lang = session.language || 'hi';

    // Extract valid symptom digits (1..5)
    const validDigits = digits.split('').filter(d => ['1', '2', '3', '4', '5'].includes(d));
    if (validDigits.length > 0) {
      const cleanDigits = Array.from(new Set(validDigits)).join('');
      sessionManager.update(callSid, {
        symptomsRaw: cleanDigits,
        symptoms: validDigits,
        step: 'PIN'
      });
    } else if (!session.symptomsRaw) {
      sessionManager.update(callSid, { symptomsRaw: '1', symptoms: ['1'], step: 'PIN' });
    }

    logExotelEvent(callSid, 'PIN', { digits, symptoms: session.symptomsRaw, lang });

    const pinPrompt = lang === 'en'
      ? "Please enter the six digit postal PIN code of your farm."
      : "कृपया अपने फार्म का छह अंकों का पिन कोड दर्ज करें।";

    const repeatPinPrompt = lang === 'en'
      ? "Enter your six digit postal PIN code."
      : "अपने फार्म का छह अंकों का पिन कोड दर्ज करें।";

    res.json(formatExotelGatherResponse({
      prompt: pinPrompt,
      maxDigits: 6,
      finishOnKey: '#',
      timeout: 10,
      repeatMenu: 2,
      repeatPrompt: repeatPinPrompt,
      extra: {
        success: true,
        callSid,
        step: 'PIN',
        language: lang,
        nextEndpoint: '/api/exotel/confirm'
      }
    }));
  } catch (err) {
    console.error("[Exotel IVR] Error in /pin:", err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

/**
 * 6. /api/exotel/confirm
 * Applet: Gather (Confirmation)
 * Chained from Gather (PIN). Receives 6-digit PIN.
 * Reads back summary of entered information (Species, Symptoms, PIN).
 * Collects confirmation choice: 1 = Confirm, 2 = Restart
 */
router.all('/confirm', async (req, res) => {
  try {
    const { callSid, from, digits } = extractExotelParams(req);
    const session = sessionManager.getOrCreate(callSid, from);
    const lang = session.language || 'hi';

    // If caller provided 6-digit PIN from the PIN gather
    if (/^\d{6}$/.test(digits)) {
      sessionManager.update(callSid, { pin: digits, step: 'CONFIRM' });
    }

    // If caller already heard confirmation and pressed 1 to confirm on this endpoint
    if (digits === '1' && session.step === 'CONFIRM') {
      return await executeCaseSubmission(req, res, session);
    } else if (digits === '2' && session.step === 'CONFIRM') {
      // 2 = Restart
      sessionManager.update(callSid, { species: null, symptoms: [], symptomsRaw: '', pin: null, step: 'MENU' });
      const menuPrompt = lang === 'en'
        ? "Registration restarted. To register a new animal disease case, press 1. To check the status of your last case, press 2. To talk to a veterinary officer, press 3."
        : "पंजीकरण पुनः आरंभ किया गया। नया पशु रोग केस दर्ज करने के लिए 1 दबाएं। अपने पिछले केस की स्थिति जानने के लिए 2 दबाएं। पशु चिकित्सा अधिकारी से बात करने के लिए 3 दबाएं।";

      return res.json(formatExotelGatherResponse({
        prompt: menuPrompt,
        maxDigits: 1,
        finishOnKey: '',
        timeout: 6,
        repeatMenu: 2,
        extra: {
          success: true,
          callSid,
          step: 'MENU',
          language: lang,
          nextEndpoint: '/api/exotel/menu'
        }
      }));
    }

    logExotelEvent(callSid, 'CONFIRM', { digits, lang, pin: session.pin });

    // Build confirmation summary
    const species = session.species || 'Cattle';
    const symptoms = session.symptomsRaw || '1';
    const pin = session.pin || '141001';

    const { symptomsSpoken } = getSymptomNames(species, symptoms, lang);
    const speciesSpoken = getSpeciesDisplayName(species, lang);
    const pinSpoken = speakDigits(pin);

    const confirmPrompt = lang === 'en'
      ? `You have selected: Species: ${speciesSpoken}. Symptoms: ${symptomsSpoken}. PIN code: ${pinSpoken}. To confirm and register this case, press 1. To start over, press 2.`
      : `आपकी जानकारी है: पशु: ${speciesSpoken}। लक्षण: ${symptomsSpoken}। पिन कोड: ${pinSpoken}। केस दर्ज करने के लिए 1 दबाएं। दोबारा शुरू करने के लिए 2 दबाएं।`;

    const repeatPrompt = lang === 'en'
      ? "Press 1 to confirm, 2 to restart."
      : "केस दर्ज करने के लिए 1 दबाएं। दोबारा शुरू करने के लिए 2 दबाएं।";

    res.json(formatExotelGatherResponse({
      prompt: confirmPrompt,
      maxDigits: 1,
      finishOnKey: '',
      timeout: 8,
      repeatMenu: 2,
      repeatPrompt,
      extra: {
        success: true,
        callSid,
        step: 'CONFIRM',
        language: lang,
        nextEndpoint: '/api/exotel/submit'
      }
    }));
  } catch (err) {
    console.error("[Exotel IVR] Error in /confirm:", err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

/**
 * 7. /api/exotel/submit
 * Applet: Final Confirmation TTS / Case Submission
 * Chained from Gather (Confirmation). Receives confirmation digit (1 = Confirm, 2 = Cancel).
 * Creates case in sharedStore and returns final TTS confirmation with real Request ID.
 */
router.all('/submit', async (req, res) => {
  try {
    const { callSid, from, digits } = extractExotelParams(req);
    const session = sessionManager.getOrCreate(callSid, from);

    // If caller pressed 2 to restart
    if (digits === '2') {
      sessionManager.update(callSid, { species: null, symptoms: [], symptomsRaw: '', pin: null, step: 'MENU' });
      const prompt = (session.language || 'hi') === 'en'
        ? "Registration cancelled. Returning to main menu."
        : "पंजीकरण रद्द किया गया। मुख्य मेनू पर वापस जा रहे हैं।";

      return res.json(formatExotelGatherResponse({
        prompt,
        maxDigits: 1,
        finishOnKey: '',
        timeout: 6,
        repeatMenu: 1,
        extra: {
          success: true,
          callSid,
          step: 'MENU',
          nextEndpoint: '/api/exotel/menu'
        }
      }));
    }

    return await executeCaseSubmission(req, res, session);
  } catch (err) {
    console.error("[Exotel IVR] Error in /submit:", err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

/**
 * -------------------------------------------------------------
 * 7. SHARED BIOSECURITY CASE REGISTRATION LOGIC
 * -------------------------------------------------------------
 * Used by both /api/exotel/submit (Programmable Gather)
 * and /api/exotel/static-capture (Static Flow Builder Passthru)
 */
async function createBiosecurityCase(session, overrides = {}) {
  const lang = overrides.language || session.language || 'hi';
  const species = overrides.species || session.species;
  const symptomsRaw = overrides.symptomsRaw || session.symptomsRaw;
  const pin = overrides.pin || session.pin;
  const callerPhone = overrides.callerPhone || session.callerPhone || '+919876543210';

  // Strict Validation: Never fabricate a case if inputs are missing
  if (!species || !symptomsRaw || !pin || !/^\d{6}$/.test(pin)) {
    return {
      success: false,
      error: "INCOMPLETE_DATA",
      language: lang,
      details: { species, symptomsRaw, pin }
    };
  }

  // 1. Geocode location from PIN code
  const { village: resolvedVillage, district, state, lat, lng, approximateLocation } = await resolvePinLocation(pin);

  // 2. Evaluate disease & AI risk level
  const { suspectedDisease, aiRiskLevel } = evaluateDisease(species, symptomsRaw);
  const { symptomsEn } = getSymptomNames(species, symptomsRaw, 'en');

  // 3. Find closest vet officer using Haversine distance
  const vetsList = store.getVets();
  let assignedVet;
  if (Array.isArray(vetsList) && vetsList.length > 0) {
    const sorted = vetsList.map(v => ({
      ...v,
      dist: calculateDistance(
        lat,
        lng,
        v.location ? v.location.lat : 30.8920,
        v.location ? v.location.lng : 75.8450
      )
    })).sort((a, b) => a.dist - b.dist);
    assignedVet = sorted[0];
  }
  if (!assignedVet) {
    assignedVet = { id: "vet-101", name: "Dr. Rajesh Sharma" };
  }

  // 4. Identifiers and metadata
  const cleanPhone = String(callerPhone).replace(/\D/g, '');
  const phoneLast4 = cleanPhone.slice(-4) || '0000';
  const timestamp = Date.now();
  const requestId = `req-${timestamp}`;
  const animalTag = `IVR-EXO-${phoneLast4}-${String(timestamp).slice(-5)}`;
  const now = new Date();
  const nowStr = now.toISOString().split('T')[0];

  // 5. Build Emergency Vet Request object
  const newRequest = {
    id: requestId,
    farmId: `farm-${timestamp}`,
    farmerName: "IVR Farmer (Exotel)",
    farmerPhone: callerPhone,
    farmLocation: { lat, lng },
    village: resolvedVillage || `PIN ${pin}, ${district}`,
    animalTag,
    species,
    symptoms: symptomsEn,
    aiRiskLevel,
    suspectedDisease,
    requestedVetId: assignedVet.id,
    requestedVetName: assignedVet.name,
    status: "PENDING",
    urgency: aiRiskLevel === "HIGH" || aiRiskLevel === "CRITICAL" ? "CRITICAL" : "HIGH",
    createdAt: now.toISOString(),
    notes: "Registered via Exotel IVR phone call",
    source: "IVR-Exotel"
  };

  if (approximateLocation) {
    newRequest.approximateLocation = true;
  }

  // 6. Build Digital Health Passport Animal Record
  const newAnimal = {
    id: `anim-${timestamp}`,
    farmId: "farm-1",
    tagNumber: animalTag,
    species: species || "Cattle",
    breed: species === "Swine" || species === "Pig" ? "Large White Yorkshire" : species === "Poultry" ? "Broiler/Layer" : "Holstein Cross",
    ageMonths: 36,
    gender: "FEMALE",
    healthPassportHash: generateHash({ tag: animalTag, disease: suspectedDisease, date: nowStr }),
    status: "INFECTED",
    suspectedDisease,
    assignedVetName: assignedVet.name,
    vaccinations: [],
    medicalHistory: [
      {
        date: nowStr,
        diagnosis: `🔴 INFECTED — Suspected ${suspectedDisease}`,
        vetId: assignedVet.id,
        vetName: assignedVet.name,
        prescriptions: ["Isolate animal in quarantine shed", "Administer Antipyretic & Antihistamine", "Apply Antiseptic Spray"],
        remarks: `Emergency Dispatch Request initiated by Farmer via Exotel IVR. Status: INFECTED — AWAITING VET VISIT (${assignedVet.name})`
      }
    ]
  };

  // 7. Commit to persistent sharedStore
  try {
    store.addRequest(newRequest);
    store.addAnimal(newAnimal);
  } catch (storeErr) {
    console.error("[Exotel IVR] Failed to write case to sharedStore:", storeErr);
    return {
      success: false,
      error: "STORE_WRITE_FAILURE",
      language: lang,
      storeErr
    };
  }

  // Update session
  sessionManager.update(session.callSid, {
    requestId,
    animalTag,
    step: 'COMPLETED'
  });

  const reqDigitsLast6 = String(requestId).replace(/\D/g, '').slice(-6);
  const spokenDigits = speakDigits(reqDigitsLast6);

  return {
    success: true,
    requestId,
    animalTag,
    species,
    suspectedDisease,
    aiRiskLevel,
    assignedVet,
    pin,
    district,
    state,
    lat,
    lng,
    village: newRequest.village,
    callerPhone,
    spokenDigits,
    request: newRequest,
    animal: newAnimal,
    language: lang
  };
}

/**
 * Internal case submission executor for /api/exotel/submit (Programmable IVR)
 */
async function executeCaseSubmission(req, res, session) {
  const overrides = {
    species: req.body?.species || req.query?.species,
    symptomsRaw: req.body?.symptoms || req.query?.symptoms,
    pin: req.body?.pin || req.query?.pin
  };

  const result = await createBiosecurityCase(session, overrides);
  const lang = result.language || session.language || 'hi';

  if (!result.success) {
    if (result.error === "INCOMPLETE_DATA") {
      const errorMsg = lang === 'en'
        ? "Registration failed due to incomplete data. Please call again."
        : "अधूरी जानकारी के कारण केस दर्ज नहीं हो सका। कृपया पुनः कॉल करें।";

      return res.status(200).json(formatExotelGatherResponse({
        prompt: errorMsg,
        maxDigits: 1,
        finishOnKey: '',
        timeout: 5,
        repeatMenu: 0,
        repeatPrompt: '',
        extra: {
          success: false,
          callSid: session.callSid,
          error: "INCOMPLETE_DATA",
          language: lang
        }
      }));
    } else {
      const storeErrorPrompt = lang === 'en'
        ? "System error saving case. Please call back shortly."
        : "केस सुरक्षित करने में तकनीकी समस्या आई। कृपया थोड़ी देर बाद कॉल करें।";

      return res.status(200).json(formatExotelGatherResponse({
        prompt: storeErrorPrompt,
        maxDigits: 1,
        finishOnKey: '',
        timeout: 5,
        repeatMenu: 0,
        extra: {
          success: false,
          callSid: session.callSid,
          error: "STORE_WRITE_FAILURE"
        }
      }));
    }
  }

  logExotelEvent(session.callSid, 'CASE_REGISTERED_SUCCESSFULLY', {
    requestId: result.requestId,
    animalTag: result.animalTag,
    species: result.species,
    suspectedDisease: result.suspectedDisease,
    aiRiskLevel: result.aiRiskLevel,
    assignedVet: result.assignedVet.name,
    pin: result.pin
  });

  const confirmationPrompt = lang === 'en'
    ? `Your case has been registered successfully. Your case ID is: ${result.spokenDigits}. A veterinary officer will contact you soon. Thank you for calling Pashu Rakshak. Goodbye.`
    : `आपका केस सफलतापूर्वक दर्ज कर लिया गया है। आपका केस नंबर है: ${result.spokenDigits}। पशु चिकित्सा अधिकारी जल्द ही आपसे संपर्क करेंगे। पशु रक्षक में कॉल करने के लिए धन्यवाद। अलविदा।`;

  return res.json(formatExotelGatherResponse({
    prompt: confirmationPrompt,
    maxDigits: 1,
    finishOnKey: '',
    timeout: 5,
    repeatMenu: 0,
    repeatPrompt: '',
    extra: {
      success: true,
      callSid: session.callSid,
      step: 'COMPLETED',
      requestId: result.requestId,
      animalTag: result.animalTag,
      species: result.species,
      suspectedDisease: result.suspectedDisease,
      aiRiskLevel: result.aiRiskLevel,
      assignedVetName: result.assignedVet.name,
      language: lang,
      request: result.request
    }
  }));
}

/**
 * =============================================================
 * 8. EXOTEL STATIC IVR FLOW - PASSTHRU CAPTURE ENDPOINT
 * =============================================================
 * Endpoint: GET /api/exotel/static-capture?stage=<STAGE>
 * 
 * Supports Exotel Passthru applet placed after each static Gather applet:
 * - stage=language     -> captures caller language (1=Hindi, 2=English)
 * - stage=menu         -> captures menu selection (1=Register, 2=Status, 3=Vet)
 * - stage=species      -> captures species (1=Cattle, 2=Buffalo, 3=Swine, 4=Poultry)
 * - stage=symptoms     -> captures symptoms DTMF string (e.g. 1, 12, 123)
 * - stage=pin          -> captures 6-digit postal PIN code
 * - stage=confirmation -> captures confirmation (1=Confirm & Register, 2=Cancel)
 * 
 * Automatically cleans/unquotes digits and saves to session keyed by CallSid.
 * On confirmation=1, executes case creation into persistent sharedStore,
 * making the new emergency case immediately visible on the dashboard.
 */
router.all('/static-capture', async (req, res) => {
  try {
    const { callSid, from, digits } = extractExotelParams(req);
    const stage = String(req.query.stage || req.body?.stage || '').toLowerCase().trim();
    const session = sessionManager.getOrCreate(callSid, from);

    console.log(`[Exotel Static Capture] [${new Date().toISOString()}] CallSid: ${callSid} | Stage: ${stage || '(none)'} | Digits: "${digits}" | From: ${from}`);

    // If query contains direct input values, populate session for resilience
    if (req.query.species && !session.species) {
      const sp = String(req.query.species).trim();
      session.species = SPECIES_MAP[sp] || sp;
    }
    if (req.query.symptoms && !session.symptomsRaw) {
      session.symptomsRaw = String(req.query.symptoms).replace(/\D/g, '') || '1';
      session.symptoms = session.symptomsRaw.split('');
    }
    if (req.query.pin && !session.pin) {
      session.pin = String(req.query.pin).replace(/\D/g, '').slice(0, 6);
    }

    if (!stage) {
      return res.status(200).json({
        success: true,
        callSid,
        message: "Exotel Static Capture active. Pass ?stage=<language|menu|species|symptoms|pin|confirmation>&digits=<val>",
        currentSession: {
          step: session.step,
          language: session.language,
          species: session.species,
          symptomsRaw: session.symptomsRaw,
          pin: session.pin,
          requestId: session.requestId
        }
      });
    }

    let responseData = {
      success: true,
      stage,
      callSid,
      digits
    };

    switch (stage) {
      case 'language': {
        const lang = digits === '2' ? 'en' : 'hi';
        sessionManager.update(callSid, { language: lang, step: 'LANGUAGE' });
        responseData.language = lang;
        responseData.message = `Language preference set to '${lang}'`;
        break;
      }

      case 'menu': {
        sessionManager.update(callSid, { menuOption: digits, step: 'MENU' });
        responseData.menuOption = digits;
        responseData.message = `Menu option '${digits}' saved`;
        break;
      }

      case 'species': {
        const speciesName = SPECIES_MAP[digits] || 'Cattle';
        sessionManager.update(callSid, { species: speciesName, step: 'SPECIES' });
        responseData.species = speciesName;
        responseData.message = `Species '${speciesName}' saved`;
        break;
      }

      case 'symptoms': {
        const validDigits = digits.split('').filter(d => ['1', '2', '3', '4', '5'].includes(d));
        const cleanDigits = validDigits.length > 0 ? Array.from(new Set(validDigits)).join('') : (digits || '1');
        sessionManager.update(callSid, {
          symptomsRaw: cleanDigits,
          symptoms: validDigits.length > 0 ? validDigits : [cleanDigits],
          step: 'SYMPTOMS'
        });
        responseData.symptomsRaw = cleanDigits;
        responseData.message = `Symptoms '${cleanDigits}' saved`;
        break;
      }

      case 'pin': {
        const cleanPin = String(digits || '').replace(/\D/g, '').slice(0, 6);
        const pinToSave = cleanPin.length === 6 ? cleanPin : (digits || '141001');
        sessionManager.update(callSid, { pin: pinToSave, step: 'PIN' });
        responseData.pin = pinToSave;
        responseData.message = `Farm PIN '${pinToSave}' saved`;
        break;
      }

      case 'confirmation': {
        if (digits === '1') {
          // Confirm & submit case!
          const result = await createBiosecurityCase(session);
          if (!result.success) {
            console.error(`[Exotel Static Capture] Case creation failed:`, result);
            return res.status(200).json({
              success: false,
              stage: 'confirmation',
              callSid,
              error: result.error,
              message: result.error === 'INCOMPLETE_DATA' 
                ? "Cannot register case: incomplete data (species, symptoms, or 6-digit PIN missing)" 
                : "Database error saving case",
              session: {
                species: session.species,
                symptomsRaw: session.symptomsRaw,
                pin: session.pin
              }
            });
          }

          console.log(`[Exotel Static Capture] Case Created Successfully! CallSid: ${callSid} | Final Case ID: ${result.requestId} | Animal Tag: ${result.animalTag}`);

          return res.status(200).json({
            success: true,
            stage: 'confirmation',
            callSid,
            confirmed: true,
            caseCreated: true,
            caseId: result.requestId,
            requestId: result.requestId,
            animalTag: result.animalTag,
            species: result.species,
            suspectedDisease: result.suspectedDisease,
            aiRiskLevel: result.aiRiskLevel,
            assignedVet: result.assignedVet.name,
            pin: result.pin,
            village: result.request ? result.request.village : `PIN ${result.pin}`,
            callerPhone: result.callerPhone,
            spokenDigits: result.spokenDigits,
            message: "Case registered successfully and visible on dashboard"
          });
        } else if (digits === '2') {
          // Cancelled / Restart
          sessionManager.update(callSid, {
            species: null,
            symptoms: [],
            symptomsRaw: '',
            pin: null,
            step: 'CANCELLED'
          });
          responseData.confirmed = false;
          responseData.cancelled = true;
          responseData.message = "Registration cancelled by caller";
        } else {
          responseData.confirmed = false;
          responseData.message = `Awaiting confirmation (press 1 to confirm, 2 to cancel). Received: '${digits}'`;
        }
        break;
      }

      default: {
        responseData.warning = `Unknown stage '${stage}'. Available: language, menu, species, symptoms, pin, confirmation`;
        break;
      }
    }

    console.log(`[Exotel Static Capture] Session State [${callSid}]:`, JSON.stringify({
      step: session.step,
      language: session.language,
      species: session.species,
      symptomsRaw: session.symptomsRaw,
      pin: session.pin,
      requestId: session.requestId || null
    }));

    return res.status(200).json(responseData);
  } catch (err) {
    console.error(`[Exotel Static Capture] Unexpected error:`, err);
    return res.status(500).json({
      success: false,
      error: "INTERNAL_ERROR",
      message: err.message
    });
  }
});

/**
 * 8. /api/exotel/status
 * Applet: Case Status Lookup
 * Checks status of last case registered by caller's phone number
 */
router.all('/status', (req, res) => {
  try {
    const { callSid, from } = extractExotelParams(req);
    const session = sessionManager.getOrCreate(callSid, from);
    return handleStatusCheck(req, res, session);
  } catch (err) {
    console.error("[Exotel IVR] Error in /status:", err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

function handleStatusCheck(req, res, session) {
  const lang = session.language || 'hi';
  const callerPhone = session.callerPhone || '+919876543210';
  const cleanPhone = String(callerPhone).replace(/\D/g, '');
  const cleanLast10 = cleanPhone.slice(-10);

  const allRequests = store.getRequests();
  const matching = allRequests.filter(r => {
    if (!r.farmerPhone) return false;
    const p = String(r.farmerPhone).replace(/\D/g, '');
    return p === cleanPhone || (cleanLast10.length >= 10 && p.slice(-10) === cleanLast10);
  });

  logExotelEvent(session.callSid, 'STATUS_LOOKUP', { callerPhone, matches: matching.length });

  if (matching.length === 0) {
    const prompt = lang === 'en'
      ? "No registered case was found for this phone number. Thank you for calling Pashu Rakshak. Goodbye."
      : "आपके इस फोन नंबर से कोई दर्ज केस नहीं मिला। पशु रक्षक में कॉल करने के लिए धन्यवाद। अलविदा।";

    return res.json(formatExotelGatherResponse({
      prompt,
      maxDigits: 1,
      finishOnKey: '',
      timeout: 5,
      repeatMenu: 0,
      extra: {
        success: true,
        callSid: session.callSid,
        step: 'STATUS',
        found: false,
        language: lang
      }
    }));
  }

  const latest = matching[0];
  let statusMsg = "";

  if (latest.status === 'PENDING') {
    statusMsg = lang === 'en'
      ? "Your case is currently pending and waiting for a veterinary officer. A vet will contact you soon."
      : "आपका केस लंबित है और पशु चिकित्सा अधिकारी की प्रतीक्षा में है। डॉक्टर जल्द ही आपसे संपर्क करेंगे।";
  } else if (latest.status === 'ACCEPTED' || latest.status === 'ON_WAY') {
    const vet = latest.requestedVetName || (lang === 'en' ? 'A veterinary officer' : 'पशु चिकित्सक');
    statusMsg = lang === 'en'
      ? `${vet} has accepted your case and is on the way to your farm.`
      : `${vet} आपके फार्म के लिए निकल चुके हैं।`;
  } else if (latest.status === 'COMPLETED' || latest.status === 'RESOLVED') {
    statusMsg = lang === 'en'
      ? "The veterinary inspection has been completed for your animal case."
      : "आपके पशु का चिकित्सा निरीक्षण पूरा हो चुका है और केस हल हो गया है।";
  } else {
    statusMsg = lang === 'en'
      ? `The status of your case is: ${latest.status}.`
      : `आपके केस की स्थिति है: ${latest.status}।`;
  }

  const prompt = lang === 'en'
    ? `${statusMsg} Thank you for calling Pashu Rakshak. Goodbye.`
    : `${statusMsg} पशु रक्षक में कॉल करने के लिए धन्यवाद। अलविदा।`;

  return res.json(formatExotelGatherResponse({
    prompt,
    maxDigits: 1,
    finishOnKey: '',
    timeout: 5,
    repeatMenu: 0,
    extra: {
      success: true,
      callSid: session.callSid,
      step: 'STATUS',
      found: true,
      status: latest.status,
      requestId: latest.id,
      language: lang,
      case: latest
    }
  }));
}

/**
 * 9. /api/exotel/vet
 * Applet: Veterinary Officer Forwarding
 */
router.all('/vet', (req, res) => {
  try {
    const { callSid, from } = extractExotelParams(req);
    const session = sessionManager.getOrCreate(callSid, from);
    return handleVetCall(req, res, session);
  } catch (err) {
    console.error("[Exotel IVR] Error in /vet:", err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

function handleVetCall(req, res, session) {
  const lang = session.language || 'hi';
  const forwardNumber = process.env.VET_FORWARD_NUMBER;

  logExotelEvent(session.callSid, 'VET_TRANSFER', { forwardNumber: forwardNumber ? '[CONFIGURED]' : '[NONE]' });

  if (forwardNumber) {
    const prompt = lang === 'en'
      ? "Please wait while we connect your call to a veterinary officer."
      : "कृपया प्रतीक्षा करें, आपकी कॉल पशु चिकित्सा अधिकारी से जोड़ी जा रही है।";

    return res.json(formatExotelGatherResponse({
      prompt,
      maxDigits: 1,
      finishOnKey: '',
      timeout: 5,
      repeatMenu: 0,
      extra: {
        success: true,
        callSid: session.callSid,
        step: 'VET_CONNECT',
        forwardNumber,
        language: lang
      }
    }));
  }

  const unavailPrompt = lang === 'en'
    ? "Sorry, no veterinary officer is currently available for direct call. Please register a case for field visit. Goodbye."
    : "क्षमा करें, इस समय कोई पशु चिकित्सा अधिकारी फोन पर उपलब्ध नहीं हैं। कृपया फार्म निरीक्षण के लिए नया केस दर्ज करें। अलविदा।";

  return res.json(formatExotelGatherResponse({
    prompt: unavailPrompt,
    maxDigits: 1,
    finishOnKey: '',
    timeout: 5,
    repeatMenu: 0,
    extra: {
      success: false,
      callSid: session.callSid,
      step: 'VET_UNAVAILABLE',
      language: lang
    }
  }));
}

/**
 * 10. /api/exotel/debug
 * Developer inspection endpoint for session state without affecting Gather IVR
 */
router.get('/debug', (req, res) => {
  const { callSid } = extractExotelParams(req);
  res.json({
    callSid,
    session: sessionManager.get(callSid),
    totalActiveSessions: sessionManager.sessions.size,
    timestamp: new Date().toISOString()
  });
});

router.resolvePinLocation = resolvePinLocation;
module.exports = router;
