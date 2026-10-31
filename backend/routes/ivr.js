const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { store, generateHash } = require('../data/sharedStore');

// Helper: XML Escaper
function escapeXml(unsafe) {
  if (unsafe == null) return '';
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Helper: Haversine distance in KM
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return parseFloat((R * c).toFixed(1));
}

// Helper: Speak digits slowly for TTS cadence
function speakDigits(val) {
  return String(val || '')
    .split('')
    .join(' . ');
}

// Helper: Standard error TwiML response
function sendErrorTwiML(res, lang = 'hi') {
  res.set('Content-Type', 'text/xml');
  const msg = lang === 'en'
    ? 'Sorry, a technical error occurred. Please try again later.'
    : 'क्षमा करें, तकनीकी समस्या आई है। कृपया थोड़ी देर बाद प्रयास करें।';
  const voice = 'Polly.Aditi';
  const langAttr = lang === 'en' ? 'en-IN' : 'hi-IN';
  return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="${langAttr}" voice="${voice}">${escapeXml(msg)}</Say>
  <Hangup/>
</Response>`);
}

// Species mapping
const SPECIES_MAP = {
  '1': 'Cattle',
  '2': 'Buffalo',
  '3': 'Swine',
  '4': 'Poultry'
};

// Symptom Catalog
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

// Evaluate Disease & Risk based on project documentation Section 4
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

// Extract symptom names
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

// Geocode PIN to lat/lng and District/State
async function resolvePinLocation(pin) {
  let district = "Ludhiana";
  let state = "Punjab";
  let lat = 30.8920;
  let lng = 75.8450;
  let approximateLocation = true;

  try {
    const controller1 = new AbortController();
    const timer1 = setTimeout(() => controller1.abort(), 3000);
    const pinRes = await fetch(`https://api.postalpincode.in/pincode/${encodeURIComponent(pin)}`, {
      signal: controller1.signal,
      headers: { 'User-Agent': 'PashuRakshak-IVR/1.0' }
    });
    clearTimeout(timer1);

    if (pinRes.ok) {
      const pinData = await pinRes.json();
      if (Array.isArray(pinData) && pinData[0] && pinData[0].Status === 'Success' && Array.isArray(pinData[0].PostOffice) && pinData[0].PostOffice.length > 0) {
        district = pinData[0].PostOffice[0].District || district;
        state = pinData[0].PostOffice[0].State || state;
      }
    }

    const controller2 = new AbortController();
    const timer2 = setTimeout(() => controller2.abort(), 3000);
    const geoQuery = `${district}, ${state}, India`;
    const geoRes = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(geoQuery)}&format=json&limit=1`, {
      signal: controller2.signal,
      headers: { 'User-Agent': 'PashuRakshak-IVR/1.0 (biosecurity@pashurakshak.gov.in)' }
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
  } catch (err) {
    console.warn("IVR Geocoding fallback triggered:", err.message);
    lat = 30.8920;
    lng = 75.8450;
    approximateLocation = true;
  }

  return { district, state, lat, lng, approximateLocation };
}

// Optional Twilio signature validation middleware
function validateTwilioSignature(req, res, next) {
  if (process.env.TWILIO_AUTH_TOKEN && process.env.IVR_VALIDATE_SIGNATURE === 'true') {
    const signature = req.headers['x-twilio-signature'];
    if (!signature) {
      return res.status(403).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="en-IN" voice="Polly.Aditi">Security validation failed. Forbidden.</Say>
  <Hangup/>
</Response>`);
    }

    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const fullUrl = `${proto}://${host}${req.originalUrl}`;

    let data = fullUrl;
    if (req.body && typeof req.body === 'object') {
      const sortedKeys = Object.keys(req.body).sort();
      for (const key of sortedKeys) {
        data += key + req.body[key];
      }
    }

    const expected = crypto
      .createHmac('sha1', process.env.TWILIO_AUTH_TOKEN)
      .update(Buffer.from(data, 'utf-8'))
      .digest('base64');

    if (signature !== expected) {
      return res.status(403).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="en-IN" voice="Polly.Aditi">Invalid signature. Forbidden.</Say>
  <Hangup/>
</Response>`);
    }
  }
  next();
}

// Apply validation to webhook routes (skip /health)
router.use((req, res, next) => {
  if (req.path === '/health') return next();
  validateTwilioSignature(req, res, next);
});

/**
 * GET /api/ivr/health
 */
router.get('/health', (req, res) => {
  res.json({ status: "IVR_ONLINE" });
});

/**
 * 1. POST /api/ivr/incoming
 * Initial incoming call: ask language choice (Hindi=1, English=2)
 */
router.post('/incoming', (req, res) => {
  try {
    res.set('Content-Type', 'text/xml');
    const retry = req.query.retry === '1';

    if (retry) {
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather action="/api/ivr/menu" numDigits="1" method="POST" timeout="6">
    <Say language="hi-IN" voice="Polly.Aditi">कोई इनपुट नहीं मिला। हिंदी के लिए 1 दबाएं।</Say>
    <Say language="en-IN" voice="Polly.Aditi">No input received. For English, press 2.</Say>
  </Gather>
  <Say language="hi-IN" voice="Polly.Aditi">कोई इनपुट प्राप्त नहीं हुआ। अलविदा।</Say>
  <Say language="en-IN" voice="Polly.Aditi">No input received. Goodbye.</Say>
  <Hangup/>
</Response>`);
    }

    return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather action="/api/ivr/menu" numDigits="1" method="POST" timeout="6">
    <Say language="hi-IN" voice="Polly.Aditi">पशु रक्षक में आपका स्वागत है। हिंदी के लिए 1 दबाएं।</Say>
    <Say language="en-IN" voice="Polly.Aditi">Welcome to Pashu Rakshak. For English press 2.</Say>
  </Gather>
  <Redirect method="POST">/api/ivr/incoming?retry=1</Redirect>
