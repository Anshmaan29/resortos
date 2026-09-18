# Parity with the old software

Checked against the old system's menu and its check-in form, item by item, so nothing the resort
uses today quietly disappears. Status is as of milestone 1.8.

Legend: **Done** works today · **Planned** has a milestone · **Gap** was missing from the plan and
has now been placed.

---

## 1. Menu

| Old menu item | Where it lives here | Status | New table? |
|---|---|---|---|
| Dashboard | Reception home: arrivals, departures, in-house count, room board, needs-attention | **Done** (1.7) | — |
| Room Service Items | Saved charge items — the quick-pick list behind "Add charge" (spec §24.2). Not a restaurant system | **Planned** 2.2 | `charge_items` |
| Reservations | Bookings list, calendar, availability search | **Done** (1.6, 1.7) | — |
| Create Check In | Check-in wizard with server-side drafts | **Done** (1.8) | — |
| Check In List | A list of in-house stays. Home shows only a *count* and the room board | **Gap** → 1.9 | — (view over `stays`) |
| Booking Reports | Records area → Bookings, with Excel/PDF | **Planned** 3.1 | `export_logs` |
| Today's Arrivals | Reception home | **Done** (1.7) | — |
| Today's Departures | Reception home | **Done** (1.7) | — |
| Reports | Records area + owner daily summary + revenue dashboard | **Planned** 3.1, 3.7 | `daily_metrics` |
| Ledger Entries | Account-wise ledger over payments and expenses, plus the company ledger | **Planned** 2.4 | `payment_accounts`, `company_ledger` |
| Customers | Guests screen: search and profile with stay history | **Gap** → 1.9 | — (`guests` exists) |
| Payment Transactions | Payments list with method, reference, account, shift | **Planned** 2.3 | `payments` |
| Room Status Log | `room_status_history` is written on every change; no screen yet | **Gap (screen)** → 3.3 | — (table exists) |
| Room Shift Log | `room_shifts` is written and shown on the stay; no property-wide list | **Gap (screen)** → 1.9 | — (table exists) |
| Day Audit Log | Night audit run history and its summary | **Planned** 2.1 | `night_audits` |
| Rooms Inventory | Owner settings: rooms, room types | **Planned** pre-pilot #1 | — (tables exist) |

**Nothing in the old menu is unaccounted for.** Four items were genuinely missing and now have a
home; three of those are screens over data we already store correctly.

---

## 2. Check-in form fields

| Old field | Here | Status |
|---|---|---|
| Fetch customer by mobile | `GET /guests?q=` — mobile, name, booking number, OTA reference; plus a duplicate warning before creating | **Done** |
| Guest first / last name | `guests.first_name`, `last_name` | **Done** |
| Mobile | `guests.mobile`, E.164, Indian validator | **Done** |
| Email | `guests.email` | **Done** |
| Address | `guests.address_line` | **Done** |
| Country | `guests.country` (+ `nationality`, which drives Form C) | **Done** |
| Pincode | `guests.pin_code`, 6-digit validator | **Done** |
| City | `guests.city` | **Done** |
| State | `guests.state` | **Done** |
| **Purpose of visit** | — nowhere | **Gap** → 1.9 |
| GSTIN | `guests.company_gstin`, checksum-validated | **Done** |
| Company name | `guests.company_name` | **Done** |
| Check-in date | `reservation_rooms.arrival` | **Done** |
| Check-out date | `reservation_rooms.departure` | **Done** |
| Days | Derived (`nightsBetween`) — never stored, so it cannot disagree | **Done** |
| Source | `reservations.source` + `ota_reference` | **Done** |
| Meal plan | `reservation_rooms.meal_plan` (EP/CP/MAP/AP) | **Done** |
| Adult count | `reservation_rooms.adults` | **Done** |
| Child count | `reservation_rooms.child_ages` — ages, not just a count, because child pricing needs them | **Done** |
| Number of rooms | One `reservation_rooms` row per room | **Done** |
| Remarks / additional instructions | `reservations.special_requests` (guest-facing) and `internal_notes` (staff) | **Done** |
| Room type | `reservation_rooms.room_type_id` | **Done** |
| Room | `reservation_rooms.room_id` + `room_allocations` | **Done** |
| Tariff | `reservation_rooms.nightly_rate` + per-night `reservation_room_nights` | **Done** |
| Grand total | Live GST estimate now; the real bill is the folio | **Planned** 2.2 |
| **Payment account** | — nowhere | **Gap** → 2.3 |
| Amount | Advance at check-in | **Planned** 2.3 |
| Balance | Folio balance, recalculated from lines | **Planned** 2.2 |
| Guest photo | `guest_documents`, checksum-verified | **Done** |
| ID proof front | `guest_documents` | **Done** |
| ID proof back | `guest_documents` | **Done** |
| Vehicle numbers | `stay_vehicles`, Indian format validated | **Done** |

