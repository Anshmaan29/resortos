# ResortOS — Delivery Plan (3 Phases)

Source of truth for scope: `ResortOS Master Specification v4`.
The spec's seven internal phases (0–6) are grouped into three shippable
phases. Each phase ends with tests green, docs updated, and a demo on
desktop + phone.

Priority order in every phase:
**Data safety → Correctness → Security → Usability → Reliability → Performance → Features**

> **Hard rule: no real guest data enters any ResortOS environment until backup
> layers 1–3 (spec §53) are running and a restore test from the off-site copy
> has passed and been recorded.** Until then only the fake demo seed is allowed.
> This gates the pilot (milestone 3.8) and applies to imports from the old software.

---

## Phase 1 — Foundation & Front Desk
*(spec Phase 0 + Phase 1)*

Goal: a receptionist can set up rooms, take bookings, check guests in with
documents, shift rooms and check them out — with double booking impossible
and every action audit-logged.

| # | Milestone | Key deliverables | Spec § |
|---|---|---|---|
| 1.1 | Repository & tooling | pnpm monorepo (`apps/web`, `apps/api`, `packages/shared`), strict TypeScript, Docker PostgreSQL 16, SQL migrations runner, Vitest, CI script | 7, 77, 87 |
| 1.2 | Shared core | Money (decimal, never float), Indian formatting (₹1,12,000), validators (mobile, GSTIN checksum, PIN code, vehicle), GST engine + tests, Zod schemas shared by web and API | 30, 49, 68, 72 |
| 1.3 | Database foundation | properties, users, sessions, PINs, audit log with SHA-256 hash chain, idempotency keys, outbox, settings; no-delete triggers; separate app/migration DB roles | 48, 50, 51, 76 |
| 1.4 | Auth & roles | Username/phone + password (Argon2id), lockout, HttpOnly cookie sessions, Owner / Receptionist / Cleaner, receptionist limits, Owner PIN (rate-limited, 5-strike lock) | 4, 5 |
| 1.5 | Property & rates | Property settings, room types, rooms, 3-dimension room status + history, rate plans, meal plans, occupancy pricing | 9–11 |
| 1.6 | Guests & reservations | Guest profiles + duplicate warning, reservations, groups, availability, **exclusion constraint** on room allocations, cancellation (with money choice stub), no-show | 12, 13, 15, 16 |
| 1.7 | Web app shell & design system | Tokens (light/dark), components, motion presets (150–250 ms, reduced motion), login, reception home, room board, reservations list, calendar | 67–71 |
| 1.8 | Check-in / room shift / checkout | Server-side check-in drafts, occupants, vehicles, **photo/ID capture + phone-as-scanner (QR)**, upload queue with checksum verify, GRC + signature, room shift, checkout as a **stay/room status change only** with defined extension points where Phase 2's bill → payment → invoice steps slot in (no temporary billing checkout) | 17–22 |
| 1.9 | Guests & the lists the old software had | Guests screen + sidebar, Ctrl+K global search (guest, mobile, room, booking, vehicle), in-house list ("Check In List"), room-shift log, purpose of visit | 16, 71, `docs/old-system-parity.md` |

**Exit criteria:** concurrency test proves only one of two overlapping
bookings succeeds; check-in draft survives refresh; documents must be
VERIFIED before confirm; E2E walk-in → check-in → checkout passes.

---

## Phase 2 — Billing, Money & Night Audit
*(spec Phase 2)*

Goal: every rupee is recorded correctly, GST invoices are legally correct
and gap-free, and the business day closes cleanly.

**Order changed deliberately.** Night audit and the business date come *first*, because every
folio line, invoice and metric is attributed to a business date, and retrofitting that later means
rewriting rows that are supposed to be immutable. Night audit's one job that genuinely needs folios
— posting room nights — is a **registered step**, the same extension-point pattern checkout already
uses, so it plugs in when folios land without rewriting the audit.

