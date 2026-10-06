# ResortOS market-readiness audit — 6 October 2026

## Decision

Continue in **`/Users/anshmaansingh/aachho/resortos zcode`**. Keep the original `resortos` folder as a reference. Both copies start from commit `2585b76` on `sprint-c`; the continued copy includes additional maintenance, compliance, records/export, daily-summary and web work. Rebuilding from the original would discard useful progress without removing the underlying billing defects.

**The current application is a substantial working foundation, but it is not ready for real guest operations or a commercial release.** The existing tests pass while targeted launch checks expose missing room charges, incorrect financial reports, an audit-blocking maintenance path and incomplete release operations. Completion marks in `docs/PHASES.md` mean implementation exists; they do not establish market readiness.

This audit added tests and evidence, not production fixes. Existing uncommitted work was preserved. Nothing was deployed, committed, pushed or merged. GitHub authentication and repository access work; the newer local additions are not yet a published, reviewed release.

## What was verified

Testing used fake data in local PostgreSQL 16 and MinIO. The standard suite uses `resortos_test`; the new audit suite creates and rebuilds only `resortos_marketaudit_test`. It does not reset the development database. Some audit fixtures prepare confirmed stays with SQL, following the existing integration-test pattern; the actual operation being checked uses the real services/API and database. These billing probes do not replace a complete document-capture journey.