</Response>`);
  } catch (err) {
    return sendErrorTwiML(res, 'hi');
  }
});

/**
 * 2. POST /api/ivr/menu
 * Main menu: 1 = register case, 2 = status, 3 = talk to vet
 */
router.post('/menu', (req, res) => {
  try {
    res.set('Content-Type', 'text/xml');
    const digits = req.body.Digits;

    // Determine language
    let lang = req.query.lang;
    if (!lang) {
      lang = digits === '2' ? 'en' : 'hi';
    }

    // Check if this invocation is handling a menu selection
    // (i.e. lang was already present, or step is explicitly choice)
    const isHandlingChoice = req.query.lang && digits;

    if (isHandlingChoice) {
      if (digits === '1') {
        return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect method="POST">/api/ivr/species?lang=${lang}</Redirect>
</Response>`);
      } else if (digits === '2') {
        return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect method="POST">/api/ivr/status?lang=${lang}</Redirect>
</Response>`);
      } else if (digits === '3') {
        return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect method="POST">/api/ivr/vet?lang=${lang}</Redirect>
</Response>`);
      }
    }

    // Check retry count
    const retryCount = parseInt(req.query.retry || '0', 10);
    if (retryCount >= 2) {
      const byeMsg = lang === 'en'
        ? "Too many invalid attempts. Thank you for calling Pashu Rakshak. Goodbye."
        : "अधिकतम प्रयास पूरे हुए। पशु रक्षक में कॉल करने के लिए धन्यवाद। अलविदा।";
      const langAttr = lang === 'en' ? 'en-IN' : 'hi-IN';
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="${langAttr}" voice="Polly.Aditi">${escapeXml(byeMsg)}</Say>
  <Hangup/>
</Response>`);
    }

    // Present Main Menu
    const voice = 'Polly.Aditi';
    if (lang === 'en') {
      const intro = retryCount > 0 ? "Invalid choice or timeout. " : "";
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather action="/api/ivr/menu?lang=en" numDigits="1" method="POST" timeout="6">
    <Say language="en-IN" voice="${voice}">${escapeXml(intro)}To register a new animal disease case, press 1. To check the status of your last case, press 2. To talk to a veterinary officer, press 3.</Say>
  </Gather>
  <Redirect method="POST">/api/ivr/menu?lang=en&amp;retry=${retryCount + 1}</Redirect>
</Response>`);
    } else {
      const intro = retryCount > 0 ? "अमान्य विकल्प या समय समाप्त। " : "";
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather action="/api/ivr/menu?lang=hi" numDigits="1" method="POST" timeout="6">
    <Say language="hi-IN" voice="${voice}">${escapeXml(intro)}नया पशु रोग केस दर्ज करने के लिए 1 दबाएं। अपने पिछले केस की स्थिति जानने के लिए 2 दबाएं। पशु चिकित्सा अधिकारी से बात करने के लिए 3 दबाएं।</Say>
  </Gather>
  <Redirect method="POST">/api/ivr/menu?lang=hi&amp;retry=${retryCount + 1}</Redirect>
</Response>`);
    }
  } catch (err) {
    return sendErrorTwiML(res, req.query.lang || 'hi');
  }
});

/**
 * 3.a POST /api/ivr/species
 * Choose species: 1 Cattle, 2 Buffalo, 3 Swine, 4 Poultry
 */
router.post('/species', (req, res) => {
  try {
    res.set('Content-Type', 'text/xml');
    const lang = req.query.lang || 'hi';
    const digits = req.body.Digits;

    // If a valid species digit is supplied in body, redirect directly to symptoms
    if (digits && SPECIES_MAP[digits]) {
      const selected = SPECIES_MAP[digits];
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect method="POST">/api/ivr/symptoms?lang=${lang}&amp;species=${encodeURIComponent(selected)}</Redirect>
</Response>`);
    }

    const retryCount = parseInt(req.query.retry || '0', 10);
    if (retryCount >= 2) {
      const byeMsg = lang === 'en'
        ? "No input received. Goodbye."
        : "कोई इनपुट नहीं मिला। अलविदा।";
      const langAttr = lang === 'en' ? 'en-IN' : 'hi-IN';
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="${langAttr}" voice="Polly.Aditi">${escapeXml(byeMsg)}</Say>
  <Hangup/>
</Response>`);
    }

    const voice = 'Polly.Aditi';
    if (lang === 'en') {
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather action="/api/ivr/symptoms?lang=en" numDigits="1" method="POST" timeout="6">
    <Say language="en-IN" voice="${voice}">Please select animal species. Press 1 for Cattle. Press 2 for Buffalo. Press 3 for Swine. Press 4 for Poultry.</Say>
  </Gather>
  <Redirect method="POST">/api/ivr/species?lang=en&amp;retry=${retryCount + 1}</Redirect>
</Response>`);
    } else {
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather action="/api/ivr/symptoms?lang=hi" numDigits="1" method="POST" timeout="6">
    <Say language="hi-IN" voice="${voice}">पशु का प्रकार चुनें। गाय के लिए 1 दबाएं। भैंस के लिए 2 दबाएं। सूअर के लिए 3 दबाएं। मुर्गी के लिए 4 दबाएं।</Say>
  </Gather>
  <Redirect method="POST">/api/ivr/species?lang=hi&amp;retry=${retryCount + 1}</Redirect>
</Response>`);
    }
  } catch (err) {
    return sendErrorTwiML(res, req.query.lang || 'hi');
  }
});

/**
 * 3.b POST /api/ivr/symptoms
 * Ask symptoms with digit-to-symptom mapping
 */
router.post('/symptoms', (req, res) => {
  try {
    res.set('Content-Type', 'text/xml');
    const lang = req.query.lang || 'hi';
    const digits = req.body.Digits;

    // Resolve species from query, body, or preceding digit
    let species = req.query.species || req.body.species;
    if (!species && digits && SPECIES_MAP[digits]) {
      species = SPECIES_MAP[digits];
    }
    if (!species) {
      species = 'Cattle';
    }

    // If species was already determined and incoming Digits contains symptoms
    if (req.query.species && digits) {
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect method="POST">/api/ivr/pin?lang=${lang}&amp;species=${encodeURIComponent(species)}&amp;symptoms=${encodeURIComponent(digits)}</Redirect>
</Response>`);
    }

    const retryCount = parseInt(req.query.retry || '0', 10);
    if (retryCount >= 2) {
      const byeMsg = lang === 'en'
        ? "No input received. Goodbye."
        : "कोई इनपुट नहीं मिला। अलविदा।";
      const langAttr = lang === 'en' ? 'en-IN' : 'hi-IN';
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="${langAttr}" voice="Polly.Aditi">${escapeXml(byeMsg)}</Say>
  <Hangup/>
</Response>`);
    }

    const voice = 'Polly.Aditi';
    let promptEn = "";
    let promptHi = "";

    if (species === 'Swine') {
      promptEn = "Swine selected. Enter symptoms: press 1 for high fever, 2 for skin redness or bluish color, 3 for bleeding, 4 for sudden deaths. When done, press pound.";
      promptHi = "सूअर चुना गया। लक्षण चुनें: तेज़ बुखार के लिए 1, त्वचा का लाल या नीला पड़ने पर 2, रक्तस्राव के लिए 3, अचानक मौतों के लिए 4 दबाएं। लक्षण चुनने के बाद हैश दबाएं।";
    } else if (species === 'Poultry') {
      promptEn = "Poultry selected. Enter symptoms: press 1 for sudden deaths, 2 for swollen face, 3 for greenish droppings, 4 for breathing trouble. When done, press pound.";
      promptHi = "मुर्गी चुनी गई। लक्षण चुनें: अचानक मौतों के लिए 1, चेहरे पर सूजन के लिए 2, हरा दस्त के लिए 3, सांस लेने में तकलीफ के लिए 4 दबाएं। लक्षण चुनने के बाद हैश दबाएं।";
    } else {
      // Cattle or Buffalo
      const spNameEn = species === 'Buffalo' ? 'Buffalo' : 'Cattle';
      const spNameHi = species === 'Buffalo' ? 'भैंस' : 'गाय';
      promptEn = `${spNameEn} selected. Enter symptoms: press 1 for fever, 2 for skin nodules or lumps, 3 for drooling, 4 for mouth or foot blisters or lameness, 5 for reduced milk or appetite. When done, press pound.`;
      promptHi = `${spNameHi} चुनी गई। लक्षण चुनें: तेज़ बुखार के लिए 1, त्वचा पर गांठों के लिए 2, लार टपकने पर 3, खुर या मुंह के छालों और लंगड़ेपन के लिए 4, दूध या भूख में कमी के लिए 5 दबाएं। लक्षण चुनने के बाद हैश दबाएं।`;
    }

    const introEn = retryCount > 0 ? "No input received. " : "";
    const introHi = retryCount > 0 ? "कोई इनपुट नहीं मिला। " : "";

    if (lang === 'en') {
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather action="/api/ivr/pin?lang=en&amp;species=${encodeURIComponent(species)}" numDigits="5" finishOnKey="#" method="POST" timeout="8">
    <Say language="en-IN" voice="${voice}">${escapeXml(introEn + promptEn)}</Say>
  </Gather>
  <Redirect method="POST">/api/ivr/symptoms?lang=en&amp;species=${encodeURIComponent(species)}&amp;retry=${retryCount + 1}</Redirect>
</Response>`);
    } else {
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather action="/api/ivr/pin?lang=hi&amp;species=${encodeURIComponent(species)}" numDigits="5" finishOnKey="#" method="POST" timeout="8">
    <Say language="hi-IN" voice="${voice}">${escapeXml(introHi + promptHi)}</Say>
  </Gather>
  <Redirect method="POST">/api/ivr/symptoms?lang=hi&amp;species=${encodeURIComponent(species)}&amp;retry=${retryCount + 1}</Redirect>
</Response>`);
    }
  } catch (err) {
    return sendErrorTwiML(res, req.query.lang || 'hi');
  }
});

/**
 * 3.d POST /api/ivr/pin
 * Ask for 6-digit postal PIN code
 */
router.post('/pin', (req, res) => {
  try {
    res.set('Content-Type', 'text/xml');
    const lang = req.query.lang || 'hi';
    const species = req.query.species || req.body.species || 'Cattle';
    const digits = req.body.Digits;

    // Resolve symptoms: from query, body, or preceding Digits
    let symptoms = req.query.symptoms || req.body.symptoms;
    if (!symptoms && digits && digits.length <= 5) {
      symptoms = digits;
    }
    if (!symptoms) {
      // If no symptoms received, redirect back to symptoms step instead of fabricating a dummy value
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect method="POST">/api/ivr/symptoms?lang=${lang}&amp;species=${encodeURIComponent(species)}</Redirect>
</Response>`);
    }

    // If incoming Digits is already a 6-digit PIN, redirect directly to confirm
    if (digits && digits.length === 6) {
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect method="POST">/api/ivr/confirm?lang=${lang}&amp;species=${encodeURIComponent(species)}&amp;symptoms=${encodeURIComponent(symptoms)}&amp;pin=${encodeURIComponent(digits)}</Redirect>
</Response>`);
    }

    const retryCount = parseInt(req.query.retry || '0', 10);
    if (retryCount >= 2) {
      const byeMsg = lang === 'en'
        ? "No input received. Goodbye."
        : "कोई इनपुट नहीं मिला। अलविदा।";
      const langAttr = lang === 'en' ? 'en-IN' : 'hi-IN';
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="${langAttr}" voice="Polly.Aditi">${escapeXml(byeMsg)}</Say>
  <Hangup/>
</Response>`);
    }

    const voice = 'Polly.Aditi';
    const introEn = retryCount > 0 ? "No input received. " : "";
    const introHi = retryCount > 0 ? "कोई इनपुट नहीं मिला। " : "";

    if (lang === 'en') {
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather action="/api/ivr/confirm?lang=en&amp;species=${encodeURIComponent(species)}&amp;symptoms=${encodeURIComponent(symptoms)}" numDigits="6" method="POST" timeout="8">
    <Say language="en-IN" voice="${voice}">${escapeXml(introEn)}Please enter the six digit postal PIN code of your farm.</Say>
  </Gather>
  <Redirect method="POST">/api/ivr/pin?lang=en&amp;species=${encodeURIComponent(species)}&amp;symptoms=${encodeURIComponent(symptoms)}&amp;retry=${retryCount + 1}</Redirect>
</Response>`);
    } else {
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather action="/api/ivr/confirm?lang=hi&amp;species=${encodeURIComponent(species)}&amp;symptoms=${encodeURIComponent(symptoms)}" numDigits="6" method="POST" timeout="8">
    <Say language="hi-IN" voice="${voice}">${escapeXml(introHi)}कृपया अपने फार्म का छह अंकों का पिन कोड दर्ज करें।</Say>
  </Gather>
  <Redirect method="POST">/api/ivr/pin?lang=hi&amp;species=${encodeURIComponent(species)}&amp;symptoms=${encodeURIComponent(symptoms)}&amp;retry=${retryCount + 1}</Redirect>
</Response>`);
    }
  } catch (err) {
    return sendErrorTwiML(res, req.query.lang || 'hi');
  }
});

