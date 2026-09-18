# Architecture

Spec: `ResortOS Master Specification v4` §8, §75, §87. This file describes what is **built**, not the
whole plan; `docs/PHASES.md` tracks what is still missing. Update it in the same commit as the change
it describes.

## Shape

A modular monolith, deliberately (spec §1.1: no microservices).

```
apps/web     Next.js App Router — staff app + the phone capture page
apps/api     NestJS — one module per business area, REST under /api/v1
packages/shared  Zod schemas, money, GST engine, Indian formatting — used by BOTH sides
db/          SQL migrations (the only way the schema changes) + grants.sql
ops/         dev HTTPS for phone testing, CI storage helper
```

`packages/shared` exists so a rule cannot drift between the form and the server: the web form and
the API validate with the *same* Zod schema, and money is the same decimal implementation in both.

## API modules

Built today: `auth`, `property`, `rates`, `guests`, `reservations`, `stays`, `storage`, `health`,
`safety`, plus `common` (audit, idempotency, outbox, errors, request context) and `db`.

Not built yet: `billing`, `shifts`, `housekeeping`, `maintenance`, `expenses`, `notifications`,
`records`, `compliance`, `reports`, `revenue-intel`, `migration`.

A module owns its tables. It never writes another module's tables directly — it calls that module's
service. `stays` calling `ReservationsService.assignRoom` during check-in is the pattern to copy.

## The shape of every mutation

```
authenticate (session cookie)         SessionGuard
  ↓ authorise: role, receptionist limit, Owner PIN if beyond it
  ↓ validate input with the shared Zod schema
  ↓ BEGIN                             DbService.tx
  ↓   IdempotencyService.run          same key → the original result, nothing new
  ↓   lock the rows that decide       SELECT … FOR UPDATE
  ↓   business changes
  ↓   AuditService.record             append-only, hash-chained
  ↓   OutboxService.emit              work for after the commit
  ↓ COMMIT
```

Three rules that are easy to break and expensive to get wrong:

- **Owner PIN state lives outside the business transaction.** PIN failure counters and pending
  approvals must survive a rolled-back attempt, so `OwnerAuthorisationService` writes them on their
  own connection (spec §4.5).
- **External services never run inside the transaction** (spec §13). They go in the outbox.
  Object storage is the one exception, and only where a row must not exist unless its file was
  verified — see below.
- **Every query declares its row type** (`q.query<Row>(…)`), and SQL text is never built with
  `${}`. Both are compile errors waiting to happen; `apps/api/src/db/rows.ts` holds the row shapes.

### Outbox

`outbox_events` rows are written in the same transaction as the change that caused them, so an
event cannot be lost or emitted for work that rolled back.

**The event row is the job.** pg-boss (spec §7) decides *when* a drain runs and makes sure something
runs it; it does not hold the work itself, so there is one answer to "was this delivered" instead of
two that can disagree. `OutboxDispatcher` claims due events with `FOR UPDATE SKIP LOCKED`, runs the
handlers registered for the topic, and records the outcome:

- **success** → `dispatched_at` set
- **failure** → error recorded, retried with exponential backoff and jitter
- **after 10 attempts** → `failed_at` set: dead-lettered, kept forever, never retried again

Delivery is **at-least-once** — a claim defers the event before the handler runs, so a process that
dies mid-handler leaves it to be retried rather than spinning on it. Handlers must therefore be
idempotent; the `OutboxHandler` interface says so where someone will read it. Nothing deletes an
event, and `resortos_app` has no DELETE right on the table, so the API cannot lose one by mistake.

Every deadline is `now() + interval` in PostgreSQL, never this process's clock — workers run on more
than one machine, and the throttling bug fixed in `auth.service.ts` was the same mistake.

Handlers are contributed through the `OUTBOX_HANDLERS` token, the same extension-point pattern as
checkout steps. **None are registered yet**: WhatsApp, email, the Sheets mirror and the Drive archive
arrive in Phase 3. Until then events are recorded faithfully and dispatched with nothing to do, and
`GET /health/jobs` (owner-only) says which topics have no handler rather than pretending all is well.