| # | Milestone | Key deliverables | Spec § |
|---|---|---|---|
| 2.1 | Business date & night audit | Business date owned by night audit (never edited by hand), night audit run: arrivals not checked in (no-show / extend / cancel), departures not checked out, open shifts must be closed, room-status mismatches, summary, business-date advance, past date locked. Idempotent and re-runnable. Room-night posting registers as a step in 2.2. Day audit log | 15.2, 35 |
| 2.2 | Folio | Folio lines (never edited, void with reason), food/activity/other charges with saved items and quick-add, room-night posting step wired into night audit | 23, 24 |
| 2.3 | Payments & payment accounts | **`payment_accounts` from the first migration** (cash counter, bank, UPI, card POS); cash / UPI / POS card / bank / cheque / OTA / company / credit recording, split payments, reversals, advances, receipts, security deposits. Every payment and expense posts to an account | 25–27, parity (a) |
| 2.4 | Ledger & cashier shifts | Account-wise ledger ("Ledger Entries"), cashier shift open/close reconciled per account (counted cash vs cash counter, POS slip vs card account), owner review list | 34, parity (a) |
| 2.4b | Balance integrity check | Nightly job: every folio balance and payment-account balance recalculated from rows and compared with any cached copy. Differences are **reported, never auto-repaired** — they raise an incident visible to the owner | 49, 55 |
| 2.5 | Discounts & Owner PIN | Line/bill discounts, backend limits, on-screen Owner PIN override, slab recalculation preview | 4.5, 28 |
| 2.6 | GST & invoices | Dated tax rules, per-room-per-night slab, tax invoice / bill of supply, `document_counters` numbering, immutable finalized invoices (DB trigger), credit/debit notes, PDF | 29–31 |
| 2.7 | Company & OTA | Company accounts, company ledger, ageing, OTA commission/payout tracking, "availability changed today" list | 32, 33 |
| 2.8 | Printing | A4 invoice, receipt, GRC, shift report; 80 mm thermal option | 36 |

**Exit criteria:** GST boundary tests (₹7,500.00 vs ₹7,500.01), parallel
invoice finalization produces no gaps/duplicates, double-click payment
creates one record, E2E stay with food + activity + card/UPI split passes.

### Milestone 2G — Minimum viable Gate 0 *(runs alongside Phase 2, not after it)*

Gate 0 blocks the pilot no matter how finished the front desk looks, so the smallest honest version
of it is built while Phase 2 is in progress rather than waiting for 3.6:

- Managed PostgreSQL with point-in-time recovery
- Nightly encrypted logical dump (`pg_dump`) to a **second provider** with Object Lock, written with
  credentials that can write but not delete
- Backup encryption key stored **outside** the primary cloud, in two places
- **One restore test, actually performed and recorded** — date, duration, row counts, financial
  totals — with the runbook in `ops/runbooks/`

Staying in Phase 3 (3.6): second region, weekly automated restore tests, quarterly drill, integrity
monitoring, the owner-facing Data Safety panel.

**Until 2G is done and its restore test recorded, no real guest data enters any environment.**

---

## Phase 3 — Owner Data, Operations, Compliance & Launch
*(spec Phases 3, 4, 5, 6)*

Goal: the owner can see and trust their data; the resort runs daily
operations and stays compliant; the system is hardened for a pilot.

| # | Milestone | Key deliverables | Spec § |
|---|---|---|---|
| 3.1 | Owner data access | Records area, Excel/PDF/CSV exports, Tally + GSTR-1 exports, full export, owner daily summary | 42, 43, 46 |
| 3.2 | Google mirror | Sheets one-way mirror (masked, upsert, nightly rebuild), Drive monthly archive | 44, 45 |
| 3.3 | Operations | Housekeeping board + optional cleaner mode, maintenance tickets + schedules, expenses | 37–39 |
| 3.4 | Messages | WhatsApp/email via outbox, EN/HI templates, quiet hours, fallback | 40, 41 |
| 3.5 | Compliance | Form C, police register export, Aadhaar rules, DPDP consents & data requests, retention jobs, guest flags | 58–60 |
| 3.6 | Data safety ops | Backup layers 1–3, weekly restore test, integrity checks, Data Safety panel, key management runbook | 47–55 |
| 3.7 | Revenue intelligence | Metrics → dashboard → forecast (if criteria met) → AI explanations (if criteria met, feature-flagged) | 61–66 |
| 3.8 | Migration & hardening | Import wizard, load tests, VAPT, practice mode, training guides, pilot / parallel run | 74, 79, 80, 83 |

