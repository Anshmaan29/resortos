# Community MinIO is source-only. Build audited upstream commits instead of depending
# on container tags that have been removed from public registries.
FROM golang:1.24.8-alpine3.22 AS source
RUN apk add --no-cache ca-certificates git
ENV GOTOOLCHAIN=local CGO_ENABLED=0

FROM source AS minio-build
WORKDIR /src
ADD https://github.com/minio/minio/archive/9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a.tar.gz /tmp/source.tar.gz
RUN tar xzf /tmp/source.tar.gz --strip-components=1 && go build -trimpath -o /out/minio .

FROM source AS mc-build
WORKDIR /src
ADD https://github.com/minio/mc/archive/7394ce0dd2a80935aded936b09fa12cbb3cb8096.tar.gz /tmp/source.tar.gz
RUN tar xzf /tmp/source.tar.gz --strip-components=1 && go build -trimpath -o /out/mc .

FROM alpine:3.22 AS minio
COPY --from=source /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=minio-build /out/minio /usr/bin/minio
COPY --from=minio-build /src/LICENSE /usr/share/licenses/minio/LICENSE
EXPOSE 9000 9001
ENTRYPOINT ["minio"]

FROM alpine:3.22 AS mc
COPY --from=source /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=mc-build /out/mc /usr/bin/mc
COPY --from=mc-build /src/LICENSE /usr/share/licenses/mc/LICENSE
ENTRYPOINT ["mc"]
