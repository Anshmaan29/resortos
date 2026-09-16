#!/usr/bin/env bash
# CI: start MinIO and create the test bucket (service containers cannot pass a command).
set -euo pipefail
docker run -d --name resortos-minio -p 9000:9000 \
  -e MINIO_ROOT_USER=resortos -e MINIO_ROOT_PASSWORD=resortos-dev-minio-secret \
  quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z server /data
for i in $(seq 1 60); do curl -sf http://localhost:9000/minio/health/ready && break; sleep 1; done
docker run --rm --network host -v "$PWD/ops/storage/create-buckets.sh:/create-buckets.sh:ro" \
  --entrypoint sh quay.io/minio/mc:RELEASE.2025-08-13T08-35-41Z /create-buckets.sh localhost:9000
