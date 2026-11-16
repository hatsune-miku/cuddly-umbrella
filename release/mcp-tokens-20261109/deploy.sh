#!/usr/bin/env bash
set -euo pipefail
repo=/home/miku/cuddly-umbrella
stage=/home/miku/cuddly-releases/mcp-tokens-20261109
backup=/home/miku/cuddly-backups/pre-mcp-tokens-20261109
cd "$repo"
compose=(docker compose -p cuddly -f docker-compose.yml -f docker-compose.production.yml)
test ! -e "$backup"
install -d -m 0700 "$backup"
umask 077
tar -czf "$backup/source.tar.gz" packages/contracts/src packages/db/src apps/control-api/src apps/control-api/dist apps/mcp-server/src apps/mcp-server/dist apps/mcp-server/scripts apps/mcp-server/README.md apps/mcp-server/client.example.json apps/mcp-server/client.http.example.json apps/console/src apps/console/dist docs/BIFROST_USER_GUIDE.md
for service in control-api console; do
  docker tag "$(docker inspect "cuddly-$service-1" --format '{{.Image}}')" "cuddly-$service:pre-mcp-tokens-20261109"
done
docker build -f "$stage/release/mcp-tokens-20261109/control.Dockerfile" -t cuddly-control-api:mcp-tokens-20261109 "$stage"
docker build -f "$stage/release/mcp-tokens-20261109/console.Dockerfile" -t cuddly-console:mcp-tokens-20261109 "$stage"
active=$(docker exec cuddly-postgres-1 psql -U cuddly -d cuddly -Atc "SELECT count(*) FROM build_jobs WHERE status NOT IN ('QUEUED','SUCCEEDED','FAILED','CANCELED')")
if [ "$active" != '0' ]; then echo "Active builds: $active; deployment deferred"; exit 2; fi
"${compose[@]}" stop build-worker
active=$(docker exec cuddly-postgres-1 psql -U cuddly -d cuddly -Atc "SELECT count(*) FROM build_jobs WHERE status NOT IN ('QUEUED','SUCCEEDED','FAILED','CANCELED')")
if [ "$active" != '0' ]; then "${compose[@]}" start build-worker; echo 'Build started during preflight; deferred'; exit 2; fi
"${compose[@]}" stop console control-api
docker exec cuddly-postgres-1 pg_dump -U cuddly -d cuddly -Fc > "$backup/database.dump"
test -s "$backup/database.dump"
tar -C "$stage" -cf - packages/contracts/src packages/db/src apps/control-api/src apps/control-api/scripts apps/control-api/dist apps/mcp-server/src apps/mcp-server/dist apps/mcp-server/scripts apps/mcp-server/README.md apps/mcp-server/client.example.json apps/mcp-server/client.http.example.json apps/console/src apps/console/dist docs/BIFROST_USER_GUIDE.md | tar -C "$repo" -xf -
for service in control-api console; do docker tag "cuddly-$service:mcp-tokens-20261109" "cuddly-$service:latest"; done
"${compose[@]}" up -d --no-deps --no-build --wait --wait-timeout 90 control-api
"${compose[@]}" up -d --no-deps --no-build --wait --wait-timeout 90 console
"${compose[@]}" start build-worker
docker exec cuddly-postgres-1 psql -U cuddly -d cuddly -v ON_ERROR_STOP=1 -Atc "SELECT 'token_table=' || count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='mcp_personal_tokens'; SELECT 'token_records=' || count(*) FROM mcp_personal_tokens;"
"${compose[@]}" ps --format '{{.Service}} {{.State}} {{.Health}}'
echo "Release mcp-tokens-20261109 deployed. Backup: $backup"
