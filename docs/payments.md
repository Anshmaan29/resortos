# Money — payments, deposits, shifts, companies and OTAs (milestones 2.3, 2.4, 2.5, 2.7)

Spec §25–§28, §32–§34. Staff-facing words: "Bill", "Payment", "Shift". ResortOS **records** money; it
never processes it (CLAUDE.md rule 15). Card payments happen on the resort's own POS machine and UPI
through its QR — what this code has to get right is bookkeeping: where the money landed, who took
it, on which business date, in whose shift, and what was done when it was wrong.

## The four rules

1. **Nothing is ever edited.** A wrong payment is *reversed* by a new row that points at it
   (`reverses_payment_id`), at most once (`payments_one_reversal`). The original keeps its numbers
   for ever; "reversed" is derived from the reversing row existing, never stored. Same for company
   receipts and OTA payouts. UPDATE is revoked from the API role and a trigger refuses it anyway.
2. **No balance is stored.** What a bill has been paid, the deposit held, what an account holds, what
   a company owes — all are sums of rows, recalculated on every read (§49). The one cached figure is
   what a closed shift was *judged against* (below), and the nightly integrity check recalculates it.
3. **Method and account are both kept, and must agree.** The method says how it was paid and drives
   the reference the desk must capture; the account says where it landed. A CHECK ties them, backed
   by a composite foreign key to the account's kind, so UPI money cannot be posted to the cash counter
   even by hand.
4. **Cash belongs to a shift.** A cash payment cannot exist without the open shift of the person who
   took it — CHECK `payments_cash_in_shift` plus trigger `guard_payment_shift`. A closed shift takes
   nothing more.

## What a payment row does

`entry_type` and `method` decide three database-computed effects (`GENERATED ALWAYS … STORED`), so
the row can never disagree with itself:

| Entry | Bill effect | Deposit effect | Cash effect |
|---|---|---|---|
| `payment`, `advance` | + | | + (if an account) |
| `refund` | − | | − |
| `deposit` | | + | + |
| `deposit_refund` | | − | − |
| `deposit_adjustment` (method `deposit`) | + | − | 0 — the money was already banked |

A reversal negates all three. "Paid" on the bill is the sum of bill effects; the deposit held is the
sum of deposit effects; the account ledger and the shift add up cash effects.

**Settlements that move no money** — `company_account`, `ota_prepaid`, `guest_credit`,
`deposit` — take no account: they settle the bill against a receivable, a credit or a deposit.
`company_account` must name the company (`payments_company_when_company_account`).

## Advances (§26)

Taken on the booking before arrival, when there is no bill, so `folio_id` is null. The view
`payment_folios` makes such a payment count on the reservation's first stay bill once there is one —
derived, so no payment row is ever re-pointed. If the booking is cancelled, the desk must decide what
happens to the advance: "keep as guest credit" writes a real entry in `guest_credit_entries`;
"refund" is then recorded as a refund against the booking, which needs Owner PIN like every refund.

## Security deposits (§27)

Held, not paid: a deposit never reduces the balance and is not income. At checkout it must be
decided before the stay can close (`DepositCheckoutStep`): the parts applied to the bill and given
back must add up to what is held. The two ordinary outcomes — give it all back, or apply what the bill
owes and give back the rest — need nobody. Any other split means keeping money the bill does not
explain, and needs the owner (`deposit_part_refund`).

## Corrections (§25.4)

| When | Who may reverse |
|---|---|
| Same business date, own entry | The person who took it |
| Someone else's entry, or a date night audit has closed | Owner PIN |

The reversal is dated *today*: the correction happens now, not in the closed past. Reversing a use of
guest credit gives the credit back in the same append-only ledger.

## Cashier shifts (§34) — milestone 2.4

`cashier_shifts` arrived with 2.3 so the very first payment could belong to a shift. Open with the
cash in the drawer; close with what was counted and, if there is a card machine, its settlement slip.
Expected cash = opening cash + the cash effects of every cash-account row in the shift, summed from
`account_ledger` — the same rows the account ledger shows. A difference above the owner's threshold
(`properties.cash_difference_threshold`, default ₹100) needs a reason, and so does any card slip
difference. A closed shift is locked by trigger.

Closing locks the shift row first; inserting a payment takes a share lock on it. So a payment either
lands before the totals are summed or is refused as "shift closed" — never counted in neither.
Night audit will not close a day with a shift still open (`OpenShiftsStep`, blocking).

`account_ledger` is a view over every table that moves money through an account — payments,
company receipts, OTA payouts, and expenses when they arrive in Sprint C. The ledger screen and the
shift never need to know where a row came from.

## The owner review list (§34.4)

Derived from the records every time: Owner PIN overrides, discounts above
`properties.review_discount_percent`, removed charges, reversed payments, cash differences above the
threshold, credit notes, and guests who checked out owing money. The only thing stored is that the
owner has seen an item (`owner_review_seen`, append-only). With no dates it is a to-do list of
everything unseen.

## Discounts (§28) — milestone 2.5

A discount is a negative bill line that **points at the charge it discounts**
(`applies_to_line_id`). It is never a free-floating bill discount, because GST on a room night is
decided per room per night on the value *after* discount (§30.2): a ₹1,000 discount on an ₹8,000
night moves it from 18% to 5%, and the engine only sees that if the discount is attached to that
night. A discount on the whole bill is spread across the charges in proportion, to the paisa, and the
parts share a `discount_group_id` so they are shown and removed as one.

The preview (`POST /folios/:id/discounts/preview`) saves nothing and shows the amount, the share of
the bill, whether the owner is needed, and every night whose GST rate changes. Above the
receptionist's `discount_limit_percent` it needs Owner PIN, approved against the exact parts. The
database refuses a discount larger than its charge, a discount of a discount, and removing a charge
that still has a discount on it.

## Company accounts (§32) — milestone 2.7

A bill moved to a company is a `company_account` payment naming the company; the invoice is then
made out in the company's name and GSTIN. What a company owes is `company_outstanding()`: bills moved
to it less `company_receipts`. Past the credit limit, moving a bill needs Owner PIN. The statement
runs a balance and ages what is owed **oldest first** (payments against an account, not a named
invoice, settle the oldest bills — the usual rule).

## OTA bookings (§33) — milestone 2.7

`ota_bookings` holds the commercial side of a booking from an OTA — value, commission, TCS/TDS as
the CA advises — with the expected payout computed by the database. `ota_payouts` records what
actually arrived, into a bank account. The receivables report lists every OTA booking, including those
whose terms nobody has entered yet, so nothing is missed. The guest's invoice always shows the full
room value.

"Availability changed today" is built from the `inventory.changed` events the outbox already records
for every booking, cancellation, extension and out-of-order — nothing new for anyone to remember.

## Known limits

- **Receipt vouchers for advances.** An advance is printed as a receipt with its `PAY-` number. The
  GST treatment of advances (a receipt voucher in the `RV` series, and tax on it) is a setting the
  spec leaves to the resort's CA (§26); the `RV` series exists in `document_counters` but nothing
  issues one yet.
- **Cancellation charges.** "Cancellation charge" and "partial refund" are recorded on the booking.
  Turning a kept advance into invoiced revenue is not built yet.
