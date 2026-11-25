#!/usr/bin/env bash
set -euo pipefail
repo=/home/miku/cuddly-umbrella
backup=/home/miku/cuddly-backups/pre-dependency-egress-20261117
cd "$repo"
compose=(docker compose -p cuddly -f docker-compose.yml -f docker-compose.production.yml)
active=$(docker exec cuddly-postgres-1 psql -U cuddly -d cuddly -Atc "SELECT count(*) FROM build_jobs WHERE status NOT IN ('QUEUED','SUCCEEDED','FAILED','CANCELED')")
test "$active" = 0
"${compose[@]}" stop build-worker
trap '"${compose[@]}" start build-worker' EXIT
docker exec cuddly-runner-agent-1 node -e "fetch('http://127.0.0.1:9882/health/ready').then(r=>r.json()).then(r=>{if(r.activeCount)process.exit(1)})"
"${compose[@]}" stop runner-agent
cp "$backup/docker-compose.production.yml" docker-compose.production.yml
docker rm -f cuddly-runner-egress-1
tar -xzf "$backup/source.tar.gz" -C "$repo"
docker tag cuddly-runner-agent:pre-dependency-egress-20261117 cuddly-runner-agent:latest
"${compose[@]}" up -d --no-deps --no-build --force-recreate --wait --wait-timeout 60 runner-agent
