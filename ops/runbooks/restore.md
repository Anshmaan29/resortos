# Runbook — backups and restore

Gate 0 (spec §85) says no real guest data until backups exist **and a restore from them has been
done and recorded**. This is that procedure. It is written to be followed by someone tired, at
night, possibly on a phone, possibly after something has gone badly wrong.

---

## The three layers (spec §53)

| Layer | What | Protects against |
|---|---|---|
| 1 | Managed PostgreSQL with point-in-time recovery, 35 days | A wrong `UPDATE`, a bad deploy, a dropped table |
| 2 | The provider's copies in a second region | One data centre or region |
| 3 | **This runbook** — nightly encrypted dump at a *different provider*, under Object Lock | The account itself: suspension, billing failure, stolen credentials, ransomware |

Layers 1 and 2 are settings on the managed database, ticked off in
`docs/production-readiness.md`. Layer 3 is code in this repository, and is the one that has to be
practised, because it is the one used on the worst day.

---

## Keys — read this before anything else

Generate the key pair **on a machine that is not the server**, once:

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out resortos-backup-private.pem
openssl rsa -pubout -in resortos-backup-private.pem -out resortos-backup-public.pem
```

- **`resortos-backup-public.pem` goes on the backup host**, as `BACKUP_PUBLIC_KEY`. It can only
  encrypt. A server that is fully compromised still cannot read a single backup.
- **`resortos-backup-private.pem` never touches the primary cloud.** Two copies, two places, neither
  of them the provider running the database (spec §54): for example a hardware token in the
  resort's safe and a sealed printed copy with the owner's CA or lawyer.
- **Losing the private key loses every Layer 3 backup.** There is no recovery, by design. That is
  why there are two copies, and why the quarterly drill decrypts with the stored copy rather than a
  convenient one on somebody's laptop.

Print the fingerprint and keep it with each copy, so the right key can be identified:

```bash
openssl pkey -in resortos-backup-private.pem -pubout -outform DER | openssl sha256
```

---

## The off-site bucket

At a **different provider** from the database — Backblaze B2, Cloudflare R2, Google Cloud Storage.

1. Create the bucket **with Object Lock enabled**. It cannot be added afterwards, at any provider.
   Getting this wrong means making a new bucket.
2. Default retention 60 days, **COMPLIANCE** mode (spec §53.4) — not GOVERNANCE, so nobody can
   shorten it, including whoever holds the root account.
3. Credentials for the backup host that **can write and cannot delete**. Object Lock alone is not
   enough: a plain delete on a versioned bucket is *accepted* and writes a delete marker, which
   destroys nothing but hides the backup from every listing — including this runbook's "newest
   backup". `apps/api/test/backup-restore.test.ts` demonstrates exactly that.

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       { "Effect": "Allow", "Action": ["s3:PutObject"], "Resource": "arn:aws:s3:::resortos-backups/*" },
       { "Effect": "Deny", "Action": ["s3:DeleteObject", "s3:DeleteObjectVersion", "s3:PutObjectRetention", "s3:PutBucketVersioning"], "Resource": "arn:aws:s3:::resortos-backups/*" }
     ]
   }
   ```

---

## Nightly backup

Runs after night audit (spec §53.3). On the backup host, in cron or a systemd timer:

```bash
BACKUP_DATABASE_URL=postgres://resortos_backup:...@db:5432/resortos \
BACKUP_PUBLIC_KEY="$(cat /etc/resortos/backup-public.pem)" \
BACKUP_S3_ENDPOINT=https://s3.us-west-004.backblazeb2.com \
BACKUP_S3_BUCKET=resortos-backups \
BACKUP_S3_ACCESS_KEY_ID=... BACKUP_S3_SECRET_ACCESS_KEY=... \
node ops/backup/backup.mjs
```

`resortos_backup` only needs `SELECT`. Failure exits non-zero and prints one line; wire that to the
same alert channel as everything else. **A backup that has not run is not something to look at next
week** — two silent nights is an incident.

---

## Restore test

Run from a machine holding the **private** key — deliberately not the backup host, so that
compromising the server does not also hand over the ability to read the backups.

```bash
BACKUP_PRIVATE_KEY="$(cat ~/keys/resortos-backup-private.pem)" \
BACKUP_S3_ENDPOINT=... BACKUP_S3_BUCKET=resortos-backups \
BACKUP_S3_ACCESS_KEY_ID=... BACKUP_S3_SECRET_ACCESS_KEY=... \
BACKUP_RESTORE_ADMIN_URL=postgres://postgres:...@localhost:5432/postgres \
BACKUP_COMPARE_DATABASE_URL=postgres://resortos_backup:...@db:5432/resortos \
node ops/backup/restore-test.mjs
```

It downloads the newest backup, decrypts it, **checks the plaintext hashes to what was recorded when
it was written**, restores into a throwaway database, runs `ops/backup/integrity.sql`, compares row
counts with the live database, prints PASS or FAIL, and drops the throwaway database. Exit code 0 is
PASS, 1 is FAIL with findings, 2 means it could not complete.

Weekly, automatically. **Record every run** in the table in `docs/production-readiness.md`: date,
duration, backup age, row counts, result. Gate 0 needs at least one recorded PASS from the real
off-site bucket, with the real key, before any guest data is entered.

The same loop runs on every commit against MinIO (`apps/api/test/backup-restore.test.ts`), so the
code cannot rot between drills. That is not a substitute for the drill: it proves the mechanism, not
the bucket, the key, or the credentials.

---

## Recovering for real

**Something was changed or deleted by mistake, the database is otherwise healthy.** Layer 1.
Point-in-time restore to a *side* database at a timestamp just before the mistake, then copy the
affected rows across. Never restore over the live database for this — everything since would be lost
too.

**The database is gone, the account is fine.** Restore from the managed provider's own backups
(Layers 1/2). Fastest path, and the only one that gets you back to within minutes.

**The account is gone, compromised, or suspended.** This is what Layer 3 is for.

1. New account, any provider. Create a PostgreSQL 16 instance.
2. Create the roles from `db/init/01-roles.sql`.
3. Find a good backup and restore it:
   ```bash
   node ops/backup/restore-test.mjs      # proves which backup is good, on a scratch database
   ```
   then restore that same object into the real new database. The script's steps are deliberately the
   ones you would run by hand: download, `open()` from `ops/backup/envelope.mjs`, then
   `pg_restore --no-owner --no-privileges`.
4. Re-apply `db/grants.sql`.
5. Point the API at it. **Check the business date before anyone touches the desk**:
   `SELECT current_business_date FROM properties`. It is the date of the backup, not today, and it
   moves only through night audit (§35). Run the missing audits in order, or the days between are
   never closed.
6. Documents live in object storage, not in the database. Restore or re-point `S3_*` before check-in
   is used: a stay cannot be confirmed while its documents are unreadable. That is correct, and it
   also means the desk stops working until this is done.
7. Rotate every credential, including the backup write credentials.

**The private key is lost.** Layer 3 is gone. Layers 1 and 2 remain, if the account does. Generate a
new pair, start writing new backups immediately, and treat the old objects as unrecoverable — do not
try to delete them, the retention will expire on its own.

---

## What is not done yet

Tracked in `docs/production-readiness.md`, not silently assumed:

- Layers 1 and 2 are provider settings, and there is no real provider yet.
- No alerting integration: the scripts exit non-zero and print; nothing is listening.
- No Data Safety panel for the owner (spec §53.7) — Phase 3.
- Backing up the documents in object storage is separate from the database, and is not automated
  here yet.
