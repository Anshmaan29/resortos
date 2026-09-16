# Production readiness checklist

Extends spec §85. Every box is ticked, with evidence linked, before any real guest data is entered.

## Gate 0 — before any real guest data (hard rule)

- [ ] Backup layers 1–3 running (PITR Mumbai, copies in Hyderabad, off-site second provider with Object Lock)
- [ ] Restore test from the off-site copy passed and recorded (date, duration, row counts, totals)
- [ ] Backup encryption key stored in two places outside the primary cloud

## Demo data can never reach production

- [ ] **GST: every `tax_rules` row with `origin = 'demo_placeholder'` is closed (`effective_to` set) and replaced by rules the resort's CA has confirmed in writing (rates, SAC codes, slab boundaries, food rate, treatment of extra-bed charges). Attach the CA's confirmation.**
- [ ] No property with `data_origin = 'demo'`, no active user with `is_demo = true`
- [ ] Production API started with `NODE_ENV=production` and refused to boot when tested against a copy containing demo data (`src/safety/production-guard.ts`)
- [ ] Deployment artefact does not contain `apps/api/scripts/` (seed/migrate libs are not in `dist/`); seeding is additionally blocked by `assertSeedAllowed` (production, remote hosts, missing `RESORTOS_ENV`)
- [ ] `.env` files, keys and certificates are not in the repository or the image

## Security

- [ ] Owner has printed recovery codes and stored them offline; recovery tested once
- [ ] Owner PIN set by the owner (not the demo PIN); unlock procedure in `docs/security.md` shown to the owner
- [ ] `SESSION_COOKIE_SECURE=true`, HTTPS only, `trust proxy` matches the real load balancer hop count (IP-based throttling depends on it)
- [ ] External VAPT completed and findings fixed

## Front desk, billing, owner access, compliance, AI

See spec §85 sections; tracked per phase in `docs/PHASES.md`.
