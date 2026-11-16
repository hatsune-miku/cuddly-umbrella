#!/usr/bin/env bash
set -euo pipefail

release_tag="20260825-170803"
root="/home/miku/cuddly-umbrella"
backup="/home/miku/cuddly-backups/pre-artifact-single-slot-${release_tag}"
compose=(docker compose -p cuddly -f docker-compose.yml -f docker-compose.production.yml)

cd "$root"
mkdir -p "$backup"

"${compose[@]}" stop build-worker
active_jobs="$(docker exec cuddly-postgres-1 psql -U cuddly -d cuddly -Atc \
  "SELECT count(*) FROM build_jobs WHERE status NOT IN ('SUCCEEDED','FAILED','CANCELED')")"
if [[ "$active_jobs" != "0" ]]; then
  "${compose[@]}" start build-worker
  echo "Refusing backup with ${active_jobs} active build jobs" >&2
  exit 1
fi
"${compose[@]}" stop control-api

docker image inspect \
  sha256:7aee68633ebaff9a6b33b23db2abbd4c547e457db9e3d792daf9e45f19d7fcbc \
  sha256:84ebe9569c2441bf131395271fd49b05620768ac35a355baf1ffd7ba95773d1c \
  sha256:dd1b9e2a6a31740f1ddb0657ed952e5e039366a1f2ad04cb1bbfb70965bbb694 \
  sha256:b063a40d110df3b9ad9429e7c1ba08d10c481a7cc0d053fcf3a76b540c582d2c \
  >/dev/null
docker image tag \
  sha256:7aee68633ebaff9a6b33b23db2abbd4c547e457db9e3d792daf9e45f19d7fcbc \
  "cuddly-runner-agent:pre-artifact-single-slot-${release_tag}"
docker image tag \
  sha256:84ebe9569c2441bf131395271fd49b05620768ac35a355baf1ffd7ba95773d1c \
  "cuddly-build-worker:pre-artifact-single-slot-${release_tag}"
docker image tag \
  sha256:dd1b9e2a6a31740f1ddb0657ed952e5e039366a1f2ad04cb1bbfb70965bbb694 \
  "cuddly-control-api:pre-artifact-single-slot-${release_tag}"
docker image tag \
  sha256:b063a40d110df3b9ad9429e7c1ba08d10c481a7cc0d053fcf3a76b540c582d2c \
  "cuddly-gateway:pre-artifact-single-slot-${release_tag}"

docker exec cuddly-postgres-1 pg_dump -U cuddly -d cuddly -Fc >"$backup/postgres.dump"
mkdir -p "$backup/artifacts"
cp -al "$root/data/docker/artifacts/." "$backup/artifacts/"
tar \
  --exclude='./data' \
  --exclude='./release' \
  --exclude='./node_modules' \
  --exclude='*/node_modules' \
  --exclude='*/dist' \
  -czf "$backup/source.tar.gz" \
  -C "$root" .

docker exec cuddly-postgres-1 psql -U cuddly -d cuddly -Atc \
  "SELECT status || '|' || count(*) FROM artifacts GROUP BY status ORDER BY status" \
  >"$backup/artifact-status-before.txt"
find "$root/data/docker/artifacts/ready" -mindepth 2 -maxdepth 2 -type d -printf '%P\n' \
  | sort >"$backup/artifact-directories-before.txt"

echo "$backup"
