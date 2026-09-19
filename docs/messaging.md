# Guest messages — email through Resend (Sprint B)

Spec §40, §41. Email now; WhatsApp waits on Meta business verification and SMS on DLT registration.
Both will use the same templates, the same message rows and the same delivery tracking.

## A message is a row before it is anything else

```
business change ──commit──► outbox_events ──handler──► messages (queued / skipped + reason)
                                                             │
                                             sender (every minute, and nudged) ──► provider
                                                             │                        │
                                             sent / retrying / failed  ◄── webhook ───┘ delivered, bounced…
```

- **Queueing is idempotent per cause.** `messages_once_per_cause` is unique on
  `(property, source_key, template_key, channel)`: the booking, the invoice, the payment or the stay
  that caused it. An outbox event delivered twice, or a reminder schedule run twice, is one message.
- **Everything is decided and written down at queue time**: the rendered subject and body, the
  recipient, and — if it cannot go — `skipped` with the reason ("The guest has no email address on
  file", "Email is switched off in message settings"). The owner sees what would have gone.
- **Sending is separate.** The sender leases due rows (`sending`, `send_after` pushed out) under
  `FOR UPDATE SKIP LOCKED`, so two workers never take one message and a crashed worker's lease simply
  runs out. Provider hiccups (network, 429, 5xx) retry with backoff up to 6 attempts; a rejection
  (4xx) is `failed` at once with the reason.
- **Nothing is rewritten.** A trigger refuses any change to what was sent; only delivery state moves
  on, and a failed or skipped message stays that way. **Resend** is a new row with `resend_of`.
- **A failure never reaches a booking or a bill** — tested with a provider that fails every time.

## What is sent, and when

| Template | Cause | Notes |
|---|---|---|
| Booking confirmed | `reservation.created` / `.confirmed` | Not for a tentative booking, nor a walk-in being checked in today |
| Welcome after check-in | `stay.checked_in` | One per booking, even for several rooms |
| Checkout reminder | Schedule, every 10 minutes after the reminder time | Evening before departure; respects quiet hours; a one-night stay checked in that afternoon is recorded as skipped (setting) |
| Thank you + invoice | `invoice.issued` (tax invoice / bill of supply) | PDF attached |
| Receipt | `payment.recorded` (payment, advance, deposit into an account) | PDF attached; not for refunds or settlements that moved no money |

Quiet hours (default 21:30–08:00) delay non-urgent messages. The release time is computed by
PostgreSQL in the property's timezone (`quiet_hours_release()`), never by the app clock.

## Privacy (§41, CLAUDE.md rule 12)

Templates can only use the variables in `TEMPLATE_VARIABLES`; anything else in braces renders as
nothing, and saving a template that uses one is refused. There is no variable for a guest's mobile,
address, ID number, card detail or PIN. The emailed invoice always masks the mobile and leaves a
private guest's home address off (a company's billing address stays — a B2B invoice needs it).

## Templates

Built-in English and Hindi wording for every message; the owner's own wording (Settings → Guest
messages) replaces it per language once saved. A guest's language is on their profile
(`preferred_language`). Test sends go to an address the owner types, through the same sender.

## Providers

`MessageProvider` has one method, `send()`. Implementations:

| Provider | When |
|---|---|
| `ResendProvider` | `RESEND_API_KEY` set (production default) — HTTP API, `Idempotency-Key` = our message id |
| `DevProvider` | development and tests without a key — records the message as sent, sends nothing; refused in production |
| none (`MESSAGING_PROVIDER=off`) | messages are recorded as skipped |

WhatsApp: a `WhatsAppProvider` with `channel = 'whatsapp'`, templates with `provider_template_id` and
`approval_status` (columns already exist), and a fallback to email when WhatsApp fails.

## Delivery reports

`POST /api/v1/webhooks/resend` accepts Resend's Svix-signed webhooks only: HMAC-SHA256 over
`id.timestamp.body` with `RESEND_WEBHOOK_SECRET`, at most five minutes old. It is the one unsafe route
exempt from the CSRF header, because it proves itself with the signature. Every report is kept in
`message_events`; the message's status only moves forward (sent → delivered → opened), and a bounce
or complaint is final.

## Setting up Resend (owner / operator)

1. Create a Resend account and **verify the sending domain** (SPF, DKIM, DMARC records at the DNS host).
2. Create an API key with sending access only → `RESEND_API_KEY`.
3. Add a webhook to `https://<api-host>/api/v1/webhooks/resend` for the `email.*` events → copy its
   signing secret to `RESEND_WEBHOOK_SECRET`.
4. In ResortOS, Settings → Policies → Guest email: set the sender address on the verified domain, the
   reception phone, Wi-Fi and map link, then switch email on. Send a test from Settings → Guest messages.
