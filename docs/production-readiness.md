# Production readiness checklist

Extends spec §85. Every box is ticked, with evidence linked, before any real guest data is entered.

## Gate 0 — before any real guest data (hard rule)

Procedure for all of this: **`ops/runbooks/restore.md`**. The Layer 3 mechanism is built and runs on
every commit against MinIO (`apps/api/test/backup-restore.test.ts`); what is left below is the real
provider, the real key and the real drill, which no test can stand in for.

- [ ] **Layer 1** — managed PostgreSQL 16 with point-in-time recovery, 35 days, verified by doing one PITR to a side database
- [ ] **Layer 2** — provider copies in a second region
- [ ] **Layer 3** — nightly `node ops/backup/backup.mjs` after night audit, to a *different provider*, in a bucket created **with Object Lock**, 60-day COMPLIANCE retention
- [ ] Backup host credentials **write but cannot delete** (IAM policy in the runbook). Object Lock alone is not enough: a plain delete writes a delete marker that hides the backup without destroying it
- [ ] **Encryption key pair generated off the server.** Public half on the backup host; private half in two places, neither of them the primary cloud. Fingerprint printed and kept with each copy
- [ ] **Restore test from the real off-site copy passed and recorded below** — with the real key, not the test one
- [ ] Alerting wired to the backup and restore-test exit codes (two silent nights is an incident)

### Restore test log

Every run of `node ops/backup/restore-test.mjs` against the real bucket. Gate 0 needs at least one
PASS here; after that it is weekly.

| Date | Backup taken | Duration | Rows (properties / guests / reservations) | Findings | Result | Run by |
|---|---|---|---|---|---|---|
| _none yet_ | | | | | | |

## First production property

Use the restricted empty-database provisioning procedure in `ops/runbooks/provision.md`. It creates a live property/owner without demo data, room prices or tax rules. Finish configuration in Settings and print recovery codes after signing in. This does not satisfy Gate 0 by itself.

## Demo data can never reach production

- [ ] **GST: every `tax_rules` row with `origin = 'demo_placeholder'` is closed (`effective_to` set) and replaced by rules the resort's CA has confirmed in writing (rates, SAC codes, slab boundaries, food rate, treatment of extra-bed charges). Attach the CA's confirmation.**
- [ ] No property with `data_origin = 'demo'`, no active user with `is_demo = true`
- [ ] Production API started with `NODE_ENV=production` and refused to boot when tested against a copy containing demo data (`src/safety/production-guard.ts`)
- [ ] Deployment artefact does not contain `apps/api/scripts/` (seed/migrate libs are not in `dist/`); seeding is additionally blocked by `assertSeedAllowed` (production, remote hosts, missing `RESORTOS_ENV`)
- [ ] `.env` files, keys and certificates are not in the repository or the image

## Guest email

- [ ] Sending domain verified in Resend (SPF, DKIM, DMARC)
- [ ] `RESEND_API_KEY` (sending access only) and `RESEND_WEBHOOK_SECRET` set in production; `MESSAGING_PROVIDER` is not `dev` (boot refuses it)
- [ ] Test email received from Settings → Guest messages, in English and Hindi (practice-mode and queued acknowledgements are not delivery evidence)
- [ ] Owner has reviewed the wording of all five messages

## Security

- [ ] Owner has printed recovery codes and stored them offline; recovery tested once
- [ ] Owner PIN set by the owner (not the demo PIN); unlock procedure in `docs/security.md` shown to the owner
- [ ] `SESSION_COOKIE_SECURE=true`, HTTPS only, `trust proxy` matches the real load balancer hop count (IP-based throttling depends on it)
- [ ] External VAPT completed and findings fixed

## Front desk, billing, owner access, compliance, AI

See spec §85 sections; tracked per phase in `docs/PHASES.md`.
