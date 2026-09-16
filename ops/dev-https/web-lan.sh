#!/usr/bin/env bash
# Web app over HTTPS on all interfaces with the LAN certificate.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
[[ -f "$ROOT/.env.lan" ]] || { echo "Run  pnpm https:setup  first." >&2; exit 1; }
DEV_ALLOWED_ORIGINS="$(grep '^DEV_ALLOWED_ORIGINS=' "$ROOT/.env.lan" | cut -d= -f2-)"
export DEV_ALLOWED_ORIGINS NEXT_TELEMETRY_DISABLED=1
cd "$ROOT/apps/web"
node scripts/copy-vendor.mjs
exec npx next dev --port 3000 --hostname 0.0.0.0 --experimental-https \
  --experimental-https-key "$ROOT/ops/dev-https/certs/lan-key.pem" \
  --experimental-https-cert "$ROOT/ops/dev-https/certs/lan.pem"