pg-boss owns its own schema. `pnpm db:migrate` installs and upgrades it **as the migration role**,
and the API starts pg-boss with `migrate: false`, so the least-privileged app role never needs DDL
rights (`docs/database.md`).

## Storage and verified files

Object storage is reached through the S3 API only, so development (MinIO), CI (MinIO) and production
(S3) run one code path (`storage.service.ts`).

Files arrive two ways, and both end with the server checking the bytes:

| Path | How |
|---|---|
| Device upload (photos, IDs, signatures) | Pre-signed PUT that binds content type, length and SHA-256, with `If-None-Match: *` so a key is write-once. The device uploads straight to storage; the API then **re-reads the object and re-hashes it** before the document moves PENDING → VERIFIED (spec §19.5). |
| Server-generated (registration cards; invoice PDFs in Phase 2) | The API renders the bytes, `putObject`s them under a fresh key, re-reads and re-hashes, and only then writes the database row. |

A document or card is never "received" on the strength of a client's word or a metadata field.

Reading is always a signed URL valid for 60 seconds, and every view is written to
`document_access_log` (spec §19.7).

### Server-rendered PDFs

`apps/api/src/stays/grc-pdf.ts` renders the guest registration card with pdfkit — no headless
browser, on purpose: a one-page form does not justify shipping Chromium.

The render is a **pure function of its input**: no clock reads, no random ids, and the font is a
pinned file in the repository (`src/stays/assets`, see its README). The same input therefore produces
byte-identical output, which is what makes the SHA-256 stored in `grc_documents` a real check —
regenerating a card from its row reproduces the archived file exactly. `grc.test.ts` asserts both the
reproducibility and the font checksum, so an innocent-looking change to either fails the build.

One Noto family covers Latin, ₹ and correctly shaped Devanagari, so the bilingual card needs a
single embedded file. Assets are copied into `dist` by `scripts/copy-assets.mjs` during build,
because `tsc` emits only JavaScript.

## Concurrency

- **Double booking** is refused by the `no_overlapping_room_allocations` exclusion constraint, not
  by application checks. Room-type (unassigned) bookings are counted under a `FOR UPDATE` lock on
  `room_types`.
- **Running numbers** (`BK-000183`, `GRC-000042`) come from `reference_counters` through
  `next_reference()`, which takes a row lock. A rollback releases the number, so the series has no
  gaps. Invoice numbers will use `document_counters` the same way (spec §31) — never a SEQUENCE.
- **Editable records** carry a `version` column; a stale write gets `STALE_VERSION` and a
  "reload" message rather than silently winning.
- A busy database (pool exhaustion, lock timeout, deadlock) surfaces as `SERVICE_BUSY` (503) with
  "nothing was saved" — safe to retry, because every mutation takes an idempotency key.

## Frontend

Next.js App Router. `apps/web/src/lib/api.ts` is the only place that talks to the API;
`lib/motion.ts` holds the motion presets (150–250 ms, transform/opacity only, reduced-motion
respected — spec §69).

Two audiences share the app:

- **Desk** (`/(app)/…`): logged in, cookie session.
- **Phone capture page** (`/capture/[token]`): no login. It holds a single-use token plus a device
  secret and can *only* create uploads for one check-in draft. No endpoint it can reach returns a
  guest name, mobile, room or booking number — `check-in.test.ts` asserts that.

Check-in keeps its state in a **server-side draft**, saved on every step with an optimistic version
check, so a refresh, a crash or a power cut loses nothing (spec §18.1).

## Environments

`development` (Docker PostgreSQL + MinIO, demo seed), `test` (`resortos_test`, rebuilt from
migrations before every run), `production` (refuses to boot against demo properties, demo logins or
placeholder GST rules — `src/safety/production-guard.ts`).
