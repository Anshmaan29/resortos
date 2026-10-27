# Real calendar dates and historical invoice date correction

Live properties now date reception, billing, invoices, payments, refunds, deposits, shifts,
expenses, receivables, maintenance defaults and housekeeping using their actual local calendar.
The date advances automatically at midnight in the property's configured timezone. The legacy
`businessDate` API name remains compatible but returns the actual operating date. Demo replay
fixtures retain their chosen date.

The stored `current_business_date` is solely the day-end review cursor. Day-end review keeps its
history and ordered catch-up, but no longer controls transaction dates. A live calendar day cannot
be reviewed into tomorrow before midnight. The header no longer displays a competing "Day closing"
date. Housekeeping's SQL and automatic cleaning-task trigger use the same live calendar.

Room-night service dates, booked arrival/departure dates and historical review entries are not
changed. Charge/payment forms retain their explicit actual historical-date input and existing
validation; an explicit service/payment date is different from the old lagging default.

The invoice list now includes the original booking and room references beside each invoice number.
Its date filters and PDF use the same stored invoice issue date.

## Owner-authorised historical correction

The 28 October live inventory found 13 Laxmi Palace invoices whose invoice_date did not match
finalized_at in Asia/Kolkata. Villa Sol's two invoices already matched. No live payments, expenses,
shifts, company receipts or OTA payout dates needed correction. Room-night lines correctly refer
to the service nights and must not be redated to invoice creation time.

The operator tool is separate from the runtime API:

```
node -r ./scripts/swc-register.cjs scripts/invoice-date-repair.ts --plan /private/reviewed-plan.json
node -r ./scripts/swc-register.cjs scripts/invoice-date-repair.ts --apply /private/reviewed-plan.json
```

Run from apps/api with the verified production MIGRATION_DATABASE_URL in the operator environment.
Never paste credentials into commands/chat. Take and restore-verify an encrypted pre-release
backup, review the complete manifest, and compare protected rows before/after applying.

The plan contains IDs, invoice numbers, old/new dates and non-date hashes, with no guest contact
information. Apply requires resortos_migrator, a short invoice-writer lock that allows reads and yields to active writes, exact matches
against the reviewed rows and unchanged financial year. Only invoice_date changes. Numbers,
amounts, GST, buyer/seller data, payment snapshots, issue timestamps, invoice lines, service dates,
bookings and room allocations retain their original values. Any mismatch/audit failure rolls back
both the change and trigger state. Repeating the same manifest changes nothing a second time.

The existing immutable trigger is suspended only inside the guarded, locked operator transaction,
then restored before commit. The runtime role gains no new permissions or repair endpoint. Every
correction appends a hash-chained audit entry and an informational outbox event; no guest message
is resent. Previously delivered email/WhatsApp attachments cannot be replaced on a guest's device;
new downloads use the corrected date.

## Verification

Tests cover real-date reception while review is behind; shifts, charges, payments, invoices and
housekeeping using the real date; midnight/timezone boundaries; review refusing to advance today's
calendar; and reviewed historical repair, tamper rejection, full rollback, active-writer/audit-lock contention, preserved invoice fields
and parts, repeat safety and restored ordinary invoice immutability. Run the complete build/type,
API/web/shared, operations, security and desktop/phone browser suites before release. Production
acceptance compares all protected pre-existing records, allows only the reviewed date changes,
checks migration 0032 and property-local dates, and verifies live health without real test bookings.

Release also pins the current patched Zod, body-parser, Multer and qs versions required by the
security gate. No advisory exception is introduced.
