#!/usr/bin/env bash
set -euo pipefail
repo=/home/miku/cuddly-umbrella
stage=/home/miku/cuddly-releases/profile-20261106
backup=/home/miku/cuddly-backups/pre-profile-20261106
cd "$repo"
compose=(docker compose -p cuddly -f docker-compose.yml -f docker-compose.production.yml)
test ! -e "$backup"
install -d -m 0700 "$backup"
umask 077
tar -czf "$backup/source.tar.gz" packages/contracts/src packages/db/src apps/control-api/src apps/control-api/dist apps/gateway/src/app.ts apps/gateway/dist apps/build-worker/dist apps/mcp-server/src apps/mcp-server/dist apps/mcp-server/scripts apps/mcp-server/README.md apps/console/src apps/console/dist apps/browser-extension/popup.html apps/browser-extension/popup.js docs/BIFROST_USER_GUIDE.md
for service in control-api gateway build-worker console; do
  docker tag "$(docker inspect "cuddly-$service-1" --format '{{.Image}}')" "cuddly-$service:pre-profile-20261106"
done
for spec in 'control control-api' 'gateway gateway' 'worker build-worker' 'console console'; do
  read -r file service <<< "$spec"
  docker build -f "$stage/release/profile-20261106/$file.Dockerfile" -t "cuddly-$service:profile-20261106" "$stage"
done
active=$(docker exec cuddly-postgres-1 psql -U cuddly -d cuddly -Atc "SELECT count(*) FROM build_jobs WHERE status NOT IN ('QUEUED','SUCCEEDED','FAILED','CANCELED')")
if [ "$active" != '0' ]; then echo "Active builds: $active; deployment deferred before stopping services"; exit 2; fi
"${compose[@]}" stop console control-api gateway build-worker
active=$(docker exec cuddly-postgres-1 psql -U cuddly -d cuddly -Atc "SELECT count(*) FROM build_jobs WHERE status NOT IN ('QUEUED','SUCCEEDED','FAILED','CANCELED')")
if [ "$active" != '0' ]; then "${compose[@]}" start control-api gateway build-worker console; echo 'Build started during deployment preflight; deferred'; exit 2; fi
docker exec cuddly-postgres-1 pg_dump -U cuddly -d cuddly -Fc > "$backup/database.dump"
test -s "$backup/database.dump"
tar -C "$stage" -cf - packages/contracts/src packages/db/src apps/control-api/src apps/control-api/scripts apps/control-api/dist apps/gateway/src/app.ts apps/gateway/dist apps/build-worker/dist apps/mcp-server/src apps/mcp-server/dist apps/mcp-server/scripts apps/mcp-server/README.md apps/console/src apps/console/dist apps/browser-extension/popup.html apps/browser-extension/popup.js docs/BIFROST_USER_GUIDE.md docs/IDENTITY_PRIVACY.md | tar -C "$repo" -xf -
for service in control-api gateway build-worker console; do docker tag "cuddly-$service:profile-20261106" "cuddly-$service:latest"; done
"${compose[@]}" up -d --no-deps --no-build --wait --wait-timeout 90 control-api
"${compose[@]}" up -d --no-deps --no-build --wait --wait-timeout 90 gateway build-worker console
docker exec cuddly-postgres-1 psql -U cuddly -d cuddly -v ON_ERROR_STOP=1 -Atc "SELECT 'migration=' || count(*) FROM authorization_migrations WHERE id='20261106-public-profile-v1'; SELECT 'missing_public_names=' || count(*) FROM user_accounts WHERE display_name IS NULL OR name<>display_name; SELECT 'provider_usernames_in_public=' || count(*) FROM user_accounts WHERE username_source<>'bifrost' AND username<>''; SELECT 'private_profile_rows=' || count(*) FROM user_private_profiles;"
"${compose[@]}" ps --format '{{.Service}} {{.State}} {{.Health}}'
echo "Release profile-20261106 deployed. Backup: $backup"
