# Testing

All tests that touch data run against **real PostgreSQL 16** (`resortos_test`, rebuilt from migrations and the demo seed before each run). There are no database mocks, because the guarantees under test (exclusion constraints, triggers, row locks, grants, transactions) only exist in the database.

| Command | What runs |
|---|---|
| `pnpm test` | shared unit tests · API integration tests · web design-token contrast tests |
| `pnpm e2e` | builds everything, starts the built API + web against `resortos_test`, runs Playwright (desktop + phone viewport) |
| `pnpm verify` | build + typecheck + `pnpm test` |
| `pnpm audit` | dependency advisories; high and critical fail CI unless accepted with an expiry (`docs/dependency-security.md`) |

Storage tests use plain-HTTP MinIO on `localhost:9000`, as CI does. With the LAN phone-testing setup
running (MinIO on HTTPS), point them at it instead:
`TEST_S3_ENDPOINT=https://localhost:9000 NODE_EXTRA_CA_CERTS="$HOME/Library/Application Support/mkcert/rootCA.pem" pnpm test` (same for `pnpm e2e`).

## Critical guarantees and where they are proven

| Guarantee | Test |
|---|---|
| Double booking impossible (concurrent requests, capacity race, raw SQL bypass) | `apps/api/test/reservations.test.ts` |
| Idempotency: double-click creates one record | `apps/api/test/reservations.test.ts` |
| Permissions: roles, forced password change, logout | `apps/api/test/auth.test.ts` |
| Owner PIN: single use, 2-minute expiry, bound to values, other staff, concurrency, lock + unlock | `apps/api/test/owner-authorisation.test.ts` |
| Lockout abuse: attacker network, known device, network-wide, distributed, recovery | `apps/api/test/login-protection.test.ts` |
| Purpose of visit lives on the booking, not the guest; the database refuses one off the list | `apps/api/test/guests-and-lists.test.ts` |
| Guest search finds by vehicle number, however it is typed, as well as mobile, name and booking | `apps/api/test/guests-and-lists.test.ts` |
| Guest profile carries stays, upcoming bookings, vehicles and documents, and never the image itself | `apps/api/test/guests-and-lists.test.ts` |
| A receptionist sees documents of a current stay only; older ones are owner-only in the list *and* behind the signed URL | `apps/api/test/guests-and-lists.test.ts` |
| In-house list defaults to now, filters by status and date range, and a straddling stay still matches | `apps/api/test/guests-and-lists.test.ts` |
| Global search (Ctrl+K) finds guests, bookings, rooms and vehicles, and needs a session | `apps/api/test/guests-and-lists.test.ts` |
| Outbox: a failing handler retries with backoff, succeeds later, and is delivered exactly once | `apps/api/test/outbox.test.ts` |
| Outbox: gives up after 10 attempts, keeps the event forever, never retries it again | `apps/api/test/outbox.test.ts` |
| Outbox: a handler that dies mid-flight leaves the event to be retried, not lost | `apps/api/test/outbox.test.ts` |
| Outbox: three workers draining at once never run the same event twice | `apps/api/test/outbox.test.ts` |
| Outbox: the API role cannot delete an event; an event cannot be both dispatched and dead | `apps/api/test/outbox.test.ts` |
| Job queue starts as the least-privileged API role against a migrator-owned schema, and drains a real event | `apps/api/test/jobs-runtime.test.ts` |
| Throttling holds when the API clock drifts from the database clock (a fast app clock must not switch it off) | `apps/api/test/login-protection.test.ts` |
| Audit tamper detection; app role cannot rewrite history | `apps/api/test/reservations.test.ts` |
| Audit chain does not fork under 60 parallel actions | `apps/api/test/audit-concurrency.test.ts` |
| Night audit refuses to close a day with an arrival or departure unresolved, and records the refusal | `apps/api/test/night-audit.test.ts` |
| Six simultaneous completions close the date once and move the business date exactly one day, with no request refused as busy | `apps/api/test/night-audit.test.ts` |
| The database itself refuses a second run for the same business date | `apps/api/test/night-audit.test.ts` |
| Replaying every audit step against a closed date posts nothing twice (the contract 2.2's room-night posting must meet) | `apps/api/test/night-audit.test.ts` |
| A completed run cannot be edited or deleted, and the business date cannot move backwards | `apps/api/test/night-audit.test.ts` |
| A receptionist cannot complete the audit once the owner turns the setting off | `apps/api/test/night-audit.test.ts` |
| No-show is recorded separately from cancellation, frees the room, and is refused before the arrival date | `apps/api/test/night-audit.test.ts` |
| Extending a stay prices the new nights and is refused when the room is already sold | `apps/api/test/night-audit.test.ts` |
| The night audit screen shows every step and never offers a button the server would refuse | `tests/e2e/night-audit.spec.ts` |
| A bill opens once per stay, even with three requests racing for it | `apps/api/test/folio.test.ts` |
| A charge stores the name exactly as typed, and its GST comes from the type and date, never from the receptionist | `apps/api/test/folio.test.ts` |
| A bill line can never be edited or deleted in the database — only voided, once, with a reason | `apps/api/test/folio.test.ts` |
| A voided line stays on the bill, shows who removed it and why, and stops counting | `apps/api/test/folio.test.ts` |
| Night audit posts room, meal and extra-person as separate lines (their GST differs) at the agreed rate | `apps/api/test/folio.test.ts` |
| Replaying the posting step against a closed date posts nothing twice | `apps/api/test/folio.test.ts` |
| A day night audit has closed refuses new charges, and voiding on it needs Owner PIN | `apps/api/test/folio.test.ts` |
| Saved charge items are owner-only and are deactivated, never deleted | `apps/api/test/folio.test.ts` |
| Adding and removing a charge on the stay screen, with the removed line kept and the reason shown | `tests/e2e/check-in.spec.ts` |
| Money lands in the right kind of account — refused by the API and again by the database | `apps/api/test/payments.test.ts` |
| A payment is never edited or deleted; a reversal is a new row, at most once, and never of a reversal | `apps/api/test/payments.test.ts` |
| A refund needs Owner PIN and takes money out; a reversal on a closed day needs the owner and is dated today | `apps/api/test/payments.test.ts` |
| An advance taken before arrival counts on the stay's bill without the payment row changing | `apps/api/test/payments.test.ts` |
| A cancelled booking's advance must be decided; "keep as credit" writes guest credit; a refund after cancelling needs the owner | `apps/api/test/payments.test.ts` |
| A security deposit is held, not paid; it must be fully accounted for; an unusual split needs the owner | `apps/api/test/payments.test.ts` |
| Guest credit can be spent only up to what the guest has, and a reversal gives it back | `apps/api/test/payments.test.ts` |
| Cash without an open shift, or into someone else's shift, is refused by the database | `apps/api/test/payments.test.ts` |
| Shift close: expected = opening + cash taken; reason above the threshold; closed shift locked; one open shift per person under concurrency | `apps/api/test/payments.test.ts` |
| Nightly integrity check reports a payment on the wrong booking and repairs nothing | `apps/api/test/payments.test.ts` |
| GST slab follows the discount: ₹8,000 night at 18%, ₹1,000 off → 5%, shown in the preview first | `apps/api/test/discounts.test.ts` |
| ₹7,500.00 is 5% and ₹7,500.01 is 18%; one paisa off moves it back | `apps/api/test/discounts.test.ts` |
| Receptionist discount limit enforced on the server; Owner PIN approves exactly the amounts asked | `apps/api/test/discounts.test.ts` |
| A bill discount is spread to the paisa and removed as one; a discounted charge cannot be removed alone | `apps/api/test/discounts.test.ts` |
| The database refuses a discount bigger than its charge, a discount of a discount, and any edit | `apps/api/test/discounts.test.ts` |
| Checkout refuses while money is owed or a deposit is held; pending balance needs the owner | `apps/api/test/invoices.test.ts` |
| Mixed-rate invoice INV/26-27/00001 adds up and closes the bill | `apps/api/test/invoices.test.ts` |
| Bills finalized at the same moment get consecutive numbers — no gap, no duplicate | `apps/api/test/invoices.test.ts` |
| A rolled-back finalization gives its number back | `apps/api/test/invoices.test.ts` |
| An issued invoice refuses update, delete, a line added later, and voiding a charge on it; totals that disagree do not commit | `apps/api/test/invoices.test.ts` |
| A full credit note equals the original to the paisa; partial credit at the original rate, never beyond what was sold | `apps/api/test/invoices.test.ts` |
| Late charges: owner only, on a debit note; the invoice is untouched | `apps/api/test/invoices.test.ts` |
| No GSTIN → bill of supply with no tax; a mid-stay rate change applies per night | `apps/api/test/invoices.test.ts` |
| Invoice, receipt and shift report PDFs are byte-for-byte reproducible, on A4 and 80 mm | `apps/api/test/invoices.test.ts` |
| Owner review list: owner only, derived from records, Seen is kept and hides the item | `apps/api/test/invoices.test.ts` |
| Company accounts: GSTIN checked, invoice in the company's name, credit limit on Owner PIN, oldest-first ageing, receipts in the account ledger | `apps/api/test/receivables.test.ts` |
| OTA terms only on OTA bookings; payouts into a bank; receivables show pending and missing terms; availability changed today | `apps/api/test/receivables.test.ts` |
| A stay with food and an activity, paid card + UPI, checks out with a tax invoice and a printable PDF | `tests/e2e/billing.spec.ts` |
| A guest message is queued once per cause however often its event is delivered, and sent once | `apps/api/test/messaging.test.ts` |
| No guest mobile, address or unlisted variable can reach a message; a template using one is refused | `apps/api/test/messaging.test.ts` |
| A message that cannot go is recorded as skipped with the reason (no email, email off) | `apps/api/test/messaging.test.ts` |
| Provider hiccups retry with backoff; a rejection fails with the reason; Resend is a new row; a sent message is never rewritten | `apps/api/test/messaging.test.ts` |
| A provider that always fails never touches the booking | `apps/api/test/messaging.test.ts` |
| Resend webhooks: signed and fresh only, status only moves forward, every report kept | `apps/api/test/messaging.test.ts` |
| Checkout reminders go once per stay after the reminder time; a same-afternoon one-nighter is skipped; quiet hours by the database clock | `apps/api/test/messaging.test.ts` |
| Receipts carry the PDF; Hindi guests get Hindi; the owner's wording replaces the built-in | `apps/api/test/messaging.test.ts` |
| Staff PIN: password to set, no easy PINs; shared desk is the owner's to mark; PIN only after today's password login; five wrong PINs lock; lock and revoke end sessions | `apps/api/test/desk.test.ts` |
| Owner policies versioned and audited; one default rate plan; tax rules added, closed, never reopened; receptionist limit used by the server | `apps/api/test/settings.test.ts` |
| Express check-in creates the walk-in booking and opens the whole check-in on one page | `tests/e2e/sprint-b.spec.ts` |
| Settings: owner saves a policy; a receptionist sees only their own PIN | `tests/e2e/sprint-b.spec.ts` |
| Shared desk: lock, then switch in by PIN | `tests/e2e/sprint-b.spec.ts` |
| Edit / rebook use the same validation, limits and audit | `apps/api/test/booking-changes.test.ts` |
| No SQL interpolation; demo data blocked from production | `apps/api/test/guards.test.ts` |
| A backup really restores: dump → encrypt → upload → download → decrypt → hash check → restore → integrity checks | `apps/api/test/backup-restore.test.ts` |
| A backup under Object Lock cannot be destroyed, and a plain delete only hides it (why the write credentials must also deny DeleteObject) | `apps/api/test/backup-restore.test.ts` |
| A backup is unreadable without the offline key, and one flipped byte is caught rather than restored | `apps/api/test/backup-restore.test.ts` |
| No read fans out with `Promise.all` over a `Queryable`, and `gather()` really does serialise on a transaction client | `apps/api/test/guards.test.ts` |
| The overridden `multer` stays patched and keeps the API and error messages Nest maps to HTTP statuses | `apps/api/test/dependency-pins.test.ts` |
| Phone scanner: single-use QR, 10-minute expiry, upload-only, no guest data to phone, device secret | `apps/api/test/check-in.test.ts` |
| Document counts only after server re-hash (SHA-256 + size); tampered/expired/overwrite links refused | `apps/api/test/check-in.test.ts` |
| Check-in blocked while documents are uploading/failed/missing; draft survives refresh; double confirm → one stay | `apps/api/test/check-in.test.ts` |
| Room shift uses the exclusion constraint; checkout pipeline order; checked-out stay immutable | `apps/api/test/check-in.test.ts` |
| Registration card PDF is byte-for-byte reproducible, so the stored SHA-256 is a real check | `apps/api/test/grc.test.ts` |
| Registration card font is pinned by checksum (changing it would change every stored hash) | `apps/api/test/grc.test.ts` |
| A card is recorded only after the stored file is re-read and re-hashed; a mismatch leaves no row and no number gap | `apps/api/test/grc.test.ts` |
| All three signature routes (desk touchscreen, phone session, scanned paper) are recorded correctly | `apps/api/test/grc.test.ts` |
| A reprint returns the stored card; regenerating creates a linked new version and overwrites nothing | `apps/api/test/grc.test.ts` |
| A registration card is never edited or deleted in the database | `apps/api/test/grc.test.ts` |
| WCAG AA contrast of every text/surface token pair, both themes | `apps/web/test/contrast.test.ts` |
| Desk check-in end to end: draft survives refresh, desk uploads through editor, phone scanner (no guest data), offline capture → reload → resume, live arrival on desk, signature, confirm | `tests/e2e/check-in.spec.ts` |
| The whole stay end to end: check-in → registration card created from the signature and served as a real PDF whose hash matches the screen → room change with reason kept on the stay → checkout → room left dirty and vacant | `tests/e2e/check-in.spec.ts` |
| Storage enforces type, size, SHA-256 and write-once on pre-signed uploads (MinIO in CI) | `apps/api/test/check-in.test.ts` |
| Retried document creation returns the same document | `apps/api/test/check-in.test.ts` |
| Losing the network mid-upload cuts the request short instead of wedging the queue, and resumes without waiting out a backoff | `tests/e2e/check-in.spec.ts` |
| DD/MM/YYYY picker, Owner PIN by keyboard, override shown, edit, rebook | `tests/e2e/front-desk.spec.ts` |

## Where concurrency tests live

`tests/concurrency/` from spec §87 is **not** a separate suite. Concurrency guarantees are proven
inside the API integration tests, because they need the same fixtures, the same app instance and the
same real database: two overlapping bookings and double-click idempotency in
`reservations.test.ts`, the audit chain under 60 parallel actions in `audit-concurrency.test.ts`,
double confirm in `check-in.test.ts`, double card generation in `grc.test.ts`, and six simultaneous
night audits in `night-audit.test.ts`. Parallel invoice finalisation joins them in 2.6.

**`night-audit.test.ts` runs on a database of its own** (`bootAppOnOwnDatabase`), because completing
an audit moves the business date and every other suite asserts the seeded 2026-09-16. A separate
database is cheaper, and far more honest, than closing a day and then disabling the triggers that
protect the date in order to put it back.

**The harness binds a real port.** `bootApp()` calls `app.listen(0)`, not just `app.init()`. Given a
server that is not listening, supertest binds one lazily on the first request it sends — so a burst
fired in a single tick has every request in that burst find no address and call `listen(0)` itself,
and the later sockets are reset. The symptom is `read ECONNRESET` on requests the app never saw,
which looks exactly like the application dropping connections under load. Binding once up front
makes a burst behave like real traffic, and it took the 60-action audit-chain test from ten seconds
and intermittently failing to well under one second and stable.

## Not automated (needs real devices)

Camera capture and the phone scanner (milestone 1.8) must be tested manually on a real iPhone (Safari) and a real budget Android phone (Chrome), including an upload that drops and resumes on a weak network. Procedure and result table: `docs/phone-testing.md`.
