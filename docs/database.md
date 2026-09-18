# Database

PostgreSQL 16 is the only source of truth (spec §3, §48). Google Sheets and Drive will be one-way
copies; nothing is ever read back from them.

## Roles

| Role | Used by | Can |
|---|---|---|
| `resortos_migrator` | `pnpm db:migrate`, tests | own the schema, DDL |
| `resortos_app` | the API | SELECT / INSERT / UPDATE, and DELETE on `idempotency_keys` only |

`resortos_app` cannot DROP, TRUNCATE or ALTER anything, and cannot UPDATE append-only tables.
`db/grants.sql` states this and is **re-applied after every migration run**, so a new table does not
quietly inherit more rights than it should. Grants are a second guard, not the only one: protected
tables also carry `BEFORE DELETE`/`BEFORE UPDATE` triggers, so a mistake made as the owning role is
still refused.

## Migrations

- `db/migrations/NNNN_name.sql`, applied in order, **checksummed**. Editing an applied migration is
  an error — add a new one.
- Forward-only in shape: expand → migrate → contract, never a destructive change in the same
  release (spec §77.3).
- `db/grants.sql` is idempotent and runs last.

## Adding a protected table

Every business table needs all five, or it is not finished (CLAUDE.md, spec §48):

1. `property_id`, referencing `properties`
2. a `forbid_change` `BEFORE DELETE` trigger
3. a grants line in `db/grants.sql` if it is append-only
4. a row type in `apps/api/src/db/rows.ts` (untyped query results are a compile error)
5. inclusion in restore verification — **not yet possible**: `ops/backup` does not exist, so new
   tables are listed here until it does. Tables awaiting restore verification: **all of them**
   (Gate 0, `docs/production-readiness.md`).

## Tables by area

### Foundation — `0001`
`properties`, `users`, `recovery_codes`, `trusted_devices`, `sessions`, `auth_attempts`,
`audit_logs`, `idempotency_keys`, `outbox_events`, `settings`, `feature_flags`,
`reference_counters`.

### Property, rates, tax — `0002`
`room_types`, `rooms`, `room_status_history`, `room_out_of_order`, `meal_plans`, `rate_plans`,
`rate_calendar`, `tax_rules`.

### Guests and reservations — `0003`
`guests`, `reservations`, `reservation_rooms`, `room_allocations`, `guest_credit_entries`,
`reservation_room_nights`.

### Authorisation and throttling — `0004`
`owner_authorisations`, `owner_overrides`, `known_devices`.

### Check-in, capture, stays — `0005`, `0006`
`check_in_drafts`, `capture_sessions`, `stays`, `stay_occupants`, `stay_vehicles`,
`guest_documents`, `document_access_log`, `room_shifts`.

### Registration cards — `0007`
`grc_documents`.

### Job queue schema — `pgboss`
Not a numbered migration. pg-boss creates and upgrades its own schema, and `pnpm db:migrate` runs
that **as the migration role** after the numbered migrations; the API then starts pg-boss with
`migrate: false`, so `resortos_app` never needs DDL rights. Copying pg-boss's DDL into a checksummed
migration would pin one version of it forever and leave upgrades to be hand-written.

`db/grants.sql` gives `resortos_app` read/write **and DELETE** on that schema only — jobs genuinely
are disposable, which is the exception the no-delete rule describes.

### Outbox dead-letter — `0009`
`outbox_events.failed_at` marks an event the dispatcher gave up on. The event is kept; a failed
WhatsApp message is still a record that the system meant to send one. A CHECK keeps an event from
being both dispatched and dead.

### On-device Aadhaar masking removed — `0008`
Drops the CHECK that required `masked_on_device` for Aadhaar images (product owner's decision; see
CLAUDE.md rule 11). The column is kept as a historical record of files captured while masking
existed, and nothing writes it now.

Not created yet (Phase 2 onward): folios, folio lines, payments, invoices, `document_counters`,
company accounts, OTA bookings, cashier shifts, night audits, business dates, housekeeping tasks,
maintenance, expenses, messages, Form C, metrics. **Do not add them ahead of their milestone** —
night audit and the business date come first, because folios, invoices and every metric depend on
them.

## Invariants the database enforces itself

These are deliberately not application checks, because application checks can be bypassed by the
next caller:

| Invariant | Mechanism |
|---|---|
| No double booking | `no_overlapping_room_allocations` — `EXCLUDE USING gist (room_id WITH =, daterange(start_date, end_date, '[)') WITH &&) WHERE (status IN ('reserved','checked_in'))`. Half-open, so checkout and check-in can share a date. |
| Room-type inventory | `FOR UPDATE` on `room_types` while counting sellable rooms |
| One active check-in draft per booking | `check_in_drafts_one_active` partial unique index |
| One primary occupant per stay | `stay_occupants_one_primary` partial unique index |
| Document facts never change; status only moves forward | `guard_guest_document` trigger |
| A checked-out stay cannot change; check-in facts are immutable | `guard_stay_update` trigger |
| Registration cards are replaced, never edited | `grc_documents` `BEFORE UPDATE` and `BEFORE DELETE` triggers, plus `REVOKE UPDATE` |
| Audit log is append-only and tamper-evident | hash chain in `audit_chain_link`, verified by `verify_audit_chain(property)` |
| No overlapping tax rules | `no_overlapping_tax_rules` exclusion constraint |

## Conventions

- Money is `NUMERIC(14,2)`. Dates are `date`; timestamps are `timestamptz`. The pg driver is
  configured to return NUMERIC, DATE and BIGINT **as strings** — keep it that way, and do the
  arithmetic with the shared decimal helpers.
- Running numbers come from `reference_counters` + `next_reference()`. GST document numbers will come
  from `document_counters` (spec §31). Never a SEQUENCE: a rollback would skip a number.
- `id` is a UUID; `created_at`/`created_by` everywhere; `updated_at`/`updated_by`/`version` where the
  row is editable.
- Constraint names are mapped to plain-language messages in `apps/api/src/common/errors.ts`. A new
  constraint without a mapping shows staff a database error — add it.

## Registration cards (`grc_documents`)

Worth spelling out, because it is the first table that is append-only in the strongest sense: **no
column is ever updated.**

A card is one row per version. Regenerating (an occupant was added, the guest signed again) inserts a
new row with `version + 1`, `supersedes_id` pointing at the row it replaces, and its own
`storage_key` — so neither the row nor the stored file is overwritten. The stay's current card is its
highest version. `number` is allocated once per stay and carried by every version, so the card keeps
one identity while its history stays visible.

The row is written only after the rendered PDF has been stored **and re-read and re-hashed**. The
storage round trip runs inside the transaction on purpose: a failure then leaves no row and no gap in
the GRC series, whereas the other ordering could leave a recorded card whose file nobody confirmed.

## Local commands

```
pnpm db:up && pnpm db:migrate && pnpm db:seed   # PostgreSQL + MinIO, schema, demo data
pnpm test                                       # rebuilds resortos_test from migrations first
```

The demo seed is refused outside development and test (`assertSeedAllowed`), and production boot
refuses a database that still contains demo properties, demo logins or placeholder GST rules.