**Exit criteria:** section 85 production-readiness checklist complete;
7 consecutive pilot days with zero unexplained differences.

---

## Current status

### Phase 1 — in progress

| # | Milestone | Status |
|---|---|---|
| 1.1 | Repository & tooling | ✅ Done — pnpm monorepo, exact-pinned dependencies + lockfile, Docker PostgreSQL 16, checksummed SQL migration runner, Vitest, Playwright. |
| 1.2 | Shared core | ✅ Done — money, Indian formatting (₹, DD/MM/YYYY, +91 98490 12345), validators, GST engine, shared Zod schemas. |
| 1.3 | Database foundation | ✅ Done — hash-chained audit log (verified under 60 parallel actions), idempotency keys, outbox, protection triggers, least-privilege app role, typed query results (untyped rows are a compile error). |
| 1.4 | Auth & roles | ✅ Done — Argon2id; throttling per network / per known device with progressive delays instead of account lockout; owner recovery codes; Owner PIN approvals that are single-use, bound to exact values and expire in 2 minutes. Pending: staff PIN quick-switch on trusted desk computers, TOTP, owner email reset (needs email provider, Phase 3). |
| 1.5 | Property & rates | ✅ Done (API) — rooms, derived occupancy, status history, out-of-order, meal plans, rate calendar, occupancy pricing, dated tax rules + GST estimate. Pending: owner settings screens. |
| 1.6 | Guests & reservations | ✅ Done — create / edit / cancel / rebook through one validation + authorisation path, groups, per-night agreed rates, availability, exclusion constraint + type-inventory lock, owner override history. Pending: guest merge; no-show runs in night audit (Phase 2). |
| 1.7 | Web app & design system | ✅ Done — tokens meet WCAG AA in light and dark (automated test), own DD/MM/YYYY date picker, Owner PIN pad with keyboard support, booking form (create / edit / rebook) with GST estimate, booking detail with override record and check-in readiness, calendar, room board. Pending: calendar drag-to-move, Ctrl+K search, settings screens, Storybook. |
| 1.8 | Check-in / room shift / checkout | 🟡 In progress on branch `milestone-1.8-check-in`. ✅ API (drafts, phone scanner, S3 verified uploads, confirm, room shift, checkout pipeline). ✅ Step 1 desk check-in screens (guests, room assignment in-flow, documents, registration & signature, confirm; autosave). ✅ Step 2 phone camera page (native camera first, live preview, edge detection + manual corners, blur/brightness, ≤2000 px JPEG without EXIF, IndexedDB queue with resume) — **awaiting real-device tests** (`docs/phone-testing.md`). ✅ Step 3 GRC PDF: reproducible one-page bilingual card rendered with pdfkit and a pinned font, stored only after the server re-read and re-hashed it, append-only versions in `grc_documents`, all three signature routes recorded. ✅ Step 4 stay screen: registration card (print, versions, checksum shown), room change with availability + rate decision + Owner PIN, and checkout built around the server's blocker list so Phase 2's bill → payment → invoice steps drop in. **Milestone 1.8 complete except the real-device capture tests** (`docs/phone-testing.md`). |
| — | Outbox worker | ✅ Done — pg-boss runtime, `OutboxDispatcher` draining `outbox_events` with backoff and dead-lettering, `GET /health/jobs` for the owner. No handlers registered yet; those are Phase 3. |
| 1.9 | Guests & the lists the old software had | ✅ Done — Guests screen with stays, upcoming bookings, vehicles and permission-controlled documents; search by vehicle number; Ctrl+K global search (guest, mobile, room, booking, vehicle); in-house list ("Check In List") with status and date-range filters; room-change log; purpose of visit on the booking. Exports stay in Phase 3. |

Test suite (all against real PostgreSQL, no database mocks): see `docs/testing.md`.

### Before the pilot — Sprint B

