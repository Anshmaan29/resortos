# Laxmi Palace handover

## Daily use

Open https://resortos-production.up.railway.app on the reception computer or phone.

- Make a booking, choose the room and enter the agreed room price. Add extra adult/child charges per night if needed. Add an extra bed or meal by its name and agreed price in the bill.
- Check in: enter guest details, then show the scanner QR. Scan it with the phone camera, or use **Open scanner on this phone** when working directly on a phone. No guest login is needed.
- Photograph the face and both required ID sides. Crop the document, check the preview, then tap **Use photo**. Wait for **Received** before closing the scanner. The scanner link expires after ten minutes; reception can issue a new link.
- Phone photos are re-encoded without GPS/EXIF metadata. Guest photos target at most 200 KB / 1200 px; documents target at most 600 KB / 2000 px. Compression does not recognise a face or authenticate an ID. Reception must check the guest and legibility.
- A lost connection queues photos on the phone where browser storage is available. Restricted/private browsers may need the page to stay open. The app explains when an upload is blocked or a link has expired.
- GST: reception can enter editable, dated tax rules in **Settings → Tax**. Get the room and food percentages from the accountant before issuing real tax invoices. Rates have deliberately not been guessed. Settings changes do not rewrite final invoices.
- The owner downloads **Records → Download all records (Excel)** for all dates, or individual Excel/CSV reports by date. This contains operational records, not a restorable database image. Use **Download** next to a guest/stay document to save its photo or PDF.

## Storage and Sheets

Bookings, contacts, money records and settings live in Railway PostgreSQL. Private photos and documents live in the Railway object bucket. Google Sheets is an optional copy, not the source for reception edits.

Sheets setup can wait until the hotel creates its private blank sheet. Operator setup:

1. In a hotel-controlled Google Cloud project, enable **Google Sheets API**, create a service account, and download its JSON key.
2. Share the blank sheet with the key's `client_email` as **Editor**. Keep the sheet private.
3. In Railway's resortos service, save `GOOGLE_SERVICE_ACCOUNT_JSON` as the complete JSON key and `GOOGLE_SHEETS_ID` as the ID between `/d/` and `/edit` in the sheet URL. Keys never belong in chat, source control, or the browser.
4. Deploy, open **Records → Google Sheets**, and click **Sync now**. Check the result in the sheet. Background jobs refresh it every five minutes.
5. Keep your own notes in separate tabs. Tabs starting with `ResortOS ` used by this integration are owned by the mirror and their cell values are replaced on every sync. Bookings, guest names and masked mobiles, payments, invoices, expenses and daily summaries are copied; Full phones, email, addresses, notes, flags, ID images, signatures and Form C/passport details are not.

A sync failure does not block bookings. The status shows the last attempt and its error; the next scheduled sync retries. Current limit: 24,999 data rows per mirrored tab; exceeding it reports an error rather than silently dropping records. This connection supports one hotel per deployment.

Official setup references: [Google service accounts](https://developers.google.com/identity/protocols/oauth2/service-account), [Sheets batch updates](https://developers.google.com/workspace/sheets/api/guides/batchupdate).

## Phone upload access

The private Railway bucket needs a browser CORS rule for the hotel's exact HTTPS origin. An authenticated owner/operator can call `POST /api/v1/storage/phone-access` with the normal ResortOS security header to configure it. This keeps existing unrelated rules, permits only GET/HEAD/PUT for the app origin with the required checksum/content headers, and does not make guest files public. Changing the app domain requires applying the rule again. The owner may supply `{ "origin": "https://pms.voittoventures.com" }` to authorize that exact additional HTTPS origin. Previously approved app origins are retained during the transition; wildcards are not added. Also update Railway PUBLIC_WEB_URL and WEB_ORIGIN to the new address so generated scanner links use it. A successful storage health ping alone does not prove browser uploads work; verify a synthetic upload reaches **Received**.

## Before taking real bookings

- Accountant confirms and reception saves GST rules. Print one invoice and receipt on the hotel's printer.
- Test one actual Android phone and one actual iPhone on hotel Wi-Fi/mobile data: open scanner, photograph face/front/back, retake, disconnect/reconnect, and verify each original at the desk. Browser emulation cannot prove camera permission, HEIC decoding or a physical camera's focus.
- Owner confirms rooms, prices, extra guest/bed policy, ID retention policy and contact details, and trains reception on cancellation/refund/day closing.
- Railway billing is upgraded before the trial ends. Enable Railway's database recovery/backup controls and keep the hotel's owner/admin recovery details private.
- Create the Google Sheet when wanted. Until credentials and a real sheet are connected, automatic sync is not live.
- Guest email has passed a provider delivery check. Configure Resend's signed delivery webhook if delivered/bounced status is needed in the app; review wording and sender/reply-to before handover.

This checklist records remaining acceptance work. Passing automated tests alone is not a handover sign-off.
