# Pashu Rakshak — IVR Phone Webhook Integration Setup

This document provides complete instructions for configuring, exposing, and operating the Twilio Voice IVR (Interactive Voice Response) system for rural livestock disease registration in **Pashu Rakshak**.

---

## 1. Environment Variables

Add the following environment variables to your deployment or `.env` configuration as needed:

| Variable | Required? | Default | Description |
| :--- | :--- | :--- | :--- |
| `VET_FORWARD_NUMBER` | Optional | *None* | E.164 formatted phone number (e.g. `+919876543210`) to forward callers who choose "Talk to a Vet Officer" (Option 3). |
| `TWILIO_AUTH_TOKEN` | Optional | *None* | Your Twilio Account Auth Token used for cryptographic request signature validation (`X-Twilio-Signature`). |
| `IVR_VALIDATE_SIGNATURE` | Optional | `false` | Set to `'true'` to enforce HMAC-SHA1 validation on all incoming Twilio POST webhooks. |

*(Note: Do not modify `.env.example` in this repo to keep source control intact).*

---

## 2. Architecture & Endpoints

All endpoints are hosted under `/api/ivr` and respond with `Content-Type: text/xml` and valid TwiML:

| Endpoint | HTTP Method | Description |
| :--- | :--- | :--- |
| `/api/ivr/health` | `GET` | Health check probe returning `{ status: "IVR_ONLINE" }`. |
| `/api/ivr/incoming` | `POST` | Primary Twilio Voice entry webhook. Prompts language selection (`1` for Hindi, `2` for English). |
| `/api/ivr/menu` | `POST` | Main navigation menu: `1` Register Case, `2` Check Case Status, `3` Talk to Vet Officer. |
| `/api/ivr/species` | `POST` | Livestock species prompt: `1` Cattle, `2` Buffalo, `3` Swine, `4` Poultry. |
| `/api/ivr/symptoms` | `POST` | Species-specific symptom checklist (multi-digit entry terminated by `#`). |
| `/api/ivr/pin` | `POST` | 6-digit postal PIN code keypad entry. |
| `/api/ivr/confirm` | `POST` | Auditory readback of selected species, symptoms, and PIN (`1` Confirm, `2` Restart). |
| `/api/ivr/submit` | `POST` | Geocodes PIN, computes AI disease risk, dispatches nearest vet, writes to `sharedStore`, and speaks Request ID. |
| `/api/ivr/status` | `POST` | Looks up caller's phone number and speaks current dispatch/inspection status. |
| `/api/ivr/vet` | `POST` | Connects call to `VET_FORWARD_NUMBER` via `<Dial>` or gracefully falls back to menu. |

---

## 3. Exposing Local Backend via ngrok

To receive incoming calls from real phone networks during local development:

### Step 1: Start the Backend Server
```bash
npm run dev
# Or start specifically the backend:
npm run server
```
The server will start on `http://localhost:5000`.

### Step 2: Launch ngrok Tunnel
In a new terminal, launch an HTTP tunnel to port 5000:
```bash
ngrok http 5000
```

ngrok will output a public HTTPS forwarding URL such as:
```text
Forwarding   https://a1b2-c3d4-e5f6.ngrok-free.app -> http://localhost:5000
```

---

## 4. Configuring Twilio Console

