# ResortOS implementation progress — 6 October 2026

Work continues in **resortos zcode** on `codex/reliability-and-configurable-operations`. The original resortos folder is preserved. Commit `34f2605` preserves the prior uncommitted implementation and the initial audit. `MARKET_READINESS.md` and its original evidence remain a historical snapshot, rather than being rewritten to pretend those failures never occurred.

This pass fixes the reproduced operational failures and prepares a configurable Resend setup. It does **not** certify a production deployment or complete every feature in the master specification.

## Changes and verification

| Initial finding | Result of this pass |
|---|---|
| A1: accommodation omitted at checkout | Checkout completes missing applicable agreed room/extra-person/meal charges before settlement. Same-day checkout charges at least one night; unused future nights and dates before actual check-in are excluded. Repeated previews do not duplicate charges. Closed-day inconsistencies stop checkout for reconciliation. The dialog waits for the complete bill before claiming readiness. |
| A2: daily figures | Collections use signed cash movements, including returned deposits and reversals. Revenue excludes voided charges and discounts attached to voided charges. Money totals use Decimal. |
| A3: preventive room schedule | Generated room tickets no longer also receive an area. A due schedule can run without violating the room/area rule. |
| A4: correction exports | Expenses export reversal signs correctly. Payment records distinguish nominal amount, signed cash movement and bill settlement, and identify reversal rows. |
| A5: GST rounding | Export uses the immutable invoice tax-group totals, supports configured rates, and separates credit/debit notes correctly. This remains an accountant summary, not a certified GST portal upload file. |
| A6: Tally | Correct date format and signed debit/credit amounts; separate taxable, tax and round-off ledgers; notes/refunds/deposits; stable voucher identities. A later-period reversal does not erase an earlier-period receipt. Voucher totals are checked for balance. Full accountant package and actual Tally acceptance remain pending. |
| A7/A8: maintenance reliability | Ticket/schedule creates and edits use idempotency keys. Schedule room edits persist. Only active same-property rooms/staff can be referenced. A forward migration enforces property boundaries on staff references. Changes produce audit/outbox records. |
| A9/A10: register printing | Arrival uses the property timezone. Multi-page PDFs restart the row position and repeat column headers. The 100-row regression now produces four pages; page 2 was visually inspected. Additional export timestamps use the property timezone. |
| A11: records | Booking and stay exports apply the selected date range. Record-page tables/search/drill-down remain a separate unfinished feature. |
| A12: phone navigation | Full role-aware menu reaches operational modules. Cleaner navigation excludes booking actions. Long dashboard rows fit the phone width; long dialogs scroll within the viewport. |
| S1: dependency gate | Next.js 16.3.6 and source-map-js 1.2.2 address the critical/high findings. The high/critical gate passes. One moderate Multer finding remains on an unused API multipart path; the compatibility reason is recorded in `docs/dependency-security.md`. |
| S2: CI storage | Public MinIO image pulls no longer work. CI/development now build pinned upstream MinIO/mc source commits. Both images built locally; a separate temporary server passed readiness and private/versioned/Object Lock bucket creation. Existing local storage was not replaced. GitHub CI must confirm the Linux runner path. |
| S3/S4: operations | Restore comparison now includes financial/message/maintenance counts and financial totals. First-owner provisioning creates only live identity records in an empty migrated database, hashes credentials, writes audit/outbox, and handles concurrent attempts safely. The production guard and normal owner login were tested on that new database. |

Operational regression results and observations are in `progress-evidence/`. The original failed audit evidence remains in `evidence/`.

## Configuration stays simple

Owners can change room types/base/minimum/extra-person rates, dated rates, meals, charge items, tax rules and payment accounts through Settings. Receptionists can agree booking rates within their limits; a below-floor rate requires owner approval. A later settings change does not rewrite the price already agreed with a guest or the tax snapshot on an issued invoice. No production room inventory, room prices or tax rates are inserted by the new provisioning command.

Guest messages now has one sender setup panel: name, sender address, reply address, email on/off and daily-summary recipients. It shows whether the server uses Resend, practice mode or no provider, whether jobs run, and whether delivery webhooks are configured. Keys are never returned to the browser.

Tests report “queued” or “recorded in practice mode”, not “delivered”. Real Resend success is not claimed from the local tests. The HTTP adapter was tested with a local server for request fields, PDF attachments, deduplication keys and error classifications. Database integration covers signed delivery webhooks, retries, frozen payloads when sender settings change, and manual-send replay. Stalled sends beyond the provider's deduplication window are held for delivery reconciliation. Email failure does not roll back a reservation or bill.

See `ops/runbooks/provision.md` for empty-database setup. The owner's recovery codes should be generated after the first login.

## Remaining before real launch

1. **Actual infrastructure and Gate 0:** deploy the production database/private document store, establish PITR, a second region and locked encrypted backup copies at a different provider, configure alerts/scheduling, and record a real restore drill. Local MinIO restore tests do not replace this.
2. **Resend:** provide and verify the sending domain, configure sending-only API credentials and the signed webhook on the server, test English/Hindi messages to a real test inbox, then enable guest email. The user selected Resend; the sending domain is still pending.
3. **Accountant acceptance:** configure dated tax rules/SACs from the property's CA, review invoice/credit/debit-note samples, complete the required documents-issued/SAC summaries and broader accounting export coverage, and import/re-import a sample in the resort's actual Tally company. XML structure and balanced amounts are necessary but insufficient evidence of acceptance.
4. **Production security and privacy:** owner recovery drill, optional TOTP/owner email recovery, actual proxy/HTTPS/header/session validation, external VAPT, and completed consent history/data-request/retention/guest-flag workflows with a confirmed retention policy. Provisioning and a check-in consent field alone do not complete these requirements.
5. **Front-desk acceptance:** real-device camera/HEIC/permission and weak-network checks, printer validation, long-running concurrent reception sessions, and complete group/split-bill scenarios using the property's operating rules.

The larger specification still includes guest merge and import reconciliation, searchable record tables, owner Data Safety screens/operator notifications, Google one-way Sheets/Drive archives, installable PWA/offline refresh behaviour, and revenue-intelligence reporting. WhatsApp/SMS and AI require separate provider/scope decisions. These remain unfinished and should not be advertised as delivered features. Core booking/check-in/billing/email reliability is the focus of this commit; more features must not be mistaken for release approval.


## Validation completed locally

- Production build and workspace type checks passed.
- Full suite: **445 tests passed** (306 API, 41 shared, 98 web/contrast).
- Operational audit regressions: **25 passed**, including completed checkout, elapsed/late-arrival billing, property separation, accounting reversals and the 100-row register.
- Browser journeys: **14 passed**, desktop and mobile. Covers document capture, signature/GRC, room move, checkout, owner overrides, shared-desk switching, sender settings and navigation with populated dashboard data.
- After the final queue-wakeup change, the API build and **23 messaging/daily-summary tests** passed again.
- Dependency high/critical gate passed; the one moderate compatibility finding is documented.
- Gitleaks passed across existing Git history and the staged changes.
- Both pinned storage images built and their readiness/bucket setup passed on a separate disposable local container.

CI is required on the pushed branch. Local checks are evidence for the covered paths, not proof of real email delivery, actual Tally import, off-site production recovery or external VAPT.
