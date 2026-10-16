# Villa Sol: second-property integration

Status: approved scope implemented locally; release and controlled provisioning follow verification. See `villa-sol-handover.md` for the current operating rules and setup boundaries.

## Requested result

- A property selector where the sidebar currently shows the Laxmi Palace name.
- Separate workspaces for Laxmi Palace by Voitto and Villa Sol by Voitto.
- Villa Sol in Kaithun, Kota, with reception number +91 9352204825.
- Villa bookings for a single bedroom, both bedrooms, pool, garden or whole villa.
- Custom prices, guest records, arrival/departure, billing, payments, documents, reports,
  automatic email and WhatsApp, with property-appropriate wording.
- Preserve Laxmi Palace's existing bookings, prices, rooms, guests, documents and accounts.

The owner describes a two-bedroom villa with a swimming pool and garden. The
[MakeMyTrip listing](https://www.makemytrip.com/hotels/villa_sol_by_aachho-details-kota.html)
also describes two bedrooms, a private pool and seven guests; its address is Abhaypura,
Kota–Sangod Road, Kaithun. It lists 13:00 check-in and 11:00 checkout. These are references,
not approved software settings. The supplied Google share link could not be read through
the browsing tool.

## Confirmed decisions

Every booking makes the entire property private. Both-bedroom and whole-villa bookings
include pool and garden. Reception enters times, guest count, agreed price and GST.
Pool/garden visits do not collect ID, photos or signatures. Only owners switch properties.
Villa reception staff have separate logins created by the owner. The owner also configures
non-cash payment destinations. Villa starts with a separate cash counter at zero balance.
The owner/accountant will configure the activity tax rule and SAC before pool/garden invoices.

Use Kaithun, Kota 324001, reception +91 9352204825 and email
`reception@voittoventures.com`. Legal business/GSTIN matches Laxmi Palace. Villa WhatsApp
sender and Wi-Fi remain unconfigured until supplied. Overnight defaults are editable
13:00 / 11:00; actual booking times are entered on the form.

## Findings in the current source

| Area | Current behavior | Required extension |
|---|---|---|
| Identity | `users.property_id` is the login's property; authentication reads that value | Explicit property access grants; validate every request against them |
| Database | Business tables carry property IDs; many use composite foreign keys | Preserve isolation for every new table and relationship, not just filtered screens |
| Client | Query keys such as `property`, `guest-search` and `availability` are not property-specific | Separate caches, drafts, pending requests and navigation when switching |
| Inventory | Rooms and allocations are based on nights, with departure after arrival | Timed resource occupancy for day use and compound villa bookings |
| Pricing | Per-night room pricing and booking-specific overrides already exist | Clear price basis for each booking kind without artificial overnight dates |
| Messaging | Templates and messages carry property IDs; WhatsApp transport is bound to one configured property | Route each property's messages, credentials, callbacks and scheduled reminders explicitly |
| Reception | Hotel labels and check-in assume room numbers and overnight stays | Villa resource names and a shorter day-use arrival/departure flow |

Relevant code: `apps/api/src/auth/auth.service.ts`,
`apps/api/src/auth/owner-authorisation.service.ts`,
`apps/api/src/reservations/room-inventory.ts`,
`apps/api/src/messaging/whatsapp.service.ts`,
`apps/api/src/messaging/messaging.service.ts`,
`apps/web/src/components/app-shell.tsx`, `apps/web/src/lib/session.ts`,
and migrations `0001`, `0003`, `0005`.

## Implementation boundaries

1. Add authorized property membership without rewriting historical user IDs or booking
   ownership. Permissions, Owner PIN approvals and shared-desk access must use the selected
   property's grants. Existing logins retain their existing default access.
2. Bind requests and downloads to an explicit validated property context. Switching in one
   tab must not silently make a form in another tab write into the other property. Reset
   property-specific caches and abandon or explicitly preserve unsaved forms at the boundary.
3. Model one private property allocation, shared by all booking kinds. Enforce timed
   exclusivity in PostgreSQL as well as availability checks; no independently bookable resources.
4. Support confirmed timed day-use rules. Do not fabricate an
   overnight room booking for a same-day pool visit. Keep the current Laxmi night-based
   model and its historical snapshots intact.
5. Reuse audited billing/payment/document behavior with the correct booking kind, price
   basis, service descriptions and tax rules. Only overnight stays enter overnight
   occupancy/reminder/night-charge calculations.
6. Configure Villa Sol identity, contacts, billing settings and message wording independently.
   Do not copy Laxmi Wi-Fi, guest consent, guest documents or contact lists into Villa Sol.
7. Choose a WhatsApp sender after confirmation. A reception phone number alone is not an
   onboarded API sender. Keep credentials server-side, and map incoming callbacks by their
   verified account/phone identity before updating any property's messages.
8. Create the second live property only after local migration, isolation, booking and
   billing checks pass. Never run the old handover test-data purge scripts.

## Acceptance checks before handover

- A staff member without access cannot select or access the other property, including
  guessed record IDs, PDFs, exports, search, captures and document URLs.
- Owner/reception roles and PIN approval cannot be borrowed from the other property's access.
- Switching properties clears prior guests, totals and search results; stale forms and
  simultaneous tabs cannot save into the wrong property.
- Partial and whole-villa reservations cannot overlap occupied resources, including two
  concurrent saves, edits, cancellation, arrival, extensions and cleaning blocks.
- Slot boundaries follow the confirmed booking/turnaround rules.
- Pool/garden day use can arrive, bill and depart on the same date without nightly charges.
- Bedroom-only and whole-villa flows use correct guest limits and arrival documents.
- Custom prices, extras, GST, advance, balance, refunds and PDFs match the selected property.
- Notifications use that property's name, reception, Wi-Fi, dates/times and sender; retries
  and callbacks remain isolated and idempotent.
- Cash shifts, payment accounts, reports, numbering, night audit and exports stay separate.
- Laxmi regression suite passes and read-only pre/post checks show no historical records
  rewritten or removed by the release.

The handover document records deliberate deferred setup and the controlled release process.
WhatsApp onboarding remains separate from this implementation.
