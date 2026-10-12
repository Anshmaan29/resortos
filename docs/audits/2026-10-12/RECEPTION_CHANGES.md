# Reception booking, checkout and print update - 12 October 2026

## Reception workflow

1. Choose the guest, dates, room and number of adults/children.
2. Select EP (room only), CP (breakfast), MAP (breakfast + one meal), or AP (all meals).
3. Enter the agreed **room price per night**. This includes the chosen meal plan; meals are not added again. Different rooms in a group can have different plans/prices. New custom bookings require an amount instead of silently taking a tariff.
4. Enter **GST %** beside the price, or leave it blank for the hotel's dated rules. Enter 0 for a zero-rate agreement. This booking percentage applies to its room, meal and extra-guest components; other bill items retain their own tax categories. The applicable rule still supplies SAC and supply dates. The entered percentage is saved and carried into checkout, invoices and corrections without changing other bookings or issued invoices.
5. Enter **extra guest price per night** as a total for extra adults/children. Blank uses standard charges; 0 includes them at no extra cost. Custom package rates can be saved even if the owner has not configured separate meal tariffs.
6. Save. Existing automatic confirmation and recorded guest WhatsApp preferences continue to apply. Express check-in offers the same plan/price/GST/extra-guest fields and records the guest's messaging preference on Continue.
7. On Home choose **Check out**, then select **Check out** beside the room in **In house**. This opens the settlement/invoice dialog directly; it does not check the guest out until reception confirms. The stay page keeps its own Check out button.

Existing unchanged booking prices are preserved on edit. The standard tariff remains an optional choice. Normal owner-authorisation safeguards remain configured by the hotel; the live hotel has requested no minimum-price floor. Included plan prices and extra-guest charges carry through when extending an included-price stay.

## PDFs and welcome messages

The supplied original transparent Voitto logo and a restrained gold VOITTO VENTURES masthead appear on every newly rendered PDF page: invoices/credit/debit notes, A4 and thermal receipts, cashier reports, registration cards and police registers. Existing archived registration-card files remain immutable; a newly generated version receives the masthead. Legal seller details remain below the brand.

Guest Wi-Fi is stored in the hotel's editable settings, not in source code. Email welcomes already support the Wi-Fi variable. WhatsApp welcome v3 adds it and keeps older approved parameter layouts compatible while the new binding is activated only after exact Meta approval checks. Hotel Wi-Fi credentials and access tokens are not included in this document.

## Verification

- Build and typecheck passed.
- Shared: 41; web: 105; API: 374; startup: 4; operational financial regressions: 25; desktop/phone browser workflows: 20. Total: **569 checks**.
- New regressions verify manual plan-inclusive pricing, zero/arbitrary GST, extra charges, unchanged edits, final invoice/payment balance, immutable posted GST, and legacy/new WhatsApp parameter compatibility.
- Desktop/phone workflow checks use actual browser inputs, Express check-in, save/opt-out, edit/rebook, and the visible Home -> In-house -> Checkout route.
- A4, thermal, registration and multi-page register samples were rendered and inspected. All sampled pages contain the brand text and an embedded logo. Samples use synthetic data.
- No real guest message, booking, payment or check-in was created during this update's QA.

Protected GitHub checks, production migration/deployment, and live Wi-Fi/template activation are verified separately in the release log. Physical printer/phone acceptance and accountant approval remain resort handover checks.
