# Phone testing on the local network (mkcert)

Browsers only allow the camera on **HTTPS**, and phones cannot reach `localhost`. ResortOS uses a development
certificate for your Mac's Wi-Fi IP address. Nothing is exposed to the internet. **Demo data only.**

The Mac and the phones must be on the **same Wi-Fi**. (Guest/"isolated" Wi-Fi networks that block
device-to-device traffic will not work.)

## 1. One-time setup on the Mac

```bash
brew install mkcert nss
cd resortos
pnpm db:up                # PostgreSQL + MinIO
pnpm https:setup          # asks for your Mac password once; prints your LAN IP
```

`https:setup` creates a certificate for `localhost` and your LAN IP, switches MinIO to HTTPS, writes
`.env.lan`, and puts the certificate authority files for phones in `ops/dev-https/certs/`:

- `ResortOS-dev-CA.pem` — for iPhone
- `ResortOS-dev-CA.crt` — for Android

If your IP changes (different Wi-Fi), run `pnpm https:setup` again and reinstall nothing on the phones —
the certificate authority stays the same.

## 2. Start the apps (two terminals)

```bash
pnpm dev:api:lan
pnpm dev:web:lan
```

Open the desk on the Mac: `https://<LAN-IP>:3000` → log in as `priya` / `Aravali#Desk26`.

## 3. Install the certificate on an iPhone

1. AirDrop `ResortOS-dev-CA.pem` to the iPhone (or email it and open the attachment in Mail).
2. Tap **Allow** when asked to download a configuration profile.
3. **Settings → General → VPN & Device Management** → *mkcert development CA* → **Install** (enter passcode) → Install.
4. **Settings → General → About → Certificate Trust Settings** → turn on **mkcert development CA** → Continue.
5. In Safari open `https://<LAN-IP>:3000/login` — there must be **no** certificate warning.

Remove it after testing: Settings → General → VPN & Device Management → the profile → Remove Profile.

## 4. Install the certificate on an Android phone

1. Copy `ResortOS-dev-CA.crt` to the phone (USB, Google Drive, or email → Download).
2. **Settings → Security & privacy → More security settings → Encryption & credentials → Install a certificate → CA certificate** → Install anyway → pick the file.
   (Menu names vary by brand; search Settings for "CA certificate".)
3. In Chrome open `https://<LAN-IP>:3000/login` — no certificate warning.

Remove it after testing: Encryption & credentials → User credentials / Trusted credentials → User → remove.

## 5. Checklist — do this on each phone

Start a check-in at the desk: open a booking arriving today → **Check in** → step 3 **Documents** → **Show QR code**.

| # | Check | Pass? |
|---|---|---|
| 1 | Scan the QR with the phone's **camera app**. The scanner page opens without a certificate warning; the desk shows **Phone connected**. | |
| 2 | The phone page shows *Guest 1, Guest 2* — **no names, mobile numbers, room or booking numbers**. | |
| 3 | Scan the same QR with a **second phone** → it is refused ("already opened on another phone"). | |
| 4 | Guest 1: **Take photo** → the rear camera opens → take the photo of an ID card on a table. Corners snap to the card edges (or drag them). **Crop** → **Use photo**. | |
| 5 | The desk's "Scan with phone" list shows the document arriving, then **Received** — within ~5 s on good Wi-Fi. | |
| 6 | Take a deliberately **blurry** photo → "Photo looks blurry — retake?" appears. Take one in **dim light** → "too dark". | |
| 7 | Guest 2: ID type **Aadhaar** (use a dummy/sample card) → capture → the black box must cover the first 8 digits; **Continue** stays disabled until you tick the check box. | |
| 8 | **Weak network:** start an upload, and while it shows *Uploading*, turn **Wi-Fi off** (Control Centre / quick settings). The slot shows **Saved — waiting for network**. | |
| 9 | With Wi-Fi still off, capture one more document → it also waits. | |
| 10 | **Refresh** the page (pull down) while offline if the browser allows, otherwise just turn **Wi-Fi back on** → both uploads resume on their own and the desk shows **Received**. | |
| 11 | Turn Wi-Fi on, lock the phone for 30 s, unlock → the page is still connected; nothing is lost. | |
| 12 | **Live camera** link: permission prompt → allow → preview → Capture. Then deny camera permission in settings → clear instructions for that browser appear. | |
| 13 | iPhone only: **Choose file** → pick a photo from the gallery (HEIC) → it uploads normally. | |
| 14 | Leave the QR open for **10 minutes** → the phone says the code expired; the desk offers **Show a new code**. | |
| 15 | Back on the desk: finish check-in (signature + confirm). Open the stay → open the Aadhaar image → the first 8 digits are black. | |

Please send for each phone: **phone model, iOS/Android version, browser version**, the table above, and
screenshots of anything that looked wrong (include the request ID if an error shows one).

## Notes for testers

- Blur/brightness thresholds are first estimates (`apps/web/src/lib/capture/image.ts → QUALITY_LIMITS`);
  report if good photos are flagged or bad ones pass.
- Edge detection runs on the phone (OpenCV, ~10 MB, downloaded once when the scanner opens). On a slow
  connection the corners may take a few seconds to snap — dragging them manually always works.
