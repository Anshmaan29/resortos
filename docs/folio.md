# The bill — folios and charges (milestone 2.2)

Spec §23, §24, §4.5. Staff-facing word is **"Bill"**, never "folio" (CLAUDE.md conventions); "folio"
appears in the schema and in this document because that is what the table is called.

## What a bill is

One running bill per stay. Every charge that will end up on the invoice lands here first, attributed
to the **business date** it belongs to — which is why 2.1 came first. Payments are recorded against
the same bill in 2.3, and the invoice in 2.6 is a frozen copy of it.

```
BILL F-000123 · Room 204 · Rahul Sharma        Business date 17 Sep 2026

16 Sep  Room — Deluxe                ₹4,000
16 Sep  Breakfast (CP)                 ₹800
16 Sep  Paneer Tikka × 2               ₹560
17 Sep  Room — Deluxe                ₹4,000
17 Sep  Jeep Safari × 2              ₹3,000
        Laundry                        ₹300   voided — added to the wrong room
                                   ─────────
Charges before tax                  ₹12,360
GST (estimated)                        ₹...
Balance                                ₹...
```

## The three rules that shape the schema

### 1. A line is never edited

A mistake is **voided** with a reason and re-added correctly (§23). The voided line stays visible.
This is enforced by a trigger, not by discipline: the only `UPDATE` a folio line accepts is the one
that voids it, once. Everything else is refused.

Why so strict: a bill is the document a guest is shown and an invoice is later built from. "The
amount changed and nobody knows when" is exactly the failure the audit log exists to prevent, and a
line that can be edited quietly makes the audit log a second source of truth rather than the record
of a change.

Who may void, from §4.5:

| When | Who |
|---|---|
| Same business date, before the bill is invoiced | Receptionist, with a reason |
| After night audit has closed that date | **Owner only** — the day has been summarised and reported |

The "after night audit" test is `is_business_date_closed()`, shipped in 2.1 for exactly this.

### 2. Balances are never stored

Balance is `charges + tax − payments`, recalculated from the lines every time (your decision, and
spec §49). No `folios.balance` column exists to drift. The nightly integrity check in 2.4b compares
a recalculated balance against the sum of rows, **reports** differences and never repairs them.

### 3. Room nights post once per room per business date

The constraint you asked for, as a partial unique index:

```sql
CREATE UNIQUE INDEX folio_lines_one_room_night
  ON folio_lines (folio_id, room_id, business_date, line_type)
  WHERE source = 'night_audit' AND voided_at IS NULL;
```

Partial on `voided_at IS NULL` on purpose: a wrongly posted room night can be voided and re-posted,
which a plain unique index would make impossible. The night audit step relies on this index rather
than on checking first — a check-then-insert is a race, a unique index is not. 2.1 already ships the
test that replays every step against a closed date and asserts nothing posts twice; this is the
milestone that gives it something to catch.

## Tables

```
folios
  id, property_id, number            F-000123, from reference_counters (never a SEQUENCE)
  stay_id                            one bill per stay; null on a group master bill
  reservation_id
  kind                               stay | group_master
  status                             open | closed        closed at checkout or invoicing
  opened_at, opened_by, closed_at, closed_by, version

folio_lines                          append-only apart from the single void
  id, property_id, folio_id
  business_date                      the date it belongs to, not when it was typed
  line_type                          room_night | extra_person | meal | food | beverage | activity
                                     | laundry | transport | early_checkin | late_checkout
                                     | damage | other | discount
  name                               exactly as it appears on the invoice ("Paneer Tikka")
  quantity, unit_rate, amount
  tax_category, sac                  drives GST; the receptionist never picks a rate (§24.3)
  source                             manual | night_audit | import
  room_id, charge_item_id, note
  created_at, created_by
  voided_at, voided_by, void_reason, authorised_by

charge_items                         the quick-pick list behind "Add charge" (§24.2)
  id, property_id, name, line_type, default_rate, tax_category, is_active, sort_order, version
```

`charge_items` is the old software's **Room Service Items** (parity report, §24.2) — a list, not a
menu system. No kitchen tickets, no stock, no restaurant login (CLAUDE.md rule 16). Typing a name
that is not on the list is always allowed; the owner can save it afterwards.

## Room nights: three lines, not one

`reservation_room_nights` already stores `room_rate`, `extra_person_amount` and `meal_amount`
separately for every night, at the rates agreed when the booking was made — including a rate the
owner authorised below the floor. Night audit posts each non-zero part as its own line:

| Part | Line type | Tax category |
|---|---|---|
| `room_rate` | `room_night` | accommodation |
| `extra_person_amount` | `extra_person` | accommodation |
| `meal_amount` | `meal` | food |

They cannot be one line because **GST differs**: accommodation is slab-rated on the per-room-night
value, food is not (§30). Merging them would either mis-rate the food or mis-slab the room. It also
means the guest sees "Room — Deluxe ₹4,000" and "Breakfast (CP) ₹800" on the bill, which is what
they expect to see, and the unique index above keys on `line_type` so the three coexist.

## Tax on the bill is an estimate

The bill shows GST computed by the existing engine (`packages/shared/src/gst.ts`) from the dated
`tax_rules`, per line, by category and date of supply. It is labelled an **estimate** until the
invoice is finalised in 2.6, because until then rates can still change for a future date and lines
can still be added. Nothing about the tax is stored on the line beyond `tax_category` and `sac`:
storing a computed tax amount would be a second place for it to be wrong.

## What came after 2.2

Payments, deposits and shifts (2.3, 2.4): `docs/payments.md`. Discounts attached to the charge they
reduce, so GST follows the net value (2.5): `docs/payments.md`. The invoice, credit and debit notes,
and printing (2.6, 2.8): `docs/invoices.md`. A closed bill still takes a payment, and the owner can add
a late charge, which goes on a debit note. Group master bills are still not created — the `kind`
column and the nullable `stay_id` are ready for them.