| Item | State |
|---|---|
| Owner settings screens | ✅ Done — property, policies & printing, rooms & room types (minimum rates), rate plans, seasonal prices, meal plans, GST rules (add / close, never edit), staff & receptionist limits, charge items, payment accounts, guest message wording, desk computers. |
| Quick PIN switching on shared desks | ✅ Done — owner-trusted computers only; PIN works only after a password login that day; five wrong PINs stop it for 15 minutes; auto-lock after the owner's idle time ends the session. Design: `docs/security.md` → Shared desks. |
| Express check-in | ✅ Done — one screen for a walk-in: the booking form, then guests, room, IDs, registration card and confirm on one page, over the same draft and confirm path as the wizard (`useCheckIn`). |
| Guest email end to end | ✅ Done — Resend, on the outbox; booking confirmation, welcome, checkout reminder, invoice, receipt; English and Hindi; every message recorded with status and reason; delivery webhooks. Design: `docs/messaging.md`. |
| Authenticator-app 2FA for owners | ⬜ Not started |
| Calendar drag-to-move | ⬜ Not started (lowest priority) |

### Phase 2 — billing complete (Sprint A)

| Milestone | State |
|---|---|
| 2.1 Business date & night audit | ✅ Done — step registry (2.2 and 2.4 plug in without editing it), arrivals/departures blocking with the actions each row actually allows, room-status warnings, summary, day audit log, no-show, extend stay, and the business date moved only by a completed audit. Design and the concurrency reasoning: `docs/night-audit.md`. Open-shift check arrives with 2.4; revenue in the summary with 2.2 and 2.3. |
| 2.2 Folio | ✅ Done — the bill: charges with GST worked out from type and date, a line that can only be voided (never edited) with the reason kept, saved charge items as owner settings, and **room-night posting registered as a night audit step** that posts once per room per business date. Design: `docs/folio.md`. |
| 2.3 Payments & payment accounts | ✅ Done — recorded, never processed, never edited: reversal rows only, at most once. Database-computed bill / deposit / cash effects, method ↔ account kind enforced by CHECK, cash only inside the taker's open shift, advances that carry to the stay's bill through a view, security deposits held apart from what is paid, guest credit, refunds on Owner PIN, printable receipts. Design: `docs/payments.md`. |
| 2.4 Ledger & cashier shifts | ✅ Done — open with a count, close against what the ledger rows say, reason above the owner's threshold, card slip compared, closed shift locked; open shifts block night audit; account-wise ledger with running balance; owner review list (overrides, big discounts, voids, reversals, cash differences, credit notes, pending balances) with Seen marks. |
| 2.4b Balance integrity check | ✅ Done — nightly step reports, never repairs: money on the wrong booking, reversals that do not match, rows added to a day after it closed, closed shifts that no longer add up, negative deposits or guest credit. Restore test runs the money checks too. |
| 2.5 Discounts & Owner PIN | ✅ Done — line or bill, % or ₹, attached to the charge so the GST slab follows the net value; preview shows slab changes before saving; receptionist limit enforced on the server with Owner PIN bound to the exact parts. |
| 2.6 GST & invoices | ✅ Done — invoice written whole at checkout from `document_counters` (gap-free under concurrency, rollback gives the number back), immutable by trigger, totals checked at commit; bill of supply without a GSTIN; credit notes (owner, original rates, never beyond what was sold) and debit notes for late charges. Design: `docs/invoices.md`. |
| 2.7 Company & OTA | ✅ Done — company accounts with credit limit on Owner PIN, invoice in the company's name and GSTIN, statement with oldest-first ageing, company receipts; OTA terms, payouts and receivables report; "availability changed today" from the outbox. |
| 2.8 Printing | ✅ Done — A4 invoice / credit / debit note, receipt and shift report on A4 or 80 mm thermal; byte-for-byte reproducible PDFs. |

**Phase 2 exit criteria:** GST boundary ₹7,500.00 vs ₹7,500.01 ✅ (`discounts.test.ts`) · parallel finalization with no gap or duplicate ✅ (`invoices.test.ts`) · double-click payment creates one record ✅ (idempotency key on every money mutation) · E2E stay with food + activity + card/UPI split ✅ (`tests/e2e/billing.spec.ts`).
### Milestone 2G — minimum viable Gate 0 — in progress