1. Log into your [Twilio Console](https://console.twilio.com/).
2. Navigate to **Phone Numbers** -> **Manage** -> **Active numbers**.
3. Select your active virtual phone number.
4. Scroll down to the **Voice Configuration** section:
   - Under **A CALL COMES IN**: Select **Webhook**.
   - **URL**: Paste your public HTTPS endpoint:
     ```text
     https://<your-ngrok-domain>.ngrok-free.app/api/ivr/incoming
     ```
   - **HTTP Method**: Select `HTTP POST`.
5. Click **Save Configuration**.

---

## 5. Simulating the Call Flow via curl

You can test the entire IVR flow locally without a real phone:

### 1. Incoming Call (Choose Hindi: Digits=1)
```bash
curl -X POST http://localhost:5000/api/ivr/incoming --data-urlencode "From=+919876543210"
```

### 2. Main Menu (Select 1: Register Case)
```bash
curl -X POST "http://localhost:5000/api/ivr/menu" --data-urlencode "From=+919876543210" --data-urlencode "Digits=1"
curl -X POST "http://localhost:5000/api/ivr/menu?lang=hi" --data-urlencode "From=+919876543210" --data-urlencode "Digits=1"
```

### 3. Select Species (Select 1: Cattle)
```bash
curl -X POST "http://localhost:5000/api/ivr/species?lang=hi" --data-urlencode "From=+919876543210" --data-urlencode "Digits=1"
```

### 4. Select Symptoms (Fever + Skin Nodules: 12#)
```bash
curl -X POST "http://localhost:5000/api/ivr/symptoms?lang=hi&species=Cattle" --data-urlencode "From=+919876543210" --data-urlencode "Digits=12"
```

### 5. Enter PIN Code (PIN 141001)
```bash
curl -X POST "http://localhost:5000/api/ivr/pin?lang=hi&species=Cattle&symptoms=12" --data-urlencode "From=+919876543210" --data-urlencode "Digits=141001"
```

### 6. Readback & Confirm (Press 1 to Confirm)
```bash
curl -X POST "http://localhost:5000/api/ivr/confirm?lang=hi&species=Cattle&symptoms=12&pin=141001" --data-urlencode "From=+919876543210" --data-urlencode "Digits=1"
```

### 7. Submit Case
```bash
curl -X POST "http://localhost:5000/api/ivr/submit?lang=hi&species=Cattle&symptoms=12&pin=141001" --data-urlencode "From=+919876543210" --data-urlencode "Digits=1"
```

### 8. Verify Outbreak Map & Vet Queue
```bash
# Verify new request appears in active vet queue
curl http://localhost:5000/api/vets/requests

# Verify request projected as a Red Spot hotspot on GIS outbreak map
curl http://localhost:5000/api/outbreaks/summary
```

---

## 6. Exotel Static IVR Flow Builder Integration (Passthru Capture)

For teams using **Exotel's Visual Flow Builder** with static audio/TTS applets instead of dynamic Programmable Gather webhooks, Pashu Rakshak provides a high-reliability Passthru capture endpoint:

### Endpoint
```
GET /api/exotel/static-capture?stage=<STAGE>
```

### Flow Builder Applet Placement
In Exotel Flow Builder, insert an **HTTP Passthru Applet** immediately after each static Gather applet to capture the caller's input:

| Step | Current Static Applet | Next Inserted Applet | Passthru HTTP Method & URL |
| :--- | :--- | :--- | :--- |
| **1** | **Language Gather** | Passthru (Language) | `GET https://<YOUR_DOMAIN>/api/exotel/static-capture?stage=language` |
| **2** | **Main Menu Gather** | Passthru (Menu) | `GET https://<YOUR_DOMAIN>/api/exotel/static-capture?stage=menu` |
| **3** | **Species Gather** | Passthru (Species) | `GET https://<YOUR_DOMAIN>/api/exotel/static-capture?stage=species` |
| **4** | **Symptoms Gather** | Passthru (Symptoms) | `GET https://<YOUR_DOMAIN>/api/exotel/static-capture?stage=symptoms` |
| **5** | **PIN Gather** | Passthru (PIN) | `GET https://<YOUR_DOMAIN>/api/exotel/static-capture?stage=pin` |
| **6** | **Confirmation Gather** | Passthru (Confirmation) | `GET https://<YOUR_DOMAIN>/api/exotel/static-capture?stage=confirmation` |

### How It Works:
1. When a caller enters DTMF digits in any Gather applet, Exotel automatically passes `CallSid`, `CallFrom`, and `digits` to the Passthru URL.
2. The endpoint strips whitespace, quotes, and `#`, storing inputs in the active call session.
3. At `stage=confirmation`, if `digits=1`, the backend evaluates disease risk, geocodes the farm PIN, dispatches the nearest vet officer, and commits the case to `sharedStore`.
4. The case immediately appears on the **Veterinary Dashboard** (`/api/vets/requests`).

