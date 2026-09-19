# Night audit and the business date (milestone 2.1)

Spec §35, §15.2. Written before the code, because every folio line, payment, invoice and metric in
the rest of Phase 2 is attributed to a **business date**, and the business date only moves here.

## What a business date is

The property runs on one date at a time. It is not "today": at 1 AM the desk is still working on
yesterday's date, and a charge added then belongs to yesterday's takings. `properties.current_business_date`
holds it, a trigger from migration `0001` refuses to move it backwards, and night audit is the only
thing that moves it forward.

## Shape of the feature

Two endpoints, deliberately split:

| | |
|---|---|
| `GET /night-audit` | **A read.** Runs every step's `inspect()` and returns what each one found: blockers, what it would post, warnings. Safe to poll; the desk screen lives on it. |
| `POST /night-audit/complete` | **One transaction.** Refuses with the list of blocking reasons, or runs every step, writes the run, advances the date, and emits the outbox events. |

The split matters because the things that block an audit — an arrival nobody checked in, a departure
nobody checked out — are fixed with ordinary desk operations, not inside the audit. Staff resolve
each row on the screen, and the screen re-reads. The audit itself is then a single atomic act.

## Steps, and why they are a registry

```ts
interface NightAuditStep {
  readonly name: string;                            // 'arrivals_not_checked_in'
  readonly title: string;                           // staff-facing
  inspect(ctx): Promise<StepReport>;                // read-only: blockers + what it would do
  run?(ctx): Promise<StepResult>;                   // inside the completion transaction
}
```

Steps are provided through a `NIGHT_AUDIT_STEPS` token, the same pattern as the outbox handlers.
**2.2 adds room-night posting by registering a step, with no change to this milestone's code**, and
2.4 adds the open-shift check the same way. The screen renders whatever is registered, so a
half-built Phase 2 shows an honest, shorter list rather than steps that silently do nothing.

Registered in 2.1:

| Step | Blocking? | Resolution offered |
|---|---|---|
| Arrivals not checked in | **Yes** | No-show · extend arrival to tomorrow · cancel (§15.2). A **tentative** booking offers only cancel and extend: it was never confirmed, so there is nothing to hold the guest to and the state machine in §12.3 has no tentative → no-show move. Each row carries the actions that actually apply, so the screen never offers something the server will refuse. |
| Departures not checked out | **Yes** | Check out · extend the stay |
| Room status check | No — warnings | An occupied room with no stay, or an in-house stay in a room marked vacant |
| Summary | No | Occupancy, arrivals, departures, in-house, no-shows for the closing date |

| Step | Arrives in |
|---|---|
| Open cashier shifts must be closed | 2.4 |
| Post tonight's room nights | 2.2 |
| Revenue and payments in the summary | 2.2, 2.3 |

`run()` must be **idempotent**, and the contract is enforced rather than trusted: the suite completes
an audit, then replays every step against the closed date and asserts nothing was posted twice.

## The three guarantees asked for

### 1. The advance is idempotent, and safe with two people at once

Five independent defences, because this is the one number the whole of Phase 2 hangs off:

1. **The caller names the date it is closing.** `POST /night-audit/complete` takes the business date
   the screen was showing, and the server refuses if the current date is different. This is
   optimistic concurrency, like `expectedVersion` elsewhere — and it is the defence that matters
   most. Without it, two people pressing Complete a moment apart close **two** days: the second
   request waits for the lock, reads the date the first one just advanced to, and closes that too.
   A concurrency test proves the date moves exactly one day however many requests race.
2. **`UNIQUE (property_id, business_date)` on `night_audits`.** One run per date, ever. Not an
   index for speed — the constraint *is* the idempotency, and a test closes a date twice with raw
   SQL to prove the database refuses it and not merely the application.
3. **`SELECT … FROM properties WHERE id = $1 FOR NO KEY UPDATE`** as the first statement in the
   completion transaction, so concurrent audits serialise.

   **Not `FOR UPDATE`.** Every table in the schema has a foreign key to `properties`, so every
   insert anywhere takes a `KEY SHARE` lock on that row; `FOR UPDATE` blocks those, and that is
   enough to deadlock. One transaction holds the property row and waits for the audit chain's
   advisory lock, while the transaction holding that lock waits to insert a row whose foreign key
   needs the property row. Six concurrent completions produced five `deadlock detected` errors,
   surfacing as "the system is busy" — safe, but wrong and confusing. `FOR NO KEY UPDATE` still
   conflicts with itself, so audits serialise exactly as intended, while unrelated inserts pass.
   The concurrency test now asserts no request is ever refused as busy.
