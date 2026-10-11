# ResortOS handover QA — 11 October 2026

## Decision

The automated booking, check-in, checkout and financial workflows pass. The receptionist-facing notification and recovery fixes described below are included in this release. Resort acceptance still needs the short on-site checklist below; browser emulation cannot certify real cameras or printers, and a local restore test cannot certify Railway recovery.

Production: https://pms.voittoventures.com. Reception guide: [hotel-handover.md](../../hotel-handover.md).

## Issues fixed

1. A lost save response previously claimed nothing had been saved. A POST can commit before its response is lost. The error now asks reception to refresh/check the record before retrying. HTML gateway errors are translated into useful messages rather than raw JSON parse errors.
2. Message controls dominated the status display. The panel now leads with separate Email/WhatsApp delivery states, polls pending sends, distinguishes loading from an empty history, and collapses occasional send/preference actions. WhatsApp has its own icon.
3. Delivery problems were only visible inside a booking. Home now links to the latest failed/bounced/complained messages for the property's owner and receptionists. Successful replacement attempts clear the old failure from this alert; every attempt remains in history. Different invoices/payments are kept separate. Test sends and intentional opt-outs do not generate the global alert.
4. A resend retry could reuse another message's request key after a connection failure. Keys now belong to the specific message. Resending an already sent or uncertain message asks for confirmation.
5. Owner recovery existed only as an API. Settings → Owner recovery now confirms the password, generates/downloads a new private code set, and lets the owner hide it. The login screen has a recovery form. Rejected codes remain on that form rather than redirecting away. Codes are not kept in the query cache.
6. The live Resend signing secret was missing. The Resend delivery webhook was created for sent/delivered/opened/bounced/complained events and its secret saved privately in Railway. The release must be deployed before the new process uses this secret.
7. The handover guide used the old Railway address and messaging documentation excluded automatic walk-in confirmations. Both are corrected.

## Test evidence

Tests use disposable local PostgreSQL 16 and private MinIO buckets, synthetic guests and development message providers. Production bookings, guests, payments, consent, passwords and tax rates were not edited by these tests. No new message was sent to a real guest.

| Check | Result |
|---|---|
| Build and TypeScript | PASS on final source |
| Shared, web and API unit/integration checks | 517 checks: 41 shared, 105 web, 371 API; plus 4 process startup checks |
| Operational financial regression checks | 25 PASS |
| Desktop/phone browser workflow suite | 20 PASS; full stay and billing flows included |
| Dependency gate | 493 dependencies; no unaccepted high/critical advisory |
| Browser exploration | PASS for the scenarios below |
| GitHub protected release checks | Recorded in the release PR; required checks must pass before merge |

Coverage includes booking/save/opt-out, edit/cancel/rebook, DD/MM/YYYY inputs, reception today versus independent day closing, PIN switching/locking, optional signature and picture upload, face/ID retakes, document receipt and registration PDF, room change, extra charges, split card/UPI payment, advances/deposits/refunds/reversals, checkout posting elapsed room nights, invoice generation and dirty-room housekeeping. API suites also cover permissions, audit integrity, duplicate requests, delivery retries/signatures and document/storage validation. This is evidence of the tested paths, not a promise that every possible browser/device/provider condition is bug-free.

Browser exploration used Chromium at 390 × 844 and desktop sizes. Controlled message responses exercised Home's failure link and the Email Failed / WhatsApp Read panel, collapsed optional controls and resend confirmation; no horizontal page overflow was found. Backend integration checks independently exercised a real failed message and successful resend, property filtering, authentication and removal of the obsolete alert. Synthetic owner recovery generated ten codes, downloaded/hidden them, reset the local owner password, rejected reuse of a consumed code, and returned 401 for the old session. Invalid recovery codes stayed on the form with an explanatory error.

Existing E2E scanner checks use synthetic file inputs and browser emulation, including restricted browser storage and iPhone-sized layouts. They do not exercise a physical iPhone's Safari camera, HEIC conversion, focus or hotel network.

## Live checks

- Production uses a live property, Asia/Kolkata, no practice mode/demo staff, and an active owner and receptionist account.
- Reception today is 11 October 2026. Accounting/day closing remains 6 October; reception does not have to change its booking date to match that older accounting day.
- Jobs are enabled and both email/WhatsApp credentials are configured. WhatsApp is enabled with five template bindings.
- The previously authorized production test has genuine Meta sent/delivered/read callbacks. Live delivery rows showed email sent/skipped and WhatsApp read/skipped, with no failed rows at inspection. Historical email sent status is acceptance evidence, not proof of inbox delivery.
- The audit chain passed (247 entries at initial inspection).
- Railway object storage allows PUT from the exact custom PMS origin and has no wildcard origin. A fresh browser on the real public privacy page uploaded a unique synthetic PNG with the same signed checksum/size headers used by the scanner. Upload returned 200; server-side HEAD matched size/checksum; unsigned access returned 403. The synthetic file was then removed. No guest file was read or overwritten.
- Bucket versioning reported not enabled; no production database restore or document recovery drill was performed. Local encrypted restore/Object Lock checks passed against MinIO only.
- One configured accommodation GST rule exists at 5%; no food rule was present. This report does not validate tax percentages or supply legal/accounting approval.
- No unused owner recovery codes existed at inspection. The owner needs to generate their own private set using the new screen; QA did not generate production recovery codes or retain them.
- Google Sheets is not connected, as requested for later setup.

Resend webhook setup follows its [official API documentation](https://resend.com/docs/api-reference/webhooks/create-webhook). Configuration and signature validation do not substitute for observing a future genuine provider delivery event.

## Resort acceptance before the first real shift

1. Owner signs in, downloads/hides private recovery codes, confirms reception can sign in with its own account, and shows reception how to lock/switch the shared desk.
2. Accountant confirms accommodation/food/extra-charge GST treatment. Save the approved dated rules; do not assume the current 5% accommodation setting is accountant approval. Verify rooms/prices/payment accounts and print one invoice/receipt on the resort printer.
3. Test the actual reception computer, one Android and one iPhone on hotel Wi-Fi/mobile data: QR → face/front/back → retake → Received → open/download at the desk. Also exercise a photo signature and a check-in without signature.
4. Close the outstanding accounting days in order after reviewing arrivals, payments and shifts. Do not overwrite the day-closing date just to make it look current.
5. Confirm Railway billing and database recovery controls, and record a recovery test before relying on recovery. Excel exports are useful operational downloads but are not a database/photo restore. No additional backup vendor is required by this user's requested scope.

Optional later work: create/connect the private Google Sheet. Meta approval for new message wording is external; the previously approved binding remains usable until its formatted replacement is approved and activated.

## Release verification

Final commit, PR, deployment and live callback checks are appended after the protected release completes. Any remaining external approval/setup is stated explicitly rather than marked complete from local tests.
