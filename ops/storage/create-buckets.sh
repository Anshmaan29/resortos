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
echo "buckets ready"