4. **A compare-and-swap on the advance**: `UPDATE properties SET current_business_date = $closing + 1
   WHERE id = $1 AND current_business_date = $closing`. Zero rows means the date moved under us, and
   the run is refused rather than recorded against a date it did not close.
5. **The `guard_business_date` trigger** from `0001`, which refuses any backwards move.

On top of that the endpoint takes an idempotency key like every other mutation, so a double-tap or a
retried request returns the first result.

A request naming a date that is *already closed* is not an error: it gets that run back, with
`alreadyCompleted: true`. Six simultaneous requests therefore all succeed, one having done the work
and five being handed the answer they were asking for.

### 2. Every run is recorded — the old software's Day Audit Log

`night_audits` keeps who completed it, when it started and finished, and per step what it **posted**
and what it **skipped**, plus the closing summary.

**Both timestamps come from the database, never from the API process's clock.** `started_at` is
`transaction_timestamp()` and `completed_at` is `clock_timestamp()`, so the pair gives a real
duration and cannot disagree with each other. Taking `started_at` from `new Date()` broke the
`completed_at >= started_at` check the first time it ran on a machine whose clock differed from the
database's — the same failure mode as login throttling, which is why that does all its time
arithmetic in SQL too. A run is written on completion and never edited afterwards
(trigger + revoked UPDATE), so the log is evidence rather than a status field.

**Refused attempts are recorded too.** An attempt blocked at 11 PM by two unchecked departures is
exactly what the owner wants to see the next morning, so the refusal is written to `audit_logs` in
its own transaction before the error is raised — the same reason PIN failure counters are written
outside the business transaction.

### 3. Room-night posting will not double-post

The posting step lands in 2.2 with the folio. Its uniqueness is a **database constraint declared in
2.2's migration**, not application logic: unique on `(folio_id, room_id, business_date, line_type)`
for room-night lines. It cannot be created in this migration because `folio_lines` does not exist
yet, so it is written down here and in `docs/database.md` as a requirement 2.2 must satisfy, and the
replay test above is already in place to catch a step that ignores it.

## Locking a closed date

After completion, the closed date is history: corrections happen on the current date. Enforcing that
on folio lines needs 2.2's tables, so 2.1 ships the check the later milestones use:

```sql
is_business_date_closed(property_id uuid, on_date date) RETURNS boolean
```

true once a `night_audits` row exists for that date. 2.2's folio triggers and 2.3's payments call it
rather than each re-deriving what "closed" means.

## New this milestone

| | |
|---|---|
| `night_audits` | The run log. One row per closed business date. |
| `properties.receptionist_can_run_night_audit` | The owner setting from §35.2, defaulting to true. Added now to avoid a second migration when the settings screen arrives. |
| `is_business_date_closed()` | The shared definition of a closed date. |
| `POST /reservations/:id/no-show` | §15.2. The status already exists in the state machine; this is the transition, with a reason and the allocation released. Money attached to a no-show (refund, cancellation charge, credit) arrives with 2.3 — there are no payments to handle yet. |
| `POST /stays/:id/extend` | Needed by the departures step. Goes through `room_allocations`, so the exclusion constraint decides whether the extra nights are actually free. |

## Who may run it

Owner always; a receptionist only while `properties.receptionist_can_run_night_audit` is true
(§35.2, default true). The preview reports `mayRun`, so a receptionist who may not complete the
audit still sees the list and can clear it, rather than being shown a locked screen.

## What 2.1 deliberately does not do

- **No auto-reminder or dashboard banner yet** when the audit has not run by a set time (§35.2).
  That needs the owner settings screen for the time, and it is a notification, not a guarantee.
- **No revenue in the summary.** Occupancy and counts are real; money arrives with folios (2.2) and
  payments (2.3), each as its own step contributing its own facts.
- **No enforcement of the closed date on charges**, because there are no charges yet. What ships is
  `is_business_date_closed()`, the check 2.2 and 2.3 will call.