/**
 * 3.e POST /api/ivr/confirm
 * Read back species, symptoms, PIN code; 1 = confirm, 2 = start over
 */
router.post('/confirm', (req, res) => {
  try {
    res.set('Content-Type', 'text/xml');
    const lang = req.query.lang || 'hi';
    const species = req.query.species || req.body.species || 'Cattle';
    const symptoms = req.query.symptoms || req.body.symptoms;
    const digits = req.body.Digits;

    // Resolve PIN: either from query, or 6-digit digits from previous Gather
    let pin = req.query.pin || req.body.pin;
    if (!pin && digits && digits.length === 6) {
      pin = digits;
    }
    if (!pin || !symptoms) {
      // If PIN or symptoms missing, redirect back to PIN step
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect method="POST">/api/ivr/pin?lang=${lang}&amp;species=${encodeURIComponent(species)}</Redirect>
</Response>`);
    }

    // If caller entered a confirmation digit
    if (digits === '1') {
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect method="POST">/api/ivr/submit?lang=${lang}&amp;species=${encodeURIComponent(species)}&amp;symptoms=${encodeURIComponent(symptoms)}&amp;pin=${encodeURIComponent(pin)}</Redirect>
</Response>`);
    } else if (digits === '2') {
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect method="POST">/api/ivr/menu?lang=${lang}&amp;step=menu</Redirect>
</Response>`);
    }

    const retryCount = parseInt(req.query.retry || '0', 10);
    if (retryCount >= 2) {
      const byeMsg = lang === 'en'
        ? "No input received. Goodbye."
        : "कोई इनपुट नहीं मिला। अलविदा।";
      const langAttr = lang === 'en' ? 'en-IN' : 'hi-IN';
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="${langAttr}" voice="Polly.Aditi">${escapeXml(byeMsg)}</Say>
  <Hangup/>
</Response>`);
    }

    // Read back summary
    const voice = 'Polly.Aditi';
    const { symptomsSpoken } = getSymptomNames(species, symptoms, lang);
    const speciesSpoken = getSpeciesDisplayName(species, lang);
    const pinSpoken = speakDigits(pin);

    if (lang === 'en') {
      const summary = `You have selected: Species: ${speciesSpoken}. Symptoms: ${symptomsSpoken}. PIN code: ${pinSpoken}. To confirm and register this case, press 1. To start over, press 2.`;
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather action="/api/ivr/submit?lang=en&amp;species=${encodeURIComponent(species)}&amp;symptoms=${encodeURIComponent(symptoms)}&amp;pin=${encodeURIComponent(pin)}" numDigits="1" method="POST" timeout="6">
    <Say language="en-IN" voice="${voice}">${escapeXml(summary)}</Say>
  </Gather>
  <Redirect method="POST">/api/ivr/confirm?lang=en&amp;species=${encodeURIComponent(species)}&amp;symptoms=${encodeURIComponent(symptoms)}&amp;pin=${encodeURIComponent(pin)}&amp;retry=${retryCount + 1}</Redirect>
</Response>`);
    } else {
      const summary = `आपकी जानकारी है: पशु: ${speciesSpoken}। लक्षण: ${symptomsSpoken}। पिन कोड: ${pinSpoken}। केस दर्ज करने के लिए 1 दबाएं। दोबारा शुरू करने के लिए 2 दबाएं।`;
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather action="/api/ivr/submit?lang=hi&amp;species=${encodeURIComponent(species)}&amp;symptoms=${encodeURIComponent(symptoms)}&amp;pin=${encodeURIComponent(pin)}" numDigits="1" method="POST" timeout="6">
    <Say language="hi-IN" voice="${voice}">${escapeXml(summary)}</Say>
  </Gather>
  <Redirect method="POST">/api/ivr/confirm?lang=hi&amp;species=${encodeURIComponent(species)}&amp;symptoms=${encodeURIComponent(symptoms)}&amp;pin=${encodeURIComponent(pin)}&amp;retry=${retryCount + 1}</Redirect>
</Response>`);
    }
  } catch (err) {
    return sendErrorTwiML(res, req.query.lang || 'hi');
  }
});

