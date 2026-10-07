#!/usr/bin/env bash
# CI: start MinIO and create the test bucket (service containers cannot pass a command).
set -euo pipefail
docker build --target minio -t resortos-minio-source:2025-10-15 -f ops/storage/Dockerfile ops/storage
docker build --target mc -t resortos-mc-source:2025-08-13 -f ops/storage/Dockerfile ops/storage
docker run -d --name resortos-minio -p 9000:9000 \
  -e MINIO_ROOT_USER=resortos -e MINIO_ROOT_PASSWORD=resortos-dev-minio-secret \
  resortos-minio-source:2025-10-15 server /data
for i in $(seq 1 60); do curl -sf http://localhost:9000/minio/health/ready && break; sleep 1; done
curl -sf http://localhost:9000/minio/health/ready || { docker logs resortos-minio; exit 1; }
docker run --rm --network host -v "$PWD/ops/storage/create-buckets.sh:/create-buckets.sh:ro" \
  --entrypoint sh resortos-mc-source:2025-08-13 /create-buckets.sh localhost:9000