| Check | Observed result | Evidence / limitation |
|---|---|---|
| Production builds and TypeScript checks | Passed | `evidence/verify.log` |
| Existing unit/integration suite | **432 passed**, 33 files | Shared 41, web 98, API 293. Includes booking races, permissions, audit-chain concurrency, payment idempotency, invoice immutability, night audit, capture and backup/restore. |
| Existing browser suite | **10 passed, 1 failed**, 11 total | `evidence/e2e.log`. Express check-in timed out selecting a room type. |
| Isolated express-check-in rerun | **1 passed** | `evidence/express-rerun.log`. Test reads availability buttons before asynchronous results are necessarily present; likely a test race, not a confirmed express-check-in product failure. |
| New launch audit suite | **4 passed, 19 failed**, 23 total | `evidence/probes.json` and `probe-observations.json`. Failures express unmet launch requirements, including two date-filter feature gaps. They are not 19 independent root causes. |
| Local concurrency smoke test | **50/50 HTTP 200**, p95 **58 ms** | One authenticated session, 25 maintenance reads and 25 audited payment CSV downloads, local database, small dataset. Not a 50-user/200-room capacity certification. |
| Secret scan | Passed | Gitleaks v8.24.3 scanned 78 commits and 360 current source/config files, with the repository's configured allowlist. Ignored environment files, local archives `.cloud-sync.tgz`/`.t1`, dependencies and generated artifacts were outside the worktree source scan. |
| Dependency release gate | **Failed** | Critical Next.js and high source-map-js advisories; moderate multer advisory also reported. `evidence/security-gate.log`. |
| GitHub CI | **Failed before application checks** | Pinned MinIO image pull was rejected as unauthorized, exit 125. [Run and logs](https://github.com/Anshmaan29/resortos/actions/runs/36356105452). |
| Browser inspection | Owner home, maintenance forms, records, expenses, housekeeping, Form C render | Desktop and phone-sized navigation inspected through the browser. This was exploratory inspection, not an automated full role/device matrix. |
| Multi-page printing | **Failed** | 100 synthetic register rows create **73 pages**. PDF text contains all 100 names, but page 2 visually shows one row at the bottom of a nearly empty page. `evidence/police-register-100-rows.pdf` and `police-register-page-2.png`. |

The four passing launch checks are unauthenticated request denial, receptionist denial for owner exports, CSRF-header enforcement and the local request burst.

## Reproduced defects and required fixes

Priority definitions: **P0** blocks real operations because money or closing the business day is unsafe; **P1** must be resolved before the affected feature is released; **P2** is a completion or usability requirement. Priority is business impact, not a CVSS score.

### A1 — P0: checkout can omit agreed accommodation charges

An arrival-day stay had two agreed ₹2,500 nights. After adding ₹100 food and paying ₹105 including tax, receptionist checkout succeeded and issued a **₹105 invoice with zero accommodation lines**. Room nights are posted by night audit; checkout's settlement and invoice steps do not first ensure that applicable room/extra-person/meal charges exist. A guest can leave before that posting occurs.

Code: `apps/api/src/folios/checkout.steps.ts`, especially settlement at line 40 and invoice finalization at line 90; room posting in the night-audit pipeline. Observation: `unposted_room_checkout`.

Required: define day-use, early-departure and late-checkout charging policy; post all applicable agreed charges transactionally and idempotently **before** settlement and invoice calculation. Block checkout if charging cannot be established. Do not blindly bill every future reserved night.

Acceptance: same-day departure, normal departure before audit, extended stay and room change all reconcile agreed nights, posted charges, tax, payments and final invoice. Replaying checkout or night audit must not duplicate charges. Include a real browser check-in through checkout, not only SQL-prepared stays.

### A2 — P0: the owner's daily figures misstate collections and revenue

Three independent reproductions against the real reporting query:

| Operation | Expected change | Actual change |
|---|---:|---:|
| Receive ₹500 security deposit, return ₹500 | ₹0 net collections | **+₹1,000** |
| Receive ₹123 payment, reverse it | ₹0 net collections | **+₹123** |
| Add ₹300 food charge, void it | ₹0 food revenue | **+₹300** |

Code: `apps/api/src/messaging/daily-summary.handler.ts`, collection SQL and `moneyLine()` queries. Deposit refunds have the wrong sign; excluding reversal rows leaves reversed originals counted; revenue queries do not exclude voided lines. Room revenue also needs review against discounts and corrections.

Required: compute reports from one agreed ledger definition using Decimal/SQL NUMERIC, with explicit treatment of receipts, refunds, deposits, deposit applications, reversals, voids, discounts, credit/debit notes and company/OTA receipts. Reconcile summary, accounts, shift report and exports for the same business date. Test the actual sent summary and its configured recipients as well as its arithmetic.

### A3 — P0: a due preventive room schedule can fail night audit

The registered maintenance step rejects a valid due room schedule with `maintenance_tickets_target`. `openDueSchedules()` inserts both `room_id` and `area = schedule.name`; the database requires one target, not both. The audit transaction would roll back when this registered step reaches such a schedule. The probe invoked that step in a real transaction rather than driving the complete audit UI.

Code: `apps/api/src/maintenance/maintenance.service.ts:186`, specifically values at line 202; `db/migrations/0022_maintenance.sql`; maintenance's night-audit step registration.

Required: create the correct room-or-area target. Add a complete night-audit test with due room and area schedules, multiple schedules, retry, already-open service work and failure recovery. Preserve the XOR constraint and applied migration checksum.

### A4 — P1: expense and payment exports misrepresent reversals

Correcting an expense from ₹450 to ₹550 yields three positive CSV rows summing to **₹1,450**. Payment reversals are not marked by the intended `(reversed)` indicator. Queries return PostgreSQL booleans, but the mapper compares them to the string `'true'`. Expense reversal rows also need a clear signed/net representation; changing the boolean comparison alone does not establish correct net accounting.

Code: `apps/api/src/exports/exports.service.ts`, `payments()` and `expenses()`. The same boolean pattern exists for guest VIP output and should be corrected with proper row types.

Required: exports must clearly distinguish original, reversed and reversal entries and reconcile to the account ledger. Test CSV and XLSX corrections, reversals, refunds, deposit transactions and mixed dates. Never make a consumer infer a reversal solely from free-text notes.

### A5 — P1: GSTR tax totals do not reconcile with issued invoices

Two ₹100.10 food lines demonstrate the rounding issue. Across the test period, issued invoice CGST totals are **₹7.51**, while the GSTR export reports **₹7.50**. The export recalculates tax per line; invoice calculation rounds grouped tax. SGST has the corresponding risk.

Code: `apps/api/src/exports/exports.service.ts:261` (`gstr1()`). Read the issued tax-group amounts and preserve invoice arithmetic instead of recomputing with a different rounding rule.

Additional code-review gaps: B2C aggregation uses rate alone, losing place-of-supply distinctions; a note with a buyer GSTIN is labelled B2B by the current branch; the promised documents-issued block is absent. These need explicit fixtures and accountant review. The current file is an internal summary; portal acceptance was not tested.

Acceptance: invoice ledger = GSTR export for intra/inter-state cases, grouped rounding, tax boundaries, discounts, credit/debit notes, multiple places of supply and financial-year transitions. The resort's CA accepts the exact export format.

### A6 — P1: Tally output is not validated for import and retains reversed receipts

Generated voucher dates are **`16-09-2026`**. Tally's official sample requires **YYYYMMDD**, so this does not meet the documented import format. [Tally documentation](https://help.tallysolutions.com/sample-xml/).

The export also contains a positive receipt for a payment already reversed. Its filter excludes reversal rows but retains the original receipt. The current implementation only exports sales and selected receipts; refunds, notes and expenses do not have complete voucher treatment. Sales post gross invoice totals to a sales ledger without separately mapping tax and round-off ledgers.

Code: `apps/api/src/exports/exports.service.ts`, `tallyXml()`, including `voucherDate()` and receipt selection.

Required: accountant-approved ledger/voucher mapping, correct dates and signs, complete supported transaction coverage and import replay protection. Verify an actual TallyPrime import, its error log and resulting balances. A syntactically valid XML file is insufficient.

### A7 — P1: maintenance retry and edit reliability is incomplete

- Replaying one ticket creation key creates **two tickets**.
- Replaying one schedule creation key creates **two schedules**.
- Updating a schedule's `roomId` returns success but leaves its original room unchanged.
- An inactive staff member can be assigned to a ticket.

Code: `apps/api/src/maintenance/maintenance.controller.ts` and `.service.ts`. Creation does not use `IdempotencyService.run`; `patchSchedule()` omits `roomId` from its accepted service fields and SQL. Assignees lack the active-user check.

Required: idempotency and stale-version behavior on all maintenance mutations, shared schemas, explicit validation, audit/outbox integration as required by the engineering rules, and honest responses when a requested edit is unsupported. Test weak-network retry, duplicate submissions and conflicting owner/staff changes.

### A8 — P1 for a shared commercial service: cross-property maintenance assignment

A ticket for property A accepted a staff UUID belonging to property B with HTTP 201. Listing A's tickets exposed **B's staff name**. This demonstrates a specific property-boundary defect; it does not establish that every module leaks data.

Code: maintenance creation/assignment and joins to `users`; tenant relationships in `0022_maintenance.sql`.

Required: verify every referenced room, user, category and account belongs to the actor's property; use matching database constraints where possible. Add a two-property adversarial suite for reads, writes, exports, document signing, settings, worker events and health/status. A single-hotel installation has a smaller exposure, but multi-hotel market deployment is blocked by this finding.

### A9 — P1: police register arrival date uses UTC

An arrival at **17 September 2026, 00:30 IST** is printed as **16 September 2026**. `toISOString().slice(0, 10)` discards the property's timezone. The fixture intentionally preserves the previous business date to exercise a late-running reception day; physical arrival date and business date are different concepts.

Code: `apps/api/src/compliance/police-register.service.ts`, the `arrival` column. Export timestamps using SQL `to_char()` also need a consistent timezone policy.

Required: render physical timestamps in the property's timezone and use business dates only where the record calls for them. Test before/after midnight, a day not yet audited, and actual versus expected departure dates.

### A10 — P1: police register pagination wastes paper and loses page context

The production renderer produced **73 pages for 100 short four-column rows**. After `addPage()`, `rowTop` and the next `doc.y` still refer to the previous page. Later rows consequently trigger new pages one by one. Column headers are not repeated.

Code: `apps/api/src/exports/exports.service.ts`, `registerPdf()` / `drawRow()`.

Required: reset coordinates on each page, repeat headers, add page/date/property context, and handle long wrapped cells predictably. Acceptance includes 0, 1, 100 and 500 rows, full station columns, long names/addresses, Hindi text and a visual check of every page boundary. The evidence PDF intentionally preserves the defect; it is not a usable final register.

### A11 — P2: date-filtered records are unfinished

Passing a future 2030 range to bookings returned **9 rows**, and to stays **3 rows**, rather than zero. This is an intentional current limitation in the UI, which labels those downloads as all records and does not send a range. It is a **specification completion gap**, not evidence that a visible booking-range control secretly failed.

The Records screen is mostly download cards; only the police register has an on-screen table. The specification's search, per-record drill-down, broadly available tables/PDFs and full portable export remain incomplete. Bookings, guests and Form C bypass `from/to`; define appropriate range semantics for each instead of blindly applying arrival date everywhere. Validate `from <= to` and paginate large downloads/screens.

### A12 — P1 usability: phone/tablet navigation hides operational modules

At phone width, and below the desktop sidebar breakpoint, navigation provides Home, Bookings, New booking, Guests and In house. There is no More/menu route to calendar, housekeeping, Form C, maintenance, shifts, night audit, accounts, expenses, records or settings. The avatar menu contains only password change and logout; search searches business records rather than offering a module directory.

Code: `apps/web/src/components/app-shell.tsx:200`. Add a role-aware mobile menu with reachable operations and owner modules. Verify cleaner navigation separately and all supported widths. Mobile emulation of the scanner alone does not cover a phone receptionist/owner journey.

## Security and release operations

### S1 — P1: dependency release gate is red

Installed Next.js **16.3.5** is within the critical `next/og` ImageResponse advisory; the listed fix is **16.3.6 or later**. No ImageResponse/next-og use was found in the application, so remote execution through ResortOS was **not demonstrated**. Patch and retest rather than treating the audit severity as proof of an exposed exploit. [Next.js advisory](https://github.com/advisories/GHSA-vcvr-r3jv-pc5j).

Installed source-map-js **1.2.1** is within a high denial-of-service advisory; **1.2.2 or later** is patched. It is reached through the build tooling dependency tree. [source-map-js advisory](https://github.com/advisories/GHSA-68fv-2mgg-jv7q).

Multer **2.3.0** has a moderate aborted-upload advisory, fixed from **2.4.0**. There is an intentional pin and Nest compatibility assertion in the repo, so an upgrade needs compatibility work and regression checks. No multipart upload route was found; document uploads use direct object storage. [Multer advisory](https://github.com/advisories/GHSA-3pph-fpjx-jg34).

Do not blindly merge every dependency PR. Update compatible pins, review production exposure, rebuild, run capture/billing regressions and make `node ops/ci/audit.mjs` pass. Existing acceptance records are not a substitute for fixing reachable security defects.

### S2 — P1: GitHub checks stop at storage setup

The reviewed GitHub run fails pulling `quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z` with an unauthorized registry response. Thus that run proves neither build success nor application failure. Local checks passed using the existing healthy MinIO container.

Required: obtain a reliably accessible, pinned storage image, fail readiness polling explicitly, and run the whole pipeline on a clean runner. Update dependencies and storage CI together where needed. Configure branch/release protection only after required checks are reliable.

### S3 — P0 operational gate: real backups and recovery are not established

The local encrypted dump/Object Lock/restore tests passed. That is useful evidence for the mechanism. Every real-provider box and restore-log entry in `docs/production-readiness.md` is still empty:

- Managed PostgreSQL PITR, required retention and a demonstrated PITR restore.
- Provider replication in a second region.
- Encrypted backup in a different provider with Object Lock and write-only/no-delete credentials.
- Recovery keys held outside the primary server/provider.
- Scheduled nightly backup after audit, weekly restore and actionable alerts.
- A recorded restore from the real off-site copy.

`ops/backup/counts.sql` checks core reservation/stay/document/audit counts and rate totals, but omits financial and newer operational table counts/totals. `integrity.sql` checks selected invoice/shift/payment invariants; it does not prove every later module or object-store file survived. Extend verification to folios, payments, accounts, expenses, receivables, notes, tax groups, occupants, compliance, housekeeping and maintenance.

A database dump does not contain ID/GRC object bytes. Establish independent object-store protection and verify restored documents by checksum and actual retrieval. Add an operator runbook for restoring database and documents to a matching point in time. The project's existing rule prohibits real guest data before Gate 0 passes.

### S4 — P1: production provisioning and security operations need implementation

Production rejects demo properties/users/tax rules, which is good. There is no identified supported first-property/first-owner provisioning path for an empty production database; Settings requires an authenticated owner who already has a property. Build a restricted, audited provisioning command/workflow and a production smoke test. Include owner PIN/recovery setup, room/rate/tax/account configuration and no embedded demo credentials.

Owner TOTP is not implemented; a database field alone is not a feature. Email recovery, daily-summary recipient configuration and owner-email management need end-to-end review. Browser CSP/HSTS must be assessed at the actual production proxy: Next config includes framing/content/referrer/permission protections, but not a frontend CSP/HSTS policy. Match the API's trusted proxy configuration to the real deployment and verify secure sessions, domain boundaries, CORS, uploads and logging there. External VAPT remains a release gate.

## Specification work still remaining

| Area | Current foundation | Remaining work |
|---|---|---|
| Booking and guest management | Availability, booking/edit/cancel/rebook, per-night rates, guest directory, search, owner overrides | Guest merge, import validation, full group/split-bill browser scenarios and pricing policy edge cases. Calendar drag is lower priority. |
| Check-in and documents | Drafts, signature, phone QR, verified storage, GRC, room shift | Real-device camera/HEIC/permission/weak-network matrix; all draft expiry/recovery paths; actual front-desk printer validation. |
| Billing and GST | Decimal calculation, folios, payments, invoices/notes, shifts, receivables | A1/A2/A4/A5/A6; complete ledger/report reconciliation and CA approval of dated tax configuration and exports. |
| Housekeeping and maintenance | Boards, task states, assignments, expenses, ticket states | A3/A7/A8; full cleaner role journey and mobile navigation; complete schedule lifecycle testing and failure handling. |
| Compliance and privacy | Form C trigger/details/reference flow, police register, check-in notice/consents | A9/A10; consent history, access/correction/erasure request handling, lawful retention policy and jobs, document restrictions and guest-flags workflow. Form C submission remains manual on the official portal. |
| Owner records | CSV/XLSX, police table/PDF, daily-summary handler | A2/A4–A6/A11; tables/search/drill-down, complete export package, accountant acceptance, report delivery and recipient settings. |
| Safety operations | Backup/restore tooling, integrity SQL, health/outbox status | Real Gate 0; scheduled jobs, operator alerts, owner Data Safety screen, document-store recovery verification and repeatable disaster drills. |
| Google copy/archive | Outbox extension points | One-way Sheets mirror and Drive monthly archives, OAuth setup, retry/replay/backfill, safe-field projections and visible sync status. ID/contact-sensitive data must stay out as required by the spec. |
| Messaging | Email provider interface, templates, queue/retry/webhooks | Verified real sender domain, delivery checks and recipient/consent configuration. WhatsApp/SMS need selected provider and implementation if part of the promised product. Test slow sends, parallel workers and lease expiry. |
| Mobile/PWA | Responsive screens and offline capture queue | A12; installable manifest/service-worker strategy and offline refresh behavior. No application manifest/service-worker implementation was identified. A queued capture in an already-open page is not proof the whole app works offline. |
| Revenue intelligence | Underlying transactional data | Owner revenue/occupancy/ADR/RevPAR metrics, tested aggregation/refresh, trends; optional read-only AI narrative only after arithmetic is reliable. |
| Migration, support and release | Local scripts and runbooks | Old-system import wizard, reconciliation/dry-run, practice environment, training, support diagnostics, deployment/rollback procedure and a recorded hotel pilot. |
| Multi-hotel commercial deployment | `property_id` and role-based access | A8 plus exhaustive tenant tests, provisioning, per-property configuration and operational isolation. Do not infer SaaS readiness from a single demo hotel. |

The final DPDP Rules have staggered commencement, so do not describe every future requirement as already in force on 6 October 2026. Design the privacy workflows now and get the resort's retention/notice obligations reviewed against the actual commencement dates and applicable local requirements. [Official final Rules and commencement text](https://www.meity.gov.in/static/uploads/2025/11/53450e6e5dc0bfa85ebd78686cadad39.pdf).

The demo's 5% lower hotel slab should not be “corrected” to an older remembered rate without checking the current rules. Current official material describes 5% without ITC for accommodation up to the applicable ₹7,500 threshold. Restaurant specified-premises treatment needs property-specific configuration; the CA must approve the production dated rules, SACs and treatment of extra-person/meal charges. [Official accommodation FAQ](https://www.pib.gov.in/Pressreleaseshare.aspx?PRID=2167151&lang=2&reg=48), [CBIC specified-premises notification](https://taxinformation.cbic.gov.in/view-pdf/1010273/ENG/Notifications).

## Order to finish

1. **Make money and day close correct.** Fix A1–A7, preserve the audit trail, and promote meaningful regression cases into normal tests. Reconcile accounts, shifts, invoices, daily messages and exports against one ledger definition. Do not add AI or dashboard decoration before this passes.
2. **Make operations and access reliable.** Fix property validation, dates, pagination and mobile navigation. Complete owner/desk/cleaner browser journeys and failure/retry cases. Repair the express test's availability wait rather than relying on retries to hide the race.
3. **Make release checks trustworthy.** Fix dependency pins and MinIO CI, check all current work into a reviewed branch after excluding local archives/secrets, and obtain a green clean-run pipeline. Keep migration history intact.
4. **Establish the production safety gate.** Provision an empty production-shaped environment, configure approved tax rules, storage encryption, real backup providers/keys, schedules and alerts. Restore database and document bytes and record evidence before introducing real guests.
5. **Finish required operating features.** Owner records/data export, privacy/retention, daily-summary settings/delivery, Google mirror/archive, import/training and Data Safety visibility. Add optional provider integrations only for agreed launch scope.
6. **Validate the intended market environment.** Run the specification's 50-user/200-room workload and a long-running test covering nightly audit, storage latency and worker backlog. Measure first load (<3 s on representative Android/4G), navigation (<300 ms) and feedback (<100 ms). Test real iPhone/Android/Windows/macOS devices and printers; obtain accountant acceptance and VAPT sign-off. Run the pilot in parallel with the existing register/accounting process and reconcile every day before switching over.

No reliable “percentage complete” or delivery date follows from lines of code or green unit tests. These gates provide a measurable path to readiness.

## Reproduce the added checks

With the local test database and MinIO configured:

```sh
pnpm verify
pnpm exec playwright test
node ops/ci/audit.mjs
pnpm --filter @resortos/api exec vitest run --config vitest.audit.config.mts
```

For this machine's HTTPS MinIO, the test invocations used `TEST_S3_ENDPOINT=https://localhost:9000` and `NODE_EXTRA_CA_CERTS` pointing at the installed mkcert root. Standard plain-HTTP CI does not need those overrides. Set the overrides for the browser suite as well, or uploads/backup tests will fail for environmental reasons.

Audit source: `apps/api/test/market-readiness.audit.ts`; opt-in config: `apps/api/vitest.audit.config.mts`. The separate `.audit.ts` suite is intentionally red until its requirements are implemented; it does not inflate the existing green regression count. After fixes, move the cases into their relevant normal module suites and make them required in CI.

## Boundaries of this audit

This is a code/specification review plus automated local tests, targeted real-database probes, a local request burst, exploratory browser review, dependency/secret scans and a rendered PDF check. It does **not** certify every input permutation, production cloud reliability, 200-room scale, live payment reconciliation, actual Tally/GST portal imports, real mobile camera behavior, physical printers, legal compliance or external penetration resistance. Those are explicitly listed release work, not hidden assumptions. No real guest data or real outbound customer messages were used.
