# Phone testing (camera, phone-as-scanner)

Browsers only allow camera access on **HTTPS**, and a phone cannot reach `localhost`. Use one of the two setups below. Never point a phone at a database with real guest data — use the demo seed only.

## Option A — Cloudflare quick tunnel (recommended for phones)

Gives a temporary public `https://…trycloudflare.com` address with a certificate every phone already trusts.

```bash
brew install cloudflared                 # once
pnpm dev:api                             # terminal 1
pnpm dev:web                             # terminal 2
pnpm tunnel                              # terminal 3 → prints https://<random>.trycloudflare.com
```

Then set in `.env` and restart API + web:

```
PUBLIC_WEB_URL=https://<random>.trycloudflare.com      # used inside the QR code
DEV_ALLOWED_ORIGINS=<random>.trycloudflare.com
```

⚠️ The tunnel address is reachable from the internet while it runs. Use demo data only, stop the tunnel when done (Ctrl+C), and do not share the address.

## Option B — HTTPS on the local network (mkcert)

Stays inside the office Wi-Fi, but each phone must trust the development certificate authority.

```bash
brew install mkcert && mkcert -install   # once; asks for your Mac password
pnpm dev:web:lan-https                    # https://<mac-lan-ip>:3000
```

Install the CA on each test phone: `mkcert -CAROOT` → copy `rootCA.pem` to the phone →
- iPhone: open the file → Settings → Profile Downloaded → Install → Settings → General → About → Certificate Trust Settings → enable full trust
- Android: Settings → Security → Encryption & credentials → Install a certificate → CA certificate

Set `PUBLIC_WEB_URL=https://<mac-lan-ip>:3000` and `DEV_ALLOWED_ORIGINS=<mac-lan-ip>`.

## Test matrix (every release that touches capture — spec §79.5)

| Device | Browser | Result | Tester | Date |
|---|---|---|---|---|
| iPhone (iOS current − 1 or newer) | Safari | | | |
| Budget Android (≤ ₹12,000, 3–4 GB RAM) | Chrome | | | |
| Mid-range Android | Chrome | | | |
| Windows laptop + USB webcam | Chrome | | | |
| MacBook | Safari | | | |

For each device check:

1. **QR:** desk shows QR → phone camera app opens the capture page → desk shows "phone connected". Scanning the same QR with a second phone is refused.
2. **Permission:** deny camera → clear instructions appear for that browser → allow → capture works.
3. **Capture:** guest photo, ID front, ID back, extra page. Edge detection crops; manual corner adjustment works when detection fails.
4. **Quality:** a deliberately blurry photo triggers "Photo looks blurry — retake?".
5. **Aadhaar:** the first 8 digits must be covered before upload is possible; open the stored image on the desk and confirm the digits are not visible.
6. **Weak network — upload drops and resumes:**
   - start an ID upload, switch the phone to aeroplane mode mid-upload → the page shows "Waiting for network", nothing is lost
   - refresh the page while offline → the queued photo is still there (IndexedDB)
   - turn the network back on → upload resumes automatically → desk shows ✓ within a few seconds
   - repeat on mobile data with "2G/Edge" forced (Android: Settings → Network → Preferred network type)
7. **Server verification:** the desk only shows ✓ after verification; check-in cannot be confirmed while a document says "Uploading…".
8. **Expiry:** leave the QR 10 minutes → phone shows "code expired, ask the desk for a new one".
9. **HEIC (iPhone):** photos from the gallery upload as JPEG.
10. **Size:** each stored image under ~600 KB, longest side ≤ 2000 px, no location in EXIF.

Record failures with device model, browser version, network, and the request ID shown in the error.
