# GST invoices, credit and debit notes, printing (milestones 2.6 and 2.8)

Spec §22, §29–§31, §36.

## Three rules

1. **An invoice exists only once it is final.** There is no draft row. The draft *is* the bill, and
   `POST /folios/:id/invoice/preview` computes exactly what finalization would write, less the number.
   The number is taken from `document_counters` inside the transaction that writes the invoice, so a
   rollback gives it back and the series never skips (§31). Bills finalized at the same moment get
   consecutive numbers — tested with concurrent checkouts.
2. **An issued document never changes.** `invoices`, `invoice_lines`, `invoice_tax_groups` and
   `invoice_payments` refuse UPDATE and DELETE (trigger, and UPDATE is revoked from the API role). Their
   parts can only be inserted in the transaction that created the invoice
   (`guard_invoice_part_insert` compares the invoice row's `xmin` with the current transaction), so
   nothing can be added afterwards either. A bill line on an issued invoice can no longer be voided.
3. **The totals are checked at commit.** A deferred constraint trigger refuses to commit an invoice
   whose header, lines and tax groups disagree by a paisa, or that has no lines.

## Numbers

`INV/26-27/00001` — series, financial year (April start), five digits; never more than 16 characters.

| Series | Document |
|---|---|
| `INV` | Tax invoice (property has a GSTIN) |
| `BOS` | Bill of supply (no GSTIN — no tax at all) |
| `CN` | Credit note |
| `DN` | Debit note / supplementary invoice |
| `RV` | Receipt voucher — reserved, see `docs/payments.md` |

## GST on an invoice

Every charge is one line, **net of its discounts**, taxed at the rate that net value attracts on the
line's own date of supply (the rule valid that day). That is what makes both of these right:

- a discount that moves a room night across the ₹7,500 slab moves its rate (§30.2);
- a rate change in the middle of a stay applies to each night by its own date (§30.6).

Tax is computed per rate group and rounded to the paisa; the total is rounded to the rupee with the
round-off as its own line (§30.5). Place of supply is the property's state — accommodation is
supplied where the property is — so tax is CGST + SGST. The invoice keeps the seller's and buyer's
details as they were on the day; a later change to the property's address does not rewrite it.

## Checkout (§22)

Billing registers three steps on the checkout pipeline 1.8 left for it:

| Order | Step | Blocks when | On confirm |
|---|---|---|---|
| 15 | `deposit` | a security deposit is still held | — |
| 20 | `settlement` | money is owed, or overpaid | owner-authorised pending balance recorded |
| 80 | `invoice` | — | invoice issued, bill closed |

All of it runs in the checkout transaction. A guest may leave owing money only with the owner's
authorisation, recorded as an override and shown on the owner review list. A bill with nothing on it
gets no invoice.

## Corrections

- **Credit note** — owner only, reason required. The whole invoice (which is how an invoice is
  cancelled), or chosen lines by amount. Credited at the rate the line was invoiced at, never at
  today's rules, and never more than was sold (trigger `guard_credit_note_line`). A full credit note
  equals the original to the paisa.
- **Debit note** — a charge found after checkout (the minibar, a damage) is added by the owner to the
  closed bill and goes on a debit note against the invoice. If the bill was never invoiced because it
  was empty, the late charges get an invoice of their own.

## Printing (§36)

Server-side PDFs with pdfkit and the same pinned font as the registration card:

| Document | Endpoint | Paper |
|---|---|---|
| Invoice / credit / debit note | `GET /invoices/:id/pdf` | A4 |
| Receipt | `GET /payments/:id/receipt.pdf?paper=` | A4 or 80 mm thermal |
| Shift report | `GET /shifts/:id/report.pdf?paper=` | A4 or 80 mm thermal |

**Every render is a pure function of its input** — no clock, no random id — so the same document
always prints the same bytes (tested). That is what will let the Drive archive in Sprint D check a
stored copy against a fresh render. PDFs are served `Cache-Control: private, no-store`. The guest's
mobile is masked on printouts unless the owner turns that off (`properties.print_mask_mobile`); the
default receipt paper, invoice terms and bank details are property settings (`0019`), edited on the
owner settings screens in Sprint B.

## Restore verification

`ops/backup/integrity.sql` now also checks, on a restored copy: no gap in any invoice series, every
invoice's lines add up to its header, no document counter behind the documents it numbered, every
reversal matching what it reverses, and every closed shift still adding up to what it was closed
against.
