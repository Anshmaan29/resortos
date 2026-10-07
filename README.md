# ResortOS

Cloud resort management system for Indian resorts — front desk, billing with GST, owner data access,
and strict data safety. Built to the ResortOS Master Specification v4.

**Status:** Reception, billing, documents and owner records are implemented; hotel acceptance and accountant-confirmed tax setup remain before handover. See [`docs/hotel-handover.md`](docs/hotel-handover.md) and [`docs/PHASES.md`](docs/PHASES.md).
Testing: [`docs/testing.md`](docs/testing.md) · Security: [`docs/security.md`](docs/security.md) · Go-live: [`docs/production-readiness.md`](docs/production-readiness.md)

## Stack

| Layer | Technology |
|---|---|
| Web | Next.js 16 (App Router), React 19, TypeScript strict, Tailwind CSS 4, Motion, TanStack Query |
| API | NestJS 11 (modular monolith), REST under `/api/v1`, Zod validation |
| Database | PostgreSQL 16 — constraints, exclusion constraints and triggers enforce business rules |
| Shared | `@resortos/shared`: money (decimal), GST engine, Indian validators/formatting, Zod schemas |
| Tests | Vitest (unit + API integration incl. concurrency), Playwright |

## Getting started

Requirements: Node 22+, pnpm 10, Docker.

```bash
cp .env.example .env
pnpm install
pnpm --filter @resortos/shared build
pnpm db:up          # PostgreSQL 16 on localhost:5433
pnpm db:migrate
pnpm db:seed        # fake demo resort (prints demo logins)
pnpm dev:api        # terminal 1
pnpm dev:web        # terminal 2 → http://localhost:3000
```

Demo logins (development seed only — the seed refuses to run outside a local development/test database, and the production API refuses to start if demo data exists):

| Role | Username | Password | Owner PIN |
|---|---|---|---|
| Owner | `owner` | `Aravali#Hills26` | `482916` (recovery codes `DEMO-AAAA-2222`, `DEMO-BBBB-3333`, `DEMO-CCCC-4444`) |
| Receptionist | `priya` | `Aravali#Desk26` | — |

## Layout

```
apps/api        NestJS API (auth, property, rates, guests, reservations, …)
apps/web        Next.js staff app
packages/shared Money, GST engine, validators, schemas shared by web + API
db/migrations   SQL migrations (source of truth for constraints and triggers)
db/grants.sql   Least-privilege grants for the application role
docs/           Delivery plan and module docs
```

## Safety guarantees already enforced by the database

- Overlapping room allocations are rejected by an exclusion constraint (checkout day is free for a new arrival).
- Reservations, rooms, guests, allocations, tax rules and audit logs cannot be deleted; status changes follow a trigger-checked state machine.
- The audit log is append-only and hash-chained per property; `verify_audit_chain()` detects tampering.
- The application database role cannot DELETE, TRUNCATE, DROP or rewrite audit history.
- Business date can only move forward.

> GST rates and SAC codes in the seed are illustrative and **must be confirmed by the resort's CA** before go-live.