| | |
|---|---|
| Layer 3 mechanism | ✅ Built and tested on every commit: `ops/backup/backup.mjs` (dump → envelope-encrypt → upload under Object Lock), `ops/backup/restore-test.mjs` (download → decrypt → hash check → restore → integrity checks → drop), `ops/backup/integrity.sql`, and the round trip in `apps/api/test/backup-restore.test.ts` against MinIO. |
| Runbook | ✅ `ops/runbooks/restore.md` — keys, bucket, IAM, the nightly job, the restore test, and recovering for real. |
| Real provider, real key, real drill | ⬜ Needs an account. Checklist and the restore-test log: `docs/production-readiness.md`. |
| Layers 1 and 2 (PITR, second region) | ⬜ Provider settings; no provider yet. |
### Phase 3 — operations, compliance and owner data (Sprint C)

| Milestone | State |
|---|---|
| 3.3 Housekeeping | ✅ Done — housekeeping tasks per room, kept in step with room status by the database (migration 0021); checkout and stayover tasks (stayover step registered in night audit); board with assignment, priority, notes, start/complete/stop/skip; a cleaner's own "My tasks" screen with no guest data. Web: `/housekeeping` (adapts by role). |
| 3.3 Expenses | ✅ Done — append-only expenses into payment accounts, correction = reversal + right entry, cash out of the taker's open shift, categories owner-managed, monthly report. Web: `/expenses`. |
| 3.3 Maintenance | ✅ Done — tickets with the one legal path open → in progress → resolved (note + cost) → closed enforced by the database (migration 0022), room "under maintenance"/out-of-order from the ticket, preventive schedules the night audit opens tickets for (`maintenance_due` step). Web: `/maintenance`. |
| 3.5 Compliance (Form C + police register) | ✅ Done — Form C records open by database trigger at check-in for foreign nationals, 24-hour countdown, portal copy-summary, submit gated on completeness (API + DB), departure update after checkout; police register derived live from stays in the station's columns. Web: `/form-c`, register on screen in Records. Tests: `compliance.test.ts`. |
| 3.1 Records & exports | ✅ Done — owner Records area (`/records`) with date-range presets; every record as Excel (deterministic zero-dependency `.xlsx` writer) and CSV: bookings, guests, stays, payments, invoices, expenses, daily summaries, Form C, police register (also PDF); GSTR-1-ready CSV (B2B, B2C per rate, notes) and Tally voucher XML; every download audit-logged (§46). Tests: `exports.test.ts`. |
| 3.4 Owner daily summary | ✅ Done — plain-text email after night audit (occupancy, revenue by line, collections by method, pending dues, cash difference, needs-a-look, tomorrow) to configurable recipients (`daily_summary_recipients`), once per date via the messages cause-key. Tests: `daily-summary.test.ts`. |
| 3.2 Google mirror (Sheets/Drive) | ⬜ Not started — needs a Google Cloud project and OAuth setup with the owner. |
| 3.5 remainder (DPDP consents & data requests, retention jobs, guest flags UI) | ⬜ Not started — consents at check-in exist (draft `consents`); request/erasure workflows pending. |
| 3.6 Data safety ops (Data Safety panel, weekly automated restore tests, integrity monitoring) | ⬜ Not started — backup/restore tooling + runbook exist (2G); panel and scheduling pending. |
| 3.7 Revenue intelligence | ⬜ Not started. |
| 3.8 Migration & hardening (import wizard, load tests, VAPT, training, pilot) | ⬜ Not started. |

### The property's own room configuration

The demo seed now carries the hotel's real room structure (18 rooms): **Executive** (101, 107) at ₹4,000 single / ₹5,000 double, **Premium** (9 rooms) at ₹2,500 / ₹3,000, **Delux** (7 rooms) at ₹2,000 / ₹2,500. Occupancy pricing maps single → `base_rate` at `base_occupancy` 1 and double → base + `extra_adult_rate`. Test fixtures and e2e specs were migrated to the same configuration, so development, tests and demos all mirror the hotel. Production still starts empty and is configured through Settings (the seed refuses to run outside local development/test).