Two gaps: **purpose of visit** and **payment account**. Everything else is already captured, and in
several places more precisely than the old form (child *ages*, per-night rates, separate guest-facing
and internal notes).

### Purpose of visit

A short list plus free text — Business, Leisure, Family function, Medical, Pilgrimage, Conference,
Other — stored on the reservation, not the guest: the same guest visits for different reasons.
Column on `reservations`, no new table. It is also the natural input for the Form C "purpose of
stay" field in 3.5, so it earns its place twice.

---

## 3. The three gaps you named

### (a) Payment accounts — decided now, because it shapes the Phase 2 schema

The old software posts money to an *account* (cash counter, HDFC current, UPI), not merely a method.
Getting this wrong later means rewriting `payments`, so it goes in from the first Phase 2 migration.

```
payment_accounts
  id, property_id
  name              'Cash counter', 'HDFC current', 'UPI — resort QR'
  kind              cash | bank | upi | card_pos | other
  bank_name, account_last4, upi_handle, pos_terminal    -- never a full account number
  opening_balance   NUMERIC(14,2)
  is_active, sort_order, version
```

- `payments.payment_account_id` and `expenses.payment_account_id` reference it.
- **Method stays too, and is not redundant.** `method` is what the spec requires and drives which
  reference is mandatory (§25.1); the account is *where the money landed*. A CHECK keeps them
  consistent, so UPI money cannot be posted to the cash counter.
- Nullable for the two settlement types that move no money: **company account** and **guest credit**
  are ledger transfers, not receipts. The same CHECK enforces that.
- **Balances are never stored.** Account balance = opening + receipts − refunds − cash expenses,
  recalculated from rows, with the integrity job comparing any cached copy (spec §49).
- Cashier shift close reconciles per account: the cash counter against the counted cash, the card
  account against the POS settlement slip.
- "Ledger Entries" becomes an account statement — the same rows, grouped by account.

### (b) Guests screen — Phase 1, next up

Sidebar entry, search by mobile / name / booking / **vehicle**, profile with stay history, documents
(permission-controlled) and notes. `guests` already exists; vehicle search needs a join to
`stay_vehicles`, which is already indexed on `(property_id, registration)`. No new table.

### (c) Express check-in — after the pre-pilot items

One screen for a walk-in by experienced staff: guest, room, dates, documents, confirm. Same server
validation, same Owner PIN limits, same audit and idempotency — it is a different *screen* over the
same check-in draft and confirm path, not a second code path. The wizard stays the default.

---

## 4. Everything new this report adds

| Milestone | What | New tables |
|---|---|---|
| **1.9 Guests & the lists the old software had** | Guests screen + sidebar, Ctrl+K global search, in-house (Check In List), room-shift log, purpose of visit | none — one column on `reservations` |
| 2.3 Payments | Payment accounts from day one | `payment_accounts` |
| 3.3 Operations | Room status log screen | none |
| After pre-pilot | Express check-in | none |

Only **one** new table comes out of the whole parity exercise (`payment_accounts`); everything else
is screens over data the schema already holds, or a single column. That is a good sign about the
schema, and it is why the payment-account decision is the one worth making before Phase 2 starts.
