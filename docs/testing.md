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
| Audit tamper detection; app role cannot rewrite history | `apps/api/test/reservations.test.ts` |
| Audit chain does not fork under 60 parallel actions | `apps/api/test/audit-concurrency.test.ts` |
| Edit / rebook use the same validation, limits and audit | `apps/api/test/booking-changes.test.ts` |
| No SQL interpolation; demo data blocked from production | `apps/api/test/guards.test.ts` |
| Phone scanner: single-use QR, 10-minute expiry, upload-only, no guest data to phone, device secret | `apps/api/test/check-in.test.ts` |
| Document counts only after server re-hash (SHA-256 + size); tampered/expired/overwrite links refused; Aadhaar masked flag | `apps/api/test/check-in.test.ts` |
| Check-in blocked while documents are uploading/failed/missing; draft survives refresh; double confirm → one stay | `apps/api/test/check-in.test.ts` |
| Room shift uses the exclusion constraint; checkout pipeline order; checked-out stay immutable | `apps/api/test/check-in.test.ts` |
| WCAG AA contrast of every text/surface token pair, both themes | `apps/web/test/contrast.test.ts` |
| DD/MM/YYYY picker, Owner PIN by keyboard, override shown, edit, rebook | `tests/e2e/front-desk.spec.ts` |

## Not automated (needs real devices)

Camera capture and the phone scanner (milestone 1.8) must be tested manually on a real iPhone (Safari) and a real budget Android phone (Chrome), including an upload that drops and resumes on a weak network. Procedure and result table: `docs/phone-testing.md`.