/**
 * 3.f POST /api/ivr/submit
 * Create the case in persistent store and speak confirmation
 */
router.post('/submit', async (req, res) => {
  try {
    res.set('Content-Type', 'text/xml');
    const lang = req.query.lang || 'hi';
    const digits = req.body.Digits;

    // If caller pressed 2 to start over
    if (digits === '2') {
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect method="POST">/api/ivr/menu?lang=${lang}&amp;step=menu</Redirect>
</Response>`);
    }

    const species = req.query.species || req.body.species || 'Cattle';
    const symptomsDigits = req.query.symptoms || req.body.symptoms;
    const pin = req.query.pin || req.body.pin;

    if (!symptomsDigits || !pin) {
      return sendErrorTwiML(res, lang);
    }

    // 1. Resolve coordinates from PIN code
    const { district, lat, lng, approximateLocation } = await resolvePinLocation(pin);

    // 2. Evaluate disease and risk
    const { suspectedDisease, aiRiskLevel } = evaluateDisease(species, symptomsDigits);
    const { symptomsEn } = getSymptomNames(species, symptomsDigits, 'en');

    // 3. Find closest vet using Haversine formula
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

    // 4. Caller phone and animal tag
    const callerPhone = req.body.From || req.query.From || "+919876543210";
    const cleanPhone = String(callerPhone).replace(/\D/g, '');
    const phoneLast4 = cleanPhone.slice(-4) || '0000';
    const timestamp = Date.now();
    const requestId = `req-${timestamp}`;
    const animalTag = `IVR-${phoneLast4}-${String(timestamp).slice(-5)}`;
    const now = new Date();
    const nowStr = now.toISOString().split('T')[0];

    // 5. Build newRequest object
    const newRequest = {
      id: requestId,
      farmId: `farm-${timestamp}`,
      farmerName: "IVR Farmer",
      farmerPhone: callerPhone,
      farmLocation: { lat, lng },
      village: `PIN ${pin}, ${district}`,
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
      notes: "Registered via IVR phone call",
      source: "IVR"
    };

    if (approximateLocation) {
      newRequest.approximateLocation = true;
    }

    // 6. Build newAnimal health passport record
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
          remarks: `Emergency Dispatch Request initiated by Farmer via IVR. Status: INFECTED — AWAITING VET VISIT (${assignedVet.name})`
        }
      ]
    };

    // Save to persistent shared store
    store.addRequest(newRequest);
    store.addAnimal(newAnimal);

    // Speak confirmation
    const reqDigits = String(requestId).replace(/\D/g, '').slice(-6);
    const spokenReqDigits = speakDigits(reqDigits);
    const voice = 'Polly.Aditi';

    if (lang === 'en') {
      const confirmSpeech = `Your case has been registered successfully. A veterinary officer will contact you soon. The last six digits of your case ID are: ${spokenReqDigits}. Thank you for calling Pashu Rakshak. Goodbye.`;
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="en-IN" voice="${voice}">${escapeXml(confirmSpeech)}</Say>
  <Hangup/>
</Response>`);
    } else {
      const confirmSpeech = `आपका केस सफलतापूर्वक दर्ज कर लिया गया है। पशु चिकित्सा अधिकारी जल्द ही आपसे संपर्क करेंगे। आपकी केस संख्या के अंतिम छह अंक हैं: ${spokenReqDigits}। पशु रक्षक में कॉल करने के लिए धन्यवाद। अलविदा।`;
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="hi-IN" voice="${voice}">${escapeXml(confirmSpeech)}</Say>
  <Hangup/>
</Response>`);
    }
  } catch (err) {
    console.error("Error in IVR submit handler:", err);
    return sendErrorTwiML(res, req.query.lang || 'hi');
  }
});

/**
 * 4. POST /api/ivr/status
 * Check status of last case registered by caller's phone number
 */
router.post('/status', (req, res) => {
  try {
    res.set('Content-Type', 'text/xml');
    const lang = req.query.lang || 'hi';
    const callerPhone = req.body.From || req.query.From || '';
    const cleanPhone = String(callerPhone).replace(/\D/g, '');
    const cleanLast10 = cleanPhone.slice(-10);

    const allRequests = store.getRequests();
    const matching = allRequests.filter(r => {
      if (!r.farmerPhone) return false;
      const p = String(r.farmerPhone).replace(/\D/g, '');
      return p === cleanPhone || (cleanLast10.length >= 10 && p.slice(-10) === cleanLast10);
    });

    const voice = 'Polly.Aditi';
    const langAttr = lang === 'en' ? 'en-IN' : 'hi-IN';

    if (matching.length === 0) {
      const notFoundMsg = lang === 'en'
        ? "No registered case was found for this phone number. Returning to the main menu."
        : "आपके इस फोन नंबर से कोई दर्ज केस नहीं मिला। मुख्य मेनू पर वापस जा रहे हैं।";
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="${langAttr}" voice="${voice}">${escapeXml(notFoundMsg)}</Say>
  <Redirect method="POST">/api/ivr/menu?lang=${lang}&amp;step=menu</Redirect>
</Response>`);
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

    const goodbyeMsg = lang === 'en'
      ? "Thank you for calling Pashu Rakshak. Goodbye."
      : "पशु रक्षक में कॉल करने के लिए धन्यवाद। अलविदा।";

    return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="${langAttr}" voice="${voice}">${escapeXml(statusMsg)}</Say>
  <Say language="${langAttr}" voice="${voice}">${escapeXml(goodbyeMsg)}</Say>
  <Hangup/>
</Response>`);
  } catch (err) {
    return sendErrorTwiML(res, req.query.lang || 'hi');
  }
});

/**
 * 5. POST /api/ivr/vet
 * Connect call to Veterinary Officer via <Dial>
 */
router.post('/vet', (req, res) => {
  try {
    res.set('Content-Type', 'text/xml');
    const lang = req.query.lang || 'hi';
    const voice = 'Polly.Aditi';
    const langAttr = lang === 'en' ? 'en-IN' : 'hi-IN';
    const forwardNumber = process.env.VET_FORWARD_NUMBER;

    if (forwardNumber) {
      const msg = lang === 'en'
        ? "Please wait while we connect your call to a veterinary officer."
        : "कृपया प्रतीक्षा करें, आपकी कॉल पशु चिकित्सा अधिकारी से जोड़ी जा रही है।";
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="${langAttr}" voice="${voice}">${escapeXml(msg)}</Say>
  <Dial>${escapeXml(forwardNumber)}</Dial>
</Response>`);
    } else {
      const unavailMsg = lang === 'en'
        ? "Sorry, no veterinary officer is currently available for direct call. Returning to the main menu."
        : "क्षमा करें, इस समय कोई पशु चिकित्सा अधिकारी फोन पर उपलब्ध नहीं हैं। मुख्य मेनू पर वापस जा रहे हैं।";
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="${langAttr}" voice="${voice}">${escapeXml(unavailMsg)}</Say>
  <Redirect method="POST">/api/ivr/menu?lang=${lang}&amp;step=menu</Redirect>
</Response>`);
    }
  } catch (err) {
    return sendErrorTwiML(res, req.query.lang || 'hi');
  }
});

module.exports = router;
