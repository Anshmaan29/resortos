# Direct Meta WhatsApp for ResortOS

Email remains on Resend and hosting remains on Railway. This is a separate opt-in channel. English
utility templates are preconfigured; guest bookings, welcomes, checkout reminders, invoices and
payment receipts use the after-commit queue. It is not a WhatsApp chat inbox.

## Operator setup

1. Deploy this release through the existing Railway release process. Migration 0027 adds explicit
   guest WhatsApp consent; do not skip the normal migration/release checks.
2. Add these **server-only** variables on the resortos Railway service:
   - WHATSAPP_ACCESS_TOKEN: production system-user token with WhatsApp messaging and business
     management permissions for this app, production WABA and production sender.
   - WHATSAPP_PHONE_NUMBER_ID: 1330833123455533
   - WHATSAPP_BUSINESS_ACCOUNT_ID: 1694776862241532
   - WHATSAPP_PROPERTY_ID: copy from Settings → Guest messages → WhatsApp.
   - WHATSAPP_APP_SECRET: the Meta developer app's App Secret.
   - WHATSAPP_VERIFY_TOKEN: generate a separate random secret, at least 32 characters; this is
     **not** the access token. For example, locally use: openssl rand -hex 32
   - WHATSAPP_GRAPH_VERSION: v25.0 (default; align future upgrades with Meta's supported versions).
   - JOBS_ENABLED: true (the existing message sender must run).
   Keep all secret values out of screenshots, chat, Git and NEXT_PUBLIC_* variables.
3. Deploy those environment changes. Confirm the API is healthy.
4. In Meta → Configure Webhooks enter:
   - callback: https://pms.voittoventures.com/api/v1/webhooks/whatsapp
   - verify token: exactly the WHATSAPP_VERIFY_TOKEN saved in Railway.
   - leave client-certificate authentication off for this implementation.
   Click Verify and save. This requires the deployed endpoint, not just a registered phone.
   For Meta's app publishing requirement, the public privacy policy is at
   https://pms.voittoventures.com/privacy. It opens without a ResortOS login.
5. Subscribe the production WABA to the app (Subscribe webhooks), and subscribe the messages
   webhook field. Complete the Meta app's publishing requirements and publish it for production
   webhook delivery. Dashboard test webhooks are not proof of production delivery.
6. Create Utility templates in WhatsApp Manager. Settings → Guest messages → WhatsApp provides
   the exact template names, numeric-placeholder body and parameter meanings. English starts with
   code en; if Meta approves en_US, save that exact code. Invoice and receipt need a DOCUMENT
   header and a sample PDF. Others have no header. Do not add buttons or footer.
7. In ResortOS save the template names, click Check Meta template approval, and correct any
   NOT_FOUND / unapproved / mismatching templates. Then enable WhatsApp and save.
8. Create a test booking with the guest's email and WhatsApp number. Save booking records
   reception's agreement attestation and queues both confirmations automatically, without a second
   checkbox or Send action. Confirm Sent changes to Delivered/Read and it arrives on the phone.
   Test invoice/receipt PDF delivery using practice records, not a fabricated real payment.
9. Revoke consent and verify a later send is skipped. Confirm existing Resend email still works.

Meta template approval, publishing, valid production credentials and the live send/receipt checks
are operator gates, not outcomes guaranteed by CI.

## Message behaviour and reliability

- Save booking displays the agreement attestation and records it with the booking, before its
  event is published. Reception must obtain the guest's permission; Save is the recording action.
  The optional delivery preference excludes WhatsApp when the guest declines. Returning guests
  with a recorded decline default to email only. Older API callers that omit whatsappOptedIn
  preserve the existing agreement state. Tentative bookings send when confirmed; walk-ins send too.
  The number in a guest profile alone is never treated as opt-in.
  Consent changes are audited using guest identifiers and boolean state, without copying phones.
- Automatic sends only start when the property explicitly enables WhatsApp. Consent, property
  binding, current recipient number and the switch are checked again before a network send.
- Use Meta-approved templates even when no 24-hour reply window exists. No arbitrary text feature.
- Email and WhatsApp are independent channels; neither provider can roll back a booking/payment.
  Resend stays enabled separately. There is no additional automatic fallback email, which would
  duplicate existing event emails.
- PDFs are the same private-data-safe invoice/receipt copies used by email, uploaded directly to
  Meta as PDF media. Guest face, ID documents and signatures are never shared.
- The message body, template parameters, sender choice and PDF bytes are retained for retries.
- Meta does not inherit Resend's 24-hour Idempotency-Key guarantee. Only explicit rate-limit
  rejections are automatically retried. A timeout, ambiguous server response or interrupted send
  is held for manual review; check Meta before resending.
- Each send carries the ResortOS message UUID as biz_opaque_callback_data so a callback arriving
  before the HTTP response can locate the message. Other properties/WABAs/senders are rejected.
- POST callbacks require HMAC-SHA256 over the original raw body with the Meta app secret. GET
  verification returns the exact challenge in plain text. Access token and verify token differ.
- Duplicate status callbacks are deduplicated under the message row lock; delivered/read state
  cannot regress. Raw incoming chats, contact lists, phones and provider error text are discarded.
- A late successful callback after an uncertain terminal failure is retained in the delivery event
  history but does not rewrite the failed message. Review Meta before deciding to resend.

References:
[Meta webhook signature example](https://github.com/fbsamples/whatsapp-api-examples/tree/main/signature-validation-with-webhooks-payloads)
and [Meta Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api).

## Message layout

English templates use bold headings and one labelled line per booking, room, date or amount.
The formatted templates have names ending in `_en_v2`. Existing `_en` templates remain
compatible during review. Switch each binding only after its replacement is approved and
matching; already-queued messages retain the template and wording captured when queued.
