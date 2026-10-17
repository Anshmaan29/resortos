# ResortOS QA audit - 17 October 2026

The tested reception and backend workflows pass with the fixes in this release. Production
recovery is **not signed off**: a real off-site backup and successful restore still need evidence.
The configuration items below also remain with the owner/accountant.

## Safety and scope

- All booking, guest, document, payment, room-status and checkout test mutations used disposable
  local PostgreSQL databases and MinIO. Local messaging used the development provider.
- Production inspection used read-only SQL and object metadata requests. No test booking, guest,
  payment, email or WhatsApp message was created in either live property.
- The release changes application behaviour and restore verification; it has no migration or
  production data-repair script. Issued invoices, stored PDFs and agreed booking prices are retained.
- Protected production snapshots cover 20 configuration/operational tables in each property,
  including bookings, per-night prices, guests, documents, stays, bills, payments and invoices.
  Release verification compares existing row hashes rather than just record counts.

## Defects reproduced and fixed

| Defect | Corrected behaviour | Regression evidence |
| --- | --- | --- |
| A reservation spanning multiple days could appear Ready after its arrival date | A still-reserved room is Arrival pending and cannot be sold as vacant | Hotel and Villa room-board tests |
| A combined Villa booking did not protect Room 2 from deactivation or scheduled maintenance | Setup and maintenance checks include every physical room used by the booking; Villa saves share a property lock | Secondary-room protection and simultaneous booking/maintenance tests |
| Night audit could call occupied Room 2 empty and miss its maintenance warning | Both physical Villa bedrooms are counted using the occupancy projection; overdue in-house hotel guests are also retained | Combined-room dirty/maintenance test |
| An inactive Villa bedroom could pass availability and arrival checks | Every required physical bedroom must exist, be active and satisfy readiness checks | Inactive-bedroom availability/arrival test |
| Combined Villa documents could name only the primary bedroom | Newly generated room charges, invoice stay details, receipts and registration cards say 1 + 2; the price is charged once | Combined billing/invoice assertions, GRC generation and rendered PDF samples |
| Restore verification treated independent Room 1/Room 2 bookings as overlaps | Overlap findings require an intersection of the booked resources as well as overlapping time | Integrity SQL run against the independent-bedroom fixture |

## Automated verification

| Check | Result |
| --- | --- |
| Workspace build and typecheck | Pass |
| Shared pricing, schemas, GST and money checks | 44 passed |
| Frontend unit, accessibility-token and contrast checks | 108 passed |
| Backend integration suite, real PostgreSQL 16 and MinIO | 427 passed in 41 files |
| Same backend suite, real PostgreSQL 18 and MinIO | 427 passed in 41 files |
| Operational regression suite | 25 passed on PostgreSQL 16; 25 on PostgreSQL 18 |
| Railway process-launcher checks | 4 passed |
| Desktop/phone browser end-to-end suite | 22 passed |
| Dependency gate | 493 dependencies scanned; no unaccepted high/critical advisories |
| Git whitespace check | Pass |

The backup integration suite completed encrypted dump/upload/download/restore and integrity
verification on both PostgreSQL versions. PostgreSQL 18 used its matching container client tools.
Those disposable tests do not establish production recovery readiness.

The backend suite covers authentication and PIN authorisation, stale edits and idempotency,
concurrent capacity/room allocation, custom prices and GST, check-in documents and storage hashes,
room moves/extensions, bill lines/discounts, split payments/deposits/refunds/reversals, immutable
invoices and correction notes, hotel shifts, Villa cash without shifts, housekeeping, maintenance,
night audit, companies/OTA/expenses, compliance exports, messaging/webhook signatures, retries,
outbox failures, privacy projections and backup integrity.

Additional property-boundary probes checked guest, booking, stay, draft, bill, payment receipt,
invoice and document access from the wrong property. A hotel receptionist was refused access to
Villa through both headers and download query context across 17 API areas. Empty child collections
return no other property's data. Existing hotel rows remain unchanged in the Villa integration suite.

## Browser and document inspection

66 additional screen/viewport checks completed without JavaScript errors or horizontal page
overflow: 21 hotel pages, all 12 hotel Settings sections, 19 Villa pages/detail views, and 14
phone-viewport pages. Desktop page sweeps also recorded no failing API responses.

Screens covered home, booking creation/list/detail, express check-in, guest list, in-house stays,
calendar, rooms, housekeeping, Form C, maintenance, shifts, night audit, owner review, accounts,
invoices, companies, OTA payouts, expenses, records and settings as applicable to each property.

The separate browser Villa flow saved two different guests into Room 1 and Room 2 for the same
dates, then verified that an overlapping pool booking was unavailable. Villa shows two physical
room cards and no Shift navigation. Switching properties resets the workspace correctly.

The end-to-end suite exercised full document capture, registration-card generation, room changes,
split card/UPI payments and checkout, automatic booking-message consent/preferences, duplicate
guest prevention, owner PIN entry, booking edits/cancellation, room dropdowns, GST settings,
shared-desk locking and phone navigation.

Sample combined Villa invoice, receipt and registration card were rendered and visually inspected,
along with a hotel registration card. Branding, both-room labels, amounts and page layout passed.
Existing stored documents were not regenerated in production.

## Live read-only findings

- Database integrity SQL returned no findings. The runtime account cannot delete guests or update
  audit logs. Production has secure cookies, real property data origins and no active demo logins.
- All 35 referenced verified guest-document/GRC objects had matching stored sizes. An unsigned
  request was refused with HTTP 403. This metadata check does not re-download every live ID image.
- The message outbox had zero pending and zero dead-lettered events. Both properties had zero
  messages recorded as failed. This is current queue evidence, not a new live delivery test.
- The live database reported PostgreSQL 18.6 with native WAL archiving off. The connected Railway
  project showed the app and database in one region, and no separate backup service. The app had
  no backup scheduling variables. Provider volume snapshots or backup systems outside this project
  were not established by these checks.

## Items still requiring operational setup

| Item | Finding and action |
| --- | --- |
| Production recovery | Verify provider backups/PITR, an independent off-site copy, offline key custody, alerts and a real restore drill. Use client tools compatible with PostgreSQL 18. Record evidence in `production-readiness.md`. Until then, recovery readiness remains unresolved. |
| Villa staff | No active Villa receptionist yet; the owner previously chose to add staff in Settings. Hotel reception access remains confined to the hotel. |
| Villa payments | Only Villa's cash account is active. Add the owner's intended UPI/bank/card destinations before recording those payment methods. |
| Activity/food tax rules | Both properties currently have only an accommodation rule. Configure accountant-confirmed Activity GST/SAC before pool/garden invoices, and food rules before billing separate meals. Per-booking GST percentages do not replace a missing service/SAC rule. |
| Villa WhatsApp | Deferred by the owner's earlier instruction. Villa email is configured separately; its WhatsApp sender must be connected before promising WhatsApp delivery for Villa. |

This audit is a broad regression and workflow check, not a guarantee against all future faults.
Browser coverage used Chromium desktop/phone viewports; physical-device camera behaviour, vendor
outages, security penetration testing and a real off-site disaster-recovery drill are separate checks.

Reproduce the checks with `pnpm build`, `pnpm typecheck`, `pnpm test`,
`pnpm --filter @resortos/api exec vitest run --config vitest.audit.config.mts`,
`pnpm exec playwright test` and `node ops/ci/audit.mjs` against disposable local infrastructure.
Never point the seed/reset fixtures at production.
