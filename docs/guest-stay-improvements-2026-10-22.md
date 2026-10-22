# Guest registration and stay extension

## Reception workflow

- Guest photo is optional on both the reception screen and phone scanner. Required ID fronts/backs and the existing guest-registration checks remain mandatory. Existing photographs are retained.
- Entering a full mobile number automatically selects an exact, unique existing guest in the current property. Partial matches, shared numbers and a different entered name still need an explicit choice. Existing WhatsApp declines remain in effect.
- When starting a new check-in for that saved guest, the primary guest's saved nationality, ID type, last four characters and available verified ID documents are added. Staff should check that the ID is still current. Capture a replacement when details have changed. Other adults still require their own IDs; signatures and registration consent are not copied.
- In **In house**, choose **Extend** next to the room; the stay page also has **Extend stay**. Villa overnight booking details link to the same flow.
- Choose the new checkout date and enter **the combined price for the extra nights before GST**. It includes extra guests and the current meal plan. The existing booking GST rule applies; the earlier nights keep their prices.
- If money has already been received, select **Payment received now**, enter the amount including any GST, method/account and reference where required. The extension and payment are saved together. The software records payments; it does not collect or charge money.
- If payment is not received yet, leave it unticked and record payment later on the bill. Hotel cash payments still require an open shift; Villa's existing cash workflow stays in effect.

## Data protections

- No historical reservation, payment, invoice, ID object or stay is rewritten by this release. Only an explicitly extended active stay receives extra priced nights, new departure dates and optional payment.
- An extension checks the room allocation, hotel inventory, maintenance dates and Villa resource exclusion rules. Concurrent edits use the displayed expected departure as a freshness check; repeated submission uses existing idempotency protection.
- Added-night totals are allocated in whole paise without rounding drift or automatically adding a second meal/extra-guest charge.
- Saved-ID reuse is property scoped and tied to the identified primary guest's record and matching identity. An unrelated guest sharing a phone/name gets no ID automatically.
- ID files are read and copied outside database transactions. New private objects and new document rows preserve source provenance. Checksums are checked, views use the existing short-lived signed URLs and access log, and reuse is audited with identifiers only. Missing or damaged source files require fresh capture.
- A changed name/ID cannot silently use a saved ID belonging to another identity. Staff edits/new captures during copying take precedence. Past-stay document access remains owner-only.

## Deployment

Migration `0031_optional_photo_returning_guest.sql` sets the photo policy to optional and adds document reuse provenance. It retains all captured images and historical rows. Existing clients remain compatible. Rolling back application code does not require deleting the new column or document copies.

Automated booking/check-in notifications and WhatsApp configuration are not changed. This work does not implement the separately discussed WhatsApp inbox.

The release security gate also requires Vite 8.3.3, Vitest 4.1.12 and Next.js 16.4.1. GitHub published Next.js advisories on 22 October affecting the previous lockfile. The existing sharp override already supplies the documented image fix, and ResortOS has no Server Actions, but this release takes the patched framework version rather than accepting an advisory exception. Builds, types and all browser workflows are rerun after that update.

## Validation

- Production builds and TypeScript checks passed.
- 446 API tests, 110 web tests, 44 shared tests and 4 launcher tests passed.
- All 22 existing desktop/phone browser workflows passed, including returning-guest autofill while preserving a prior WhatsApp decline.
- The separate operations audit passed all 25 checks.
- Dedicated API tests cover ID-only check-in, historical ID preservation/access, returning-guest reuse, changed-identity rejection, duplicate phone safety, exact paise allocation, payment idempotency/rollback, stale dates, booking conflicts and scheduled maintenance.
- Manual local-browser inspection covered the extension entry point, payment controls and phone layout. Only isolated synthetic data was used; no live guest bookings or messages were created.
- Dependency security gate passed after the Vite/Vitest development patches.

Railway authentication was renewed during release preparation. Before production activation, verify the tested commit and a rollback backup; afterwards verify migration 0031, both properties’ optional-photo policy, public health and preservation of existing operational records. No real guest bookings or messages should be generated as release tests.
