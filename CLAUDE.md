# ResortOS — engineering rules

Spec: ResortOS Master Specification v4. Delivery plan: `docs/PHASES.md`.
Priority: **Data safety → Correctness → Security → Usability → Reliability → Performance → Features**

1.  PostgreSQL is the only source of truth. Google Sheets/Drive are one-way read-only copies; never read data back from them.
2.  Never hard-delete reservations, stays, folio lines, payments, invoices, notes, shifts, documents, or audit logs.
3.  Multi-record changes run in one transaction with audit + outbox (`DbService.tx`, `AuditService`, `OutboxService`).
4.  Every mutation supports idempotency keys (`IdempotencyService.run` inside the same transaction).
5.  Double booking is prevented by the `no_overlapping_room_allocations` exclusion constraint; room-type inventory is checked under a `FOR UPDATE` lock on `room_types`.
6.  Backend enforces roles, receptionist limits, and Owner PIN via `OwnerAuthorisationService.require`: approvals are single-use, expire in 2 minutes, and are bound to a hash of the exact request scope. PIN failure counters and pending approvals are written outside the business transaction.
7.  Money: NUMERIC(14,2) in DB, `@resortos/shared` money helpers (decimal.js) in code, strings in API. The pg driver returns NUMERIC/DATE as strings — keep it that way.
8.  Invoice numbers come from `document_counters`, never a SEQUENCE.
9.  Finalized invoices are immutable (DB trigger); corrections via credit/debit notes.
10. Tax rates come from dated `tax_rules`; never hard-code rates. The GST engine lives in `packages/shared/src/gst.ts`.
11. Documents: verified checksum before a check-in can be confirmed; signed short-lived URLs only; every view audit-logged.
    **Deliberate difference from the spec:** on-device Aadhaar masking (spec §19.4.5, §58.3, §85) was
    removed at the product owner's request after real-device testing — migration `0008`. ID images are
    stored as captured. Only the last 4 characters of an ID *number* are ever stored, which is
    unchanged. Do not re-add masking without asking the owner.
12. Never send ID data, photos, full phones, addresses, or flags to Google, messages, logs, or the AI provider. Audit entries store identifiers, not guest personal details.
13. External services (WhatsApp, email, Google, AI) run after commit and can never break a transaction.
14. Roles: Owner, Receptionist, optional task-only Cleaner. No manager role, no approval queue.
15. No payment gateway. Payments are recorded, not processed.
16. No restaurant/POS/KOT system. Food and activities are named folio charge lines.
17. Only AI feature: Revenue Intelligence. Read-only role, aggregated data, LLM narrates backend-computed numbers, every number validated, feature flag, never mutates anything.
18. Backups: PITR + second region + second provider with Object Lock; restore tests must pass.
19. Animations: 150–250 ms, transform/opacity only, never block input, respect reduced motion (`apps/web/src/lib/motion.ts`).
20. Build one module at a time; tests green before moving on; update docs.

21. Every query declares its row type (`q.query<Row>(…)`); untyped results are a compile error. Never build SQL text with `${}`.
22. Demo seed data only in local development/test; production boot refuses demo properties, demo logins and placeholder GST rules.
23. No real guest data until backups + a successful restore test exist (`docs/production-readiness.md`, Gate 0).

## Conventions

- Migrations: `db/migrations/NNNN_name.sql`, never edit an applied migration (checksum enforced). `db/grants.sql` is re-applied every run.
- The API connects as `resortos_app` (no DELETE/TRUNCATE/DROP). Migrations run as `resortos_migrator`.
- New protected tables need: `property_id`, `forbid_change` delete trigger, grants review, and inclusion in restore verification.
- Validation schemas are shared (`packages/shared/src/schemas.ts`) — the web form and the API use the same Zod schema.
- API errors are `{ code, message, details, requestId }` with plain-language messages. Map new DB constraint names in `apps/api/src/common/errors.ts`.
- Staff-facing words: "Bill" not "folio", "Guest details" not "CRM".

## Commands

```
pnpm db:up && pnpm db:migrate && pnpm db:seed   # local database
pnpm dev:api                                    # http://localhost:4000/api/v1
pnpm dev:web                                    # http://localhost:3000
pnpm test                                       # shared unit + API integration (uses resortos_test DB)
pnpm verify                                     # build + typecheck + test
pnpm e2e                                        # Playwright against built apps + resortos_test
```
