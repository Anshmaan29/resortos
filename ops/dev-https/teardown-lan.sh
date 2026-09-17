#!/usr/bin/env bash
# Undoes ops/dev-https/setup-lan.sh: puts MinIO back on plain HTTP for local development.
#
# Why this exists: setup-lan.sh gives MinIO a certificate so phones can reach it over HTTPS, and
# MinIO then serves HTTPS on port 9000. The test suites talk to http://localhost:9000, so while the
# LAN setup is active `pnpm test` and `pnpm e2e` fail with a confusing CORS error from the browser.
# Run this when you have finished testing on real devices.
#
# The mkcert certificate authority stays installed on this Mac and on the phones, so
# `pnpm https:setup` is quick the next time.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CERTS="$ROOT/ops/dev-https/certs"

rm -f "$CERTS/minio/public.crt" "$CERTS/minio/private.key"
rm -f "$ROOT/.env.lan"

echo "→ Restarting MinIO on HTTP"
(cd "$ROOT" && docker compose up -d --force-recreate --wait minio >/dev/null && docker compose run --rm minio-init >/dev/null)

echo "✓ MinIO is back on http://localhost:9000 — pnpm test and pnpm e2e will work again"
