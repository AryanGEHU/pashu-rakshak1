const http = require('http');
const { server } = require('./server');

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    }).on('error', reject);
  });
}

function post(url, bodyData) {
  return new Promise((resolve, reject) => {
    const dataString = typeof bodyData === 'string' ? bodyData : new URLSearchParams(bodyData).toString();
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(dataString)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });
    req.on('error', reject);
    req.write(dataString);
    req.end();
  });
}

function assertGatherSchema(resBody, stepName) {
  const allowedKeys = ['gather_prompt', 'max_input_digits', 'finish_on_key', 'input_timeout', 'repeat_menu', 'repeat_gather_prompt'];
  const keys = Object.keys(resBody);
  const extraKeys = keys.filter(k => !allowedKeys.includes(k));
  if (extraKeys.length > 0) {
    throw new Error(`[${stepName}] Schema violation! Extraneous non-Exotel keys detected: ${extraKeys.join(', ')}`);
  }
  if (!resBody.gather_prompt || typeof resBody.gather_prompt.text !== 'string' || !resBody.gather_prompt.text.trim()) {
    throw new Error(`[${stepName}] Missing or invalid 'gather_prompt.text': ` + JSON.stringify(resBody));
  }
  if (typeof resBody.max_input_digits !== 'number') {
    throw new Error(`[${stepName}] Missing or invalid 'max_input_digits': ` + JSON.stringify(resBody));
  }
  if (typeof resBody.finish_on_key !== 'string' || resBody.finish_on_key === '') {
    throw new Error(`[${stepName}] Missing or invalid 'finish_on_key' (must not be empty string): ` + JSON.stringify(resBody));
  }
  if (typeof resBody.input_timeout !== 'number') {
    throw new Error(`[${stepName}] Missing or invalid 'input_timeout': ` + JSON.stringify(resBody));
  }
  if (typeof resBody.repeat_menu !== 'number') {
    throw new Error(`[${stepName}] Missing or invalid 'repeat_menu': ` + JSON.stringify(resBody));
  }
  if (!resBody.repeat_gather_prompt || typeof resBody.repeat_gather_prompt.text !== 'string' || !resBody.repeat_gather_prompt.text.trim()) {
    throw new Error(`[${stepName}] Missing or invalid 'repeat_gather_prompt.text': ` + JSON.stringify(resBody));
  }
  console.log(`  [PASS] ${stepName}: Valid Exotel Gather JSON schema verified (100% compliant, 0 extra keys).`);
}

