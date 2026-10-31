const http = require('http');
const { app, server } = require('./server');

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

async function runStaticCaptureTests() {
  console.log("=================================================================");
  console.log("EXOTEL STATIC PASSTHRU IVR CAPTURE - COMPREHENSIVE TEST SUITE");
  console.log("=================================================================\n");

  const address = server.address();
  const port = address ? address.port : 5000;
  const baseUrl = `http://localhost:${port}`;
  console.log(`Testing against server at: ${baseUrl}\n`);

  // 1. Health check
  console.log("--- Test 1: Verify Static Endpoint Status ---");
  const initRes = await get(`${baseUrl}/api/exotel/static-capture?CallSid=TEST_INIT`);
  console.log("GET /api/exotel/static-capture (no stage) -> Status:", initRes.status);
  console.log("Response:", initRes.body);
  if (!initRes.body.success) throw new Error("Endpoint failed initial status check");

  // 2. Complete Simulated Flow as specified by user:
  // language=1, menu=1, species=1, symptoms=1, pin=141001, confirmation=1
  console.log("\n--- Test 2: Complete User-Specified Flow (Hindi / Cattle / PIN 141001) ---");
  const callSid = `EXO_PASSTHRU_${Date.now()}`;
  const farmerPhone = "%2B919876543210";

  // Stage 1: language = 1 (Hindi)
  console.log("\n-> Step 1: Passthru stage=language (digits=\"1\")");
  const step1 = await get(`${baseUrl}/api/exotel/static-capture?stage=language&CallSid=${callSid}&CallFrom=${farmerPhone}&digits=%221%22`);
  console.log("Result:", step1.body);
  if (!step1.body.success || step1.body.language !== 'hi') {
    throw new Error("Language capture failed!");
  }

  // Stage 2: menu = 1 (Register Case)
  console.log("\n-> Step 2: Passthru stage=menu (digits=\"1\")");
  const step2 = await get(`${baseUrl}/api/exotel/static-capture?stage=menu&CallSid=${callSid}&CallFrom=${farmerPhone}&digits=%221%22`);
  console.log("Result:", step2.body);
  if (!step2.body.success || step2.body.menuOption !== '1') {
    throw new Error("Menu capture failed!");
  }

  // Stage 3: species = 1 (Cattle)
  console.log("\n-> Step 3: Passthru stage=species (digits=\"1\")");
  const step3 = await get(`${baseUrl}/api/exotel/static-capture?stage=species&CallSid=${callSid}&CallFrom=${farmerPhone}&digits=%221%22`);
  console.log("Result:", step3.body);
  if (!step3.body.success || step3.body.species !== 'Cattle') {
    throw new Error("Species capture failed!");
  }

  // Stage 4: symptoms = 1 (Fever)
  console.log("\n-> Step 4: Passthru stage=symptoms (digits=\"1#\")");
  const step4 = await get(`${baseUrl}/api/exotel/static-capture?stage=symptoms&CallSid=${callSid}&CallFrom=${farmerPhone}&digits=%221%23%22`);
  console.log("Result:", step4.body);
  if (!step4.body.success || step4.body.symptomsRaw !== '1') {
    throw new Error("Symptoms capture failed!");
  }

  // Stage 5: pin = 141001 (Ludhiana)
  console.log("\n-> Step 5: Passthru stage=pin (digits=\"141001\")");
  const step5 = await get(`${baseUrl}/api/exotel/static-capture?stage=pin&CallSid=${callSid}&CallFrom=${farmerPhone}&digits=%22141001%22`);
  console.log("Result:", step5.body);
  if (!step5.body.success || step5.body.pin !== '141001') {
    throw new Error("PIN capture failed!");
  }

  // Stage 6: confirmation = 1 (Confirm & Register)
  console.log("\n-> Step 6: Passthru stage=confirmation (digits=\"1\")");
  const step6 = await get(`${baseUrl}/api/exotel/static-capture?stage=confirmation&CallSid=${callSid}&CallFrom=${farmerPhone}&digits=%221%22`);
  console.log("Result:", step6.body);
  if (!step6.body.success || !step6.body.caseCreated || !step6.body.requestId) {
    throw new Error("Confirmation & Case Creation failed!");
  }

  const createdRequestId = step6.body.requestId;
  const createdAnimalTag = step6.body.animalTag;
  console.log(`\n  >>> SUCCESS! Case Created: ID=${createdRequestId}, Tag=${createdAnimalTag} <<<`);

  // 3. Verify in sharedStore / Dashboard Endpoint (/api/vets/requests)
  console.log("\n--- Test 3: Verify Case in Dashboard Store (/api/vets/requests) ---");
  const dashRes = await get(`${baseUrl}/api/vets/requests`);
  const reqList = Array.isArray(dashRes.body) ? dashRes.body : (dashRes.body.requests || []);
  const found = reqList.find(r => r.id === createdRequestId);

  if (!found) {
    throw new Error(`Created case ${createdRequestId} NOT found in /api/vets/requests!`);
  }

  console.log("Found in Dashboard / Persistent Store:");
  console.log({
    id: found.id,
    animalTag: found.animalTag,
    species: found.species,
    symptoms: found.symptoms,
    aiRiskLevel: found.aiRiskLevel,
    suspectedDisease: found.suspectedDisease,
    village: found.village,
    farmerPhone: found.farmerPhone,
    source: found.source,
    status: found.status
  });

  if (found.species !== 'Cattle') throw new Error("Mismatch in species");
  if (!found.village.includes('141001')) throw new Error("Mismatch in PIN/village");
  if (found.source !== 'IVR-Exotel') throw new Error("Mismatch in source tag");

  console.log("\n  [PASS] Case verified in database & immediately visible on dashboard!");

  // 4. Test Cancellation Flow (confirmation=2)
  console.log("\n--- Test 4: Test Cancellation Flow (digits=2 at confirmation) ---");
  const cancelSid = `EXO_CANCEL_${Date.now()}`;
  await get(`${baseUrl}/api/exotel/static-capture?stage=species&CallSid=${cancelSid}&digits=2`);
  const cancelRes = await get(`${baseUrl}/api/exotel/static-capture?stage=confirmation&CallSid=${cancelSid}&digits=2`);
  console.log("Cancel Response:", cancelRes.body);
  if (!cancelRes.body.cancelled) throw new Error("Cancellation handling failed!");
  console.log("  [PASS] Cancellation handled cleanly.");

  console.log("\n=================================================================");
  console.log("ALL STATIC PASSTHRU IVR TESTS PASSED PERFECTLY!");
  console.log("=================================================================\n");

  server.close();
  process.exit(0);
}

runStaticCaptureTests().catch(err => {
  console.error("\nTEST SUITE FAILED:", err);
  if (server) server.close();
  process.exit(1);
});
