#!/usr/bin/env bash
# API for LAN phone testing: trusts the mkcert CA so it can reach MinIO over HTTPS.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
[[ -f "$ROOT/.env.lan" ]] || { echo "Run  pnpm https:setup  first." >&2; exit 1; }
CA="$(grep '^MKCERT_CA=' "$ROOT/.env.lan" | cut -d= -f2-)"
cd "$ROOT/apps/api"
NODE_EXTRA_CA_CERTS="$CA" exec node --env-file=../../.env --env-file=../../.env.lan --watch -r ./scripts/swc-register.cjs src/main.ts
