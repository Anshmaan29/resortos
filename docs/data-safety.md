# Data safety

Spec Part G (§47–§56). Priority order, everywhere: **Data safety → Correctness → Security →
Usability → Reliability → Performance → Features**.

> **This document is honest about what does not exist yet.** The layered backups that Part G requires
> are **not built**. Until they are, and until a restore from the off-site copy has passed and been
> recorded, no real guest data may enter any ResortOS environment (CLAUDE.md #23,
> `docs/production-readiness.md` Gate 0). Only the fake demo seed is allowed.

## What protects data today

### Nothing critical is hard-deleted

Reservations, stays, folio lines, payments, invoices, shifts, documents, registration cards and audit
logs are never deleted. Corrections create new records: a cancelled booking keeps all its data, a
superseded registration card keeps its row and its file. Two independent guards:

- `resortos_app` has no DELETE right on those tables (`db/grants.sql`, re-applied every migration)
- each table carries a `forbid_change` `BEFORE DELETE` trigger, so the owning role is refused too

### The audit log is tamper-evident

`audit_logs` is append-only and hash-chained: each row stores a SHA-256 over its canonical content
plus the previous row's hash. Appends are serialised per property with an advisory lock, so chain
order equals commit order. `verify_audit_chain(property)` returns the first broken link and is
proven under 60 parallel actions by `audit-concurrency.test.ts`.

Still missing: the **nightly** verification job, the daily chain head written to off-site storage,
and the owner-facing audit viewer.

### A file is not "received" until the server has re-read it

Both upload paths end with the server downloading the stored object and re-hashing it (spec §19.5):

- **Device uploads** stay PENDING until size and SHA-256 match, then become VERIFIED. A mismatch
  marks the document FAILED and the device uploads again. Check-in cannot be confirmed while a
  required document is anything but VERIFIED.
- **Server-generated PDFs** (registration cards) are stored, re-read, re-hashed, and only then does
  the `grc_documents` row exist. A storage fault leaves no row — and no gap in the GRC number series,
  because the number is allocated in the same transaction.

Storage keys are write-once (`If-None-Match: *`), the checksum is bound into the pre-signed URL, and
every read is a 60-second signed URL logged in `document_access_log`.

### Repeats and races cannot duplicate or corrupt

- Every mutation accepts an `Idempotency-Key`; the same key returns the original result and does
  nothing new. Double-clicking confirm produces one check-in; `check-in.test.ts` and `grc.test.ts`
  prove it for check-in and for card generation.
- Double booking is impossible at the database level (exclusion constraint), not merely unlikely.
- Running numbers come from a locked counter row, so a rollback releases the number unused.
- A busy database surfaces as `SERVICE_BUSY` (503) with "nothing was saved", which is safe to retry.

### Personal data stays where it belongs

- Only the **last 4 characters** of an ID are ever stored; a full ID number is refused by the schema
  and by the API.
- Aadhaar images are masked on the device before upload, enforced by a CHECK constraint as well as
  by the form.
- The phone capture page can only upload. No endpoint it can reach returns a guest name, mobile,
  room or booking number — asserted in `check-in.test.ts`.
- Audit entries record identifiers and amounts, not guest personal details.

### Tests run against the real thing

Every integration test runs against real PostgreSQL and real S3-compatible storage (MinIO in
development and CI) — **no database mocks**. `resortos_test` is dropped and rebuilt from migrations
before each run, so a migration that does not apply cleanly fails the suite. CI runs the same suites
plus a gitleaks secret scan on every push.

## What is missing (Gate 0)

| Layer | Spec | State |
|---|---|---|
| Managed PostgreSQL, Multi-AZ, PITR (Mumbai) | §53.1 | not set up |
| Backups and file replication to a second region (Hyderabad) | §53.2 | not set up |
| Nightly encrypted logical backup to a **different provider** with Object Lock | §53.3 | not set up |
| Backup encryption key held in two places outside the primary cloud | §54 | not set up |
| Automated weekly restore test | §53.5 | not set up |
| Quarterly manual restore drill | §53.5 | not done |
| Nightly integrity checks and incident records | §55 | not built |
| Owner-facing Data Safety panel | §53.7 | not built |
| Disaster recovery runbook (`ops/runbooks`) | §53.6 | not written |

`ops/backup` and `ops/runbooks` do not exist. Creating them is milestone 3.6, but **Gate 0 blocks the
pilot, not just Phase 3** — nothing about the front desk being finished makes it safe to type a real
guest's name into this system.

## Known gaps in what is built

- **Nothing drains `outbox_events`.** Events are recorded correctly and lose nothing, but no worker
  sends anything yet. The pg-boss worker is the next infrastructure piece and needs dead-lettering
  and visible job status so the Data Safety panel has something true to show.
- **No error tracking or alerting.** No Sentry, no uptime checks, no operator alerts (spec §78).
- **Orphaned uploads are not swept.** Documents uploaded but never attached to a confirmed check-in
  should be flagged for owner review after 7 days (spec §19.5); nothing does this yet. They are never
  silently deleted, so the gap is visibility, not loss.
- **No retention jobs.** ID images and photos are kept indefinitely today; retention (spec §59) is
  milestone 3.5.
- **Folio balance recalculation** (spec §49) has nothing to check yet — folios arrive in Phase 2.
