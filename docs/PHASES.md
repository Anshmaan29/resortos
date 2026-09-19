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

### Before the pilot (after 1.8, before Phase 2 is finished) — in this order

1. Owner settings screens: rooms, room types, rate plans, meal plans, minimum rates, receptionist limits
2. Quick PIN switching between staff on shared desk computers
3. Authenticator-app 2FA for owner accounts
4. Calendar drag-to-move (lowest priority)

Then: **express check-in** — one screen for a walk-in by experienced staff, over the same draft and
confirm path, same validation, limits, audit and idempotency. The wizard stays the default.

### Phase 2 — in progress

| Milestone | State |
|---|---|
| 2.1 Business date & night audit | ✅ Done — step registry (2.2 and 2.4 plug in without editing it), arrivals/departures blocking with the actions each row actually allows, room-status warnings, summary, day audit log, no-show, extend stay, and the business date moved only by a completed audit. Design and the concurrency reasoning: `docs/night-audit.md`. Open-shift check arrives with 2.4; revenue in the summary with 2.2 and 2.3. |
| 2.2 – 2.8 | Not started |
### Milestone 2G — minimum viable Gate 0 — not started
### Phase 3 — not started
