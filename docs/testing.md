# Testing

All tests that touch data run against **real PostgreSQL 16** (`resortos_test`, rebuilt from migrations and the demo seed before each run). There are no database mocks, because the guarantees under test (exclusion constraints, triggers, row locks, grants, transactions) only exist in the database.

| Command | What runs |
|---|---|
| `pnpm test` | shared unit tests · API integration tests · web design-token contrast tests |
| `pnpm e2e` | builds everything, starts the built API + web against `resortos_test`, runs Playwright (desktop + phone viewport) |
| `pnpm verify` | build + typecheck + `pnpm test` |

## Critical guarantees and where they are proven

| Guarantee | Test |
|---|---|
| Double booking impossible (concurrent requests, capacity race, raw SQL bypass) | `apps/api/test/reservations.test.ts` |
| Idempotency: double-click creates one record | `apps/api/test/reservations.test.ts` |
| Permissions: roles, forced password change, logout | `apps/api/test/auth.test.ts` |
| Owner PIN: single use, 2-minute expiry, bound to values, other staff, concurrency, lock + unlock | `apps/api/test/owner-authorisation.test.ts` |
| Lockout abuse: attacker network, known device, network-wide, distributed, recovery | `apps/api/test/login-protection.test.ts` |
| Outbox: a failing handler retries with backoff, succeeds later, and is delivered exactly once | `apps/api/test/outbox.test.ts` |
| Outbox: gives up after 10 attempts, keeps the event forever, never retries it again | `apps/api/test/outbox.test.ts` |
| Outbox: a handler that dies mid-flight leaves the event to be retried, not lost | `apps/api/test/outbox.test.ts` |
| Outbox: three workers draining at once never run the same event twice | `apps/api/test/outbox.test.ts` |
| Outbox: the API role cannot delete an event; an event cannot be both dispatched and dead | `apps/api/test/outbox.test.ts` |
| Job queue starts as the least-privileged API role against a migrator-owned schema, and drains a real event | `apps/api/test/jobs-runtime.test.ts` |
| Throttling holds when the API clock drifts from the database clock (a fast app clock must not switch it off) | `apps/api/test/login-protection.test.ts` |
| Audit tamper detection; app role cannot rewrite history | `apps/api/test/reservations.test.ts` |
| Audit chain does not fork under 60 parallel actions | `apps/api/test/audit-concurrency.test.ts` |
| Edit / rebook use the same validation, limits and audit | `apps/api/test/booking-changes.test.ts` |
| No SQL interpolation; demo data blocked from production | `apps/api/test/guards.test.ts` |
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
| DD/MM/YYYY picker, Owner PIN by keyboard, override shown, edit, rebook | `tests/e2e/front-desk.spec.ts` |

## Where concurrency tests live

`tests/concurrency/` from spec §87 is **not** a separate suite. Concurrency guarantees are proven
inside the API integration tests, because they need the same fixtures, the same app instance and the
same real database: two overlapping bookings and double-click idempotency in
`reservations.test.ts`, the audit chain under 60 parallel actions in `audit-concurrency.test.ts`,
double confirm in `check-in.test.ts`, and double card generation in `grc.test.ts`. Parallel invoice
finalisation and two simultaneous night audits join them in Phase 2.

## Not automated (needs real devices)

Camera capture and the phone scanner (milestone 1.8) must be tested manually on a real iPhone (Safari) and a real budget Android phone (Chrome), including an upload that drops and resumes on a weak network. Procedure and result table: `docs/phone-testing.md`.
