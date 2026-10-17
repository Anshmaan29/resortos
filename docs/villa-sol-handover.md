# Villa Sol by Voitto

## Approved operating rules

- Kaithun, Kota, Rajasthan 324001. Reception: +91 9352204825.
- Same legal business and GSTIN as Laxmi Palace, with separate operational records.
- Only the owner can switch properties. Receptionists belong to their own property.
- Room 1 and Room 2 can be booked by different guests at the same time. Either bedroom booking
  blocks pool and garden visits; a pool or garden booking blocks the entire property.
- Choices: One room, 2 rooms, Swimming pool, Garden. One room asks for Room 1 or Room 2.
- A 2 rooms booking includes both rooms, pool and garden with one combined nightly price and bill.
- Existing bookings keep their original whole-property allocation and historical inventory references.
- Reception enters start/end date and time, guest count, agreed price and GST percentage.
- Overnight prices are per night; pool/garden prices cover the entire selected time slot.
- Pool/garden arrival does not require an ID, photo or signature. Overnight check-in retains
  the existing verified document workflow.
- Pool/garden checkout requires a settled bill and no outstanding deposit, issues an invoice
  and marks the property as needing housekeeping. A new arrival requires readiness.
- Email uses `reception@voittoventures.com` with Villa Sol branding, its reception and booked times.
- WhatsApp is deliberately unconfigured for Villa Sol until its sender is selected/onboarded.
- Villa invoices use their own VSI/VSB/VSC/VSD/VSR prefixes to distinguish them from Laxmi Palace.
- The owner will add Villa Sol staff and UPI/bank/card accounts in Settings. A separate cash
  counter starts with zero opening balance. No hotel account balances are copied.
- The owner/accountant will configure the Activity GST rule and SAC in Villa Sol Settings
  before pool/garden invoicing. Only the existing room tax rule is available from Laxmi Palace;
  it is not reused as an activity SAC. Villa Home shows the missing-setup reminder.

## Reception flow

1. Owner selects Villa Sol in the property selector; Villa reception staff log into their own account.
2. Select New booking, choose the booking kind and times, enter guest count, price and GST, and
   select/add a guest. Saving queues the email confirmation automatically when email is provided.
3. For pool/garden use, select Mark arrival. For an overnight stay, select Check in & collect ID.
4. Use the booking's Bill to record payments and charges. Villa cash is recorded directly in Accounts; no cashier shift needs opening or closing.
5. Select Check out. For overnight stays, the existing settlement/invoice checkout screen opens.
6. Use Rooms to see Room 1 and Room 2, then mark the used room(s) clean in Housekeeping before the next arrival. A single-room checkout leaves the other guest in house.

Property switching closes the current screen and clears its in-memory queries. Unsaved forms
warn before switching. Other browser tabs retain their own property context. Downloads carry
an authorized property context as well.

## Deployment and preservation

Develop and test against isolated databases/storage, using the dev email provider and no live
WhatsApp credentials. Never run the old handover data-purge scripts. Do not create production
sample guests or bookings.

Migration 0029 adds the property model, owner grants and private-villa allocation metadata;
existing hotel rows retain their previous behavior. Provisioning is an explicit transaction,
not a startup seed. `add-villa-lib.ts` copies legal/tax/meal configuration and creates independent
inventory, templates and an empty cash account. It does not copy operational records, staff,
Wi-Fi, private documents, shifts, payments or opening balances.

Controlled setup command after migrations and QA:

```sh
# Supply the four values through a private environment. Never commit a live database URL.
node -r ./scripts/swc-register.cjs scripts/add-villa.ts --apply
# VILLA_SETUP_DATABASE_URL, VILLA_SOURCE_PROPERTY_ID, VILLA_OWNER_ID, VILLA_PIN_CODE
```

The command is idempotent for the existing authorized Villa Sol property. Verify the target
property ID, counts, configuration, audit chain, invoice prefix and public health after setup.
Compare Laxmi's pre/post operational/configuration snapshots; account for ordinary live staff
activity through its audit trail rather than assuming the live resort stays idle during release.

Setup deliberately leaves Villa Sol staff credentials and non-cash payment destinations to the
owner, along with the activity tax rule/SAC, and leaves Villa WhatsApp and Wi-Fi unconfigured. These are visible setup choices rather
than copied Laxmi details.

Migration 0030 adds resource overlap protection for the two physical rooms and Villa-only cash without shifts. Hotels keep their database-enforced cash shift requirement. Run `ensureVillaRooms` in an authorized transaction to add Room 1 and Room 2 to an existing Villa Sol property; it never renames/deletes legacy inventory or edits bookings.