async function runTests() {
  console.log("=================================================================");
  console.log("EXOTEL GATHER & PASSTHRU COMPATIBILITY AUDIT - LOCAL TEST SUITE");
  console.log("=================================================================\n");

  const baseUrl = "http://localhost:5000";

  // 1. Health check
  console.log("--- 1. Testing Health Endpoints ---");
  const healthRes = await get(`${baseUrl}/api/exotel/health`);
  console.log("GET /api/exotel/health ->", healthRes.body);
  if (healthRes.body.status !== 'EXOTEL_ONLINE') throw new Error("Exotel health failed");

  // 2. Chained Hindi Flow with Quoted DTMF Digits
  console.log("\n--- 2. Testing Complete Hindi Flow (with realistic Exotel GET params) ---");
  const hindiCallSid = `EXO_AUDIT_HI_${Date.now()}`;
  const farmerPhone = "%2B919876500001";

  // Step 2a: Incoming call arrival (Gather Language)
  console.log("\n-> Step A: /api/exotel/incoming (Language Gather)");
  const stepA = await get(`${baseUrl}/api/exotel/incoming?CallSid=${hindiCallSid}&CallFrom=${farmerPhone}&CallTo=08047289751&Direction=incoming`);
  assertGatherSchema(stepA.body, "Gather(Language)");
  console.log("Prompt:", stepA.body.gather_prompt.text);

  // Step 2b: Caller pressed 1 for Hindi -> Exotel calls /api/exotel/menu with digits="1"
  console.log("\n-> Step B: /api/exotel/menu (Main Menu Gather, digits=\"\"1\"\")");
  const stepB = await get(`${baseUrl}/api/exotel/menu?CallSid=${hindiCallSid}&CallFrom=${farmerPhone}&digits=%221%22`);
  assertGatherSchema(stepB.body, "Gather(Main Menu)");
  console.log("Prompt:", stepB.body.gather_prompt.text);
  if (!stepB.body.gather_prompt.text.includes("नया पशु रोग केस")) throw new Error("Hindi menu prompt not returned");

  // Step 2c: Caller pressed 1 to Register Case -> Exotel calls /api/exotel/species with digits="1"
  console.log("\n-> Step C: /api/exotel/species (Species Gather, digits=\"\"1\"\")");
  const stepC = await get(`${baseUrl}/api/exotel/species?CallSid=${hindiCallSid}&CallFrom=${farmerPhone}&digits=%221%22`);
  assertGatherSchema(stepC.body, "Gather(Species)");
  console.log("Prompt:", stepC.body.gather_prompt.text);
  if (!stepC.body.gather_prompt.text.includes("गाय के लिए 1")) throw new Error("Species prompt not returned");

  // Step 2d: Caller pressed 1 for Cattle -> Exotel calls /api/exotel/symptoms with digits="1"
  console.log("\n-> Step D: /api/exotel/symptoms (Symptoms Gather, digits=\"\"1\"\")");
  const stepD = await get(`${baseUrl}/api/exotel/symptoms?CallSid=${hindiCallSid}&CallFrom=${farmerPhone}&digits=%221%22`);
  assertGatherSchema(stepD.body, "Gather(Symptoms)");
  console.log("Prompt:", stepD.body.gather_prompt.text);
  if (!stepD.body.gather_prompt.text.includes("गाय चुनी गई")) throw new Error("Cattle symptoms prompt not returned");
  if (stepD.body.finish_on_key !== '#') throw new Error("Symptoms finish_on_key should be #");

  // Step 2e: Caller entered symptoms "12#" -> Exotel calls /api/exotel/pin with digits="\"12#\""
  console.log("\n-> Step E: /api/exotel/pin (PIN Gather, digits=\"\"12#\"\")");
  const stepE = await get(`${baseUrl}/api/exotel/pin?CallSid=${hindiCallSid}&CallFrom=${farmerPhone}&digits=%2212%23%22`);
  assertGatherSchema(stepE.body, "Gather(PIN)");
  console.log("Prompt:", stepE.body.gather_prompt.text);
  if (!stepE.body.gather_prompt.text.includes("पिन कोड दर्ज करें")) throw new Error("PIN prompt not returned");
  if (stepE.body.max_input_digits !== 6) throw new Error("PIN max_input_digits should be 6");

  // Step 2f: Caller entered PIN "141001" -> Exotel calls /api/exotel/confirm with digits="\"141001\""
  console.log("\n-> Step F: /api/exotel/confirm (Confirmation Gather, digits=\"\"141001\"\")");
  const stepF = await get(`${baseUrl}/api/exotel/confirm?CallSid=${hindiCallSid}&CallFrom=${farmerPhone}&digits=%22141001%22`);
  assertGatherSchema(stepF.body, "Gather(Confirmation)");
  console.log("Prompt:", stepF.body.gather_prompt.text);
  if (!stepF.body.gather_prompt.text.includes("गाय") || !stepF.body.gather_prompt.text.includes("1 . 4 . 1 . 0 . 0 . 1")) {
    throw new Error("Confirmation summary missing species or spoken pin");
  }

  // Step 2g: Caller pressed 1 to Confirm -> Exotel calls /api/exotel/submit with digits="\"1\""
  console.log("\n-> Step G: /api/exotel/submit (Final Case Submission & Completion TTS)");
  const stepG = await get(`${baseUrl}/api/exotel/submit?CallSid=${hindiCallSid}&CallFrom=${farmerPhone}&digits=%221%22`);
  assertGatherSchema(stepG.body, "Final Confirmation TTS");
  console.log("Final Prompt:", stepG.body.gather_prompt.text);

  // Step 2h: Verify case in sharedStore via API
  console.log("\n-> Step H: Verify Case in sharedStore");
  const storeRequests = await get(`${baseUrl}/api/vets/requests`);
  const reqList = Array.isArray(storeRequests.body) ? storeRequests.body : (storeRequests.body.requests || []);
  const cleanPhone = "+919876500001";
  const foundInStore = reqList.find(r => r.farmerPhone === cleanPhone || (r.notes && r.notes.includes("Exotel")));
  if (!foundInStore) throw new Error("Created case not found in sharedStore /api/vets/requests!");
  console.log(`  [PASS] Case ${foundInStore.id} successfully persisted in sharedStore with source: '${foundInStore.source}'!`);

  const last6Digits = foundInStore.id.replace(/\D/g, '').slice(-6);
  const spokenDigits = last6Digits.split('').join(' . ');
  if (!stepG.body.gather_prompt.text.includes(spokenDigits)) {
    throw new Error(`Spoken Case ID '${spokenDigits}' not found in final Hindi prompt!`);
  }

  // 3. Complete English Flow
  console.log("\n--- 3. Testing Complete English Flow ---");
  const enCallSid = `EXO_AUDIT_EN_${Date.now()}`;
  const enPhone = "%2B919876500002";

  // Language choice = 2 (English) -> hits menu
  const enMenu = await get(`${baseUrl}/api/exotel/menu?CallSid=${enCallSid}&CallFrom=${enPhone}&digits=%222%22`);
  assertGatherSchema(enMenu.body, "EN Menu Gather");
  if (!enMenu.body.gather_prompt.text.includes("To register a new animal disease case, press 1")) {
    throw new Error("English menu prompt failed: " + enMenu.body.gather_prompt.text);
  }

  // Register choice = 1 -> hits species
  const enSpecies = await get(`${baseUrl}/api/exotel/species?CallSid=${enCallSid}&CallFrom=${enPhone}&digits=%221%22`);
  assertGatherSchema(enSpecies.body, "EN Species Gather");
  if (!enSpecies.body.gather_prompt.text.includes("Please select animal species")) {
    throw new Error("English species prompt failed");
  }

  // Species choice = 3 (Swine) -> hits symptoms
  const enSymptoms = await get(`${baseUrl}/api/exotel/symptoms?CallSid=${enCallSid}&CallFrom=${enPhone}&digits=%223%22`);
  assertGatherSchema(enSymptoms.body, "EN Swine Symptoms Gather");
  if (!enSymptoms.body.gather_prompt.text.includes("Swine selected")) {
    throw new Error("English swine symptoms prompt failed");
  }

  // Symptoms = "14#" -> hits pin
  const enPin = await get(`${baseUrl}/api/exotel/pin?CallSid=${enCallSid}&CallFrom=${enPhone}&digits=%2214%23%22`);
  assertGatherSchema(enPin.body, "EN PIN Gather");
  if (!enPin.body.gather_prompt.text.includes("Please enter the six digit postal PIN code")) {
    throw new Error("English PIN prompt failed");
  }

  // PIN = "141002" -> hits confirm
  const enConfirm = await get(`${baseUrl}/api/exotel/confirm?CallSid=${enCallSid}&CallFrom=${enPhone}&digits=%22141002%22`);
  assertGatherSchema(enConfirm.body, "EN Confirm Gather");
  if (!enConfirm.body.gather_prompt.text.includes("Species: Swine") || !enConfirm.body.gather_prompt.text.includes("1 . 4 . 1 . 0 . 0 . 2")) {
    throw new Error("English confirm prompt failed");
  }

  // Confirm = 1 -> submit
  const enSubmit = await get(`${baseUrl}/api/exotel/submit?CallSid=${enCallSid}&CallFrom=${enPhone}&digits=%221%22`);
  assertGatherSchema(enSubmit.body, "EN Final Confirm TTS");
  console.log("English Final Prompt:", enSubmit.body.gather_prompt.text);
  if (!enSubmit.body.gather_prompt.text.includes("Your case has been registered successfully")) {
    throw new Error("English submission confirmation failed");
  }

  // 4. Case Status Endpoint
  console.log("\n--- 4. Testing Case Status Lookup ---");
  const statusRes = await get(`${baseUrl}/api/exotel/status?CallSid=EXO_STATUS_TEST&CallFrom=${farmerPhone}`);
  assertGatherSchema(statusRes.body, "Status Lookup Gather");
  console.log("Status Prompt:", statusRes.body.gather_prompt.text);
  if (!statusRes.body.gather_prompt.text.includes("लंबित")) {
    throw new Error("Status check failed: prompt does not mention pending status");
  }

  // 5. Vet Transfer Endpoint
  console.log("\n--- 5. Testing Vet Officer Endpoint ---");
  const vetRes = await get(`${baseUrl}/api/exotel/vet?CallSid=EXO_VET_TEST&CallFrom=${farmerPhone}`);
  assertGatherSchema(vetRes.body, "Vet Officer Gather");
  console.log("Vet Prompt:", vetRes.body.gather_prompt.text);

  // 6. Verify Twilio IVR still works perfectly without any regressions
  console.log("\n--- 6. Verifying Twilio IVR (Regression Check) ---");
  const twilioHealth = await get(`${baseUrl}/api/ivr/health`);
  console.log("GET /api/ivr/health ->", twilioHealth.body);
  if (twilioHealth.body.status !== 'IVR_ONLINE') throw new Error("Twilio health check failed");

  const twilioIncoming = await post(`${baseUrl}/api/ivr/incoming`, {
    CallSid: `CA_TWILIO_TEST_${Date.now()}`,
    From: '+1234567890'
  });
  console.log("POST /api/ivr/incoming -> HTTP", twilioIncoming.status, "| TwiML length:", twilioIncoming.body.length);
  if (twilioIncoming.status !== 200 || !twilioIncoming.body.includes("<Response>")) {
    throw new Error("Twilio IVR regression detected!");
  }
  console.log("  [PASS] Twilio IVR incoming webhook continues to return valid TwiML!");

  console.log("\n=================================================================");
  console.log("ALL TESTS COMPLETED SUCCESSFULLY! ZERO REGRESSIONS DETECTED.");
  console.log("=================================================================\n");
  if (server) server.close();
  process.exit(0);
}

runTests().catch(err => {
  console.error("\nTEST FAILURE:", err);
  if (server) server.close();
  process.exit(1);
});

