#!/bin/sh
# Creates private, versioned buckets (spec §52). Works with MinIO over HTTPS (LAN phone testing) or HTTP.
set -eu
HOST="${1:-localhost:9000}"
USER="${MINIO_ROOT_USER:-resortos}"
PASS="${MINIO_ROOT_PASSWORD:-resortos-dev-minio-secret}"
if mc alias set local "https://$HOST" "$USER" "$PASS" --insecure >/dev/null 2>&1; then FLAGS="--insecure"; else
  mc alias set local "http://$HOST" "$USER" "$PASS" >/dev/null; FLAGS=""; fi
for bucket in resortos-documents-dev resortos-documents-test; do
  mc mb $FLAGS --ignore-existing "local/$bucket"
  mc version enable $FLAGS "local/$bucket"
  mc anonymous set none $FLAGS "local/$bucket"
done

# Off-site backup bucket (spec §53.3). Created --with-lock so Object Lock can be set per object:
# a bucket cannot be given Object Lock after the fact, on MinIO or on Backblaze B2 or on S3. The
# real off-site bucket lives at a different provider; this one exists so the restore test can prove
# the retention actually refuses a delete rather than assuming it does.
mc mb $FLAGS --ignore-existing --with-lock "local/resortos-backups-test"
mc anonymous set none $FLAGS "local/resortos-backups-test"

echo "buckets ready"
