# Security notes

## Login protection without lockout abuse (spec §5.1)

A hard "lock the account after 5 wrong passwords" lets anyone lock the owner out by typing their username. ResortOS throttles instead:

| Scope | Rule | Effect |
|---|---|---|
| Account + network (IP), unknown device | After 5 failures: wait 30 s, 1 min, 2 min … max 15 min | Only the attacker's network is slowed |
| Account + known device | Same delays, counted separately per device | A desk computer is not affected by failures elsewhere |
| Network | More than 20 failed logins in 15 min (any accounts) | That network waits; **known devices are exempt** |
| Account overall | More than 30 failures in 1 hour | Unknown devices wait 15 min; **known devices are exempt** |

A *known device* is a browser that has logged in successfully before (`rsos_device` HttpOnly cookie, stored as a SHA-256 hash in `known_devices`). Throttled attempts are recorded but do not extend the delay. Every throttle event is audit-logged.

**Clearing throttles:** the owner opens Users → *Unlock* for the staff member (`POST /users/:id/unlock`). The owner's own throttles are cleared by a recovery code.

## Owner recovery (spec §5.2)

- The owner generates 10 single-use recovery codes (`POST /auth/recovery-codes`, password required), prints them and keeps them offline. Generating new codes invalidates unused old ones.
- `POST /auth/recover` with username + code + new password: resets the password, clears login throttles **and** the Owner PIN lock, and logs out every session. Limited to 5 failed attempts per network per 15 minutes.
- Email-based reset needs the email provider (Phase 3).

## Owner PIN (spec §4.5)

- Separate from the password, 6 digits, trivial PINs rejected, stored with Argon2id.
- A receptionist's action beyond their limits creates a **pending authorisation** holding the exact values computed by the server. The owner types the PIN on that screen; the approval is valid for **2 minutes**, usable **once**, only by the same staff member, and only if the retried request produces the **identical scope hash** (same booking, room, dates, rate …). Database triggers stop an approval from being re-approved, extended or rewritten.
- Every use is written to `owner_overrides` and shown on the booking: *"Rate ₹2,000 is below the minimum ₹2,600. Authorised by … (Owner), 16 Sep, 5:42 PM."*

### When the Owner PIN is locked

5 wrong PINs lock it for 30 minutes (failures are recorded outside the business transaction, so they cannot be erased by the rollback). To unlock:

1. Wait 30 minutes, **or**
2. The owner logs in with their own password (phone or desk) → Users → *Unlock* on their own account, **or** sets a new PIN (password required), **or**
3. The owner uses a recovery code (also clears it).

While locked, the owner can still perform the action directly from their own login.

## Data handling

- All SQL uses `$n` parameters; a test fails the build if any query text is built by interpolation.
- Session tokens, device tokens, recovery codes and PINs are stored only as hashes.
- Audit entries hold identifiers, not guest personal details.
