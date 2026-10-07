# Railway setup

Deployment preparation, not a completed production deployment. Use practice data until the backup/restore and acceptance gates in `docs/production-readiness.md` pass.

## Services

1. Create a Railway project, then add **Database → PostgreSQL**. Keep its persistent volume.
2. Add a private S3-compatible document bucket. Record its endpoint, region and credentials securely. Verify signed uploads, downloads and browser CORS before using it for guest documents.
3. Connect `Anshmaan29/resortos` as one app service. Select branch `codex/reliability-and-configurable-operations`; keep Root Directory at the repository root. `railway.json` supplies the build, start and database health check. The public web process proxies `/api/v1` to the API on internal port 4000. The API also runs the email/background jobs. Neither a second public API service nor Redis is needed.
4. Set `RAILPACK_NODE_VERSION=22` and leave dependency pruning disabled (`RAILPACK_PRUNE_DEPS=false`) so operator migration/provision commands retain their runtime dependencies. Disable service sleeping for scheduled jobs. Begin with one replica.

## Database bootstrap (operator step)

Use a secure SQL connection as the Railway database administrator to create a dedicated `resortos_migrator` login and `resortos_app` login with independently generated passwords. The migrator must own the application's schema and objects and be able to create the pg-boss schema. The runtime app role must not be a superuser or own the tables. Do not run `db/init/01-roles.sql` on Railway: it contains local development credentials and a throwaway test database.

Set `MIGRATION_DATABASE_URL` only in the operator environment. It must connect as the migrator to the new cloud database, never the local development database. Run `pnpm db:migrate` from this repository using the cloud connection. It installs the schema, pg-boss and `db/grants.sql` permissions for `resortos_app`. Then follow `ops/runbooks/provision.md` to create the first property and owner with actual hotel details. Never run the demo seed in production or copy the local demo database. Migration and provisioning are explicit operator actions, not automatic on every app restart.

## App variables

Set these through Railway's Variables panel; no secret values belong in Git or chat:

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Private PostgreSQL connection using `resortos_app`, not the default administrator |
| `WEB_ORIGIN`, `PUBLIC_WEB_URL` | Exact HTTPS app URL after Generate Domain |
| `SESSION_COOKIE_SECURE` | `true` |
| `JOBS_ENABLED` | `true` |
| `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT` | Bucket's HTTPS endpoint reachable by phones and browsers |
| `S3_BUCKET`, `S3_REGION` | Actual private bucket and provider region |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Bucket credentials |
| `S3_FORCE_PATH_STYLE` | Provider's required setting |
| `MESSAGING_PROVIDER` | `resend` |
| `RESEND_API_KEY` | Sending key, entered privately |
| `RESEND_WEBHOOK_SECRET` | Signing secret after registering the delivery webhook |

Railway supplies `PORT`; the launcher reserves internal port 4000. The build fixes `API_ORIGIN=http://127.0.0.1:4000`. Do not expose the migration credentials in the app runtime. The Resend key in your local `.env` is not automatically copied to Railway. Save the verified sender/reply-to in the cloud app's Guest messages settings and test with your own email address.

## Verification and handover

Generate a Railway HTTPS domain, update the two URL variables, redeploy and confirm the service health check. Verify login/logout, owner/receptionist permissions, booking/check-in, configurable rates and GST, manual meal charges, payments, invoice print/export, private document uploads/downloads, job health and test email. Configure delivery webhooks, then confirm delivery status. Trial deployments can hit resource/credit limits; a successful local build does not prove a Railway deployment will fit them.

Enable database backups, separately back up documents, and restore into a separate practice environment before entering real guest data. Railway volume backups alone do not satisfy the repository's full cross-provider/PITR backup requirements. Verify the chosen provider's retention and recovery support; do not claim those gates passed without a restore test. Existing CSV/Excel exports support routine downloads; a complete recoverable export also needs a PostgreSQL dump and document backup. Google Sheets is an additional limited-data mirror, not the database or a recovery backup.

After launch, a custom subdomain such as `app.voittoventures.com` can be added using Railway's exact DNS instructions while the existing Wix website stays at the main domain. Measure actual usage before quoting the ongoing bill; Hobby's minimum charge is not a fixed total for all resources.

References: [Railway config](https://docs.railway.com/config-as-code/reference), [Railpack Node workspaces](https://railpack.com/languages/node/), [Railway PostgreSQL](https://docs.railway.com/databases/postgresql).
