#!/usr/bin/env bash
set -euo pipefail

release="multi-env-20260825-193318"
root="/home/miku/cuddly-umbrella"
payload="/home/miku/cuddly-deploy/${release}"
backup="/home/miku/cuddly-backups/pre-${release}"
compose=(docker compose -p cuddly -f docker-compose.yml -f docker-compose.production.yml)
services=(control-api build-worker runner-agent gateway console)

cd "$root"
mkdir -p "$backup"

active_jobs="$(docker exec cuddly-postgres-1 psql -U cuddly -d cuddly -Atc \
  "SELECT count(*) FROM build_jobs WHERE status NOT IN ('SUCCEEDED','FAILED','CANCELED')")"
if [[ "$active_jobs" != "0" ]]; then
  echo "Refusing deployment with ${active_jobs} active build jobs" >&2
  exit 1
fi

"${compose[@]}" stop build-worker
active_jobs="$(docker exec cuddly-postgres-1 psql -U cuddly -d cuddly -Atc \
  "SELECT count(*) FROM build_jobs WHERE status NOT IN ('SUCCEEDED','FAILED','CANCELED')")"
if [[ "$active_jobs" != "0" ]]; then
  "${compose[@]}" start build-worker
  echo "Refusing backup with ${active_jobs} active build jobs" >&2
  exit 1
fi

for service in "${services[@]}"; do
  image_id="$(docker inspect -f '{{.Image}}' "cuddly-${service}-1")"
  docker image inspect "$image_id" >/dev/null
  docker image tag "$image_id" "cuddly-${service}:pre-${release}"
done

docker exec cuddly-postgres-1 pg_dump -U cuddly -d cuddly -Fc >"$backup/postgres.dump"
docker exec cuddly-postgres-1 psql -U cuddly -d cuddly -AtF '|' -c \
  "SELECT 'jobs',count(*) FROM build_jobs; SELECT 'artifacts',count(*) FROM artifacts; SELECT 'revisions',count(*) FROM environment_revisions; SELECT 'bindings',count(*) FROM site_bindings;" \
  >"$backup/database-counts-before.txt"

find "$root/data/docker/artifacts" -type f -printf '%P|%s\n' | sort \
  >"$backup/artifact-files-before.txt"
tar \
  --exclude='./data' \
  --exclude='./release' \
  --exclude='./node_modules' \
  --exclude='*/node_modules' \
  --exclude='*/dist' \
  -czf "$backup/source.tar.gz" \
  -C "$root" .

tar -xf "$payload/source-overlay.tar" -C "$root"
mkdir -p "$root/release/$release"
cp "$payload/MANIFEST.md" "$root/release/$release/MANIFEST.md"
cp "$payload/ROLLBACK.md" "$root/release/$release/ROLLBACK.md"
cp "$payload/cuddly-kook-preview-0.5.0.zip" \
  "$root/release/$release/cuddly-kook-preview-0.5.0.zip"

"${compose[@]}" build "${services[@]}"
for service in "${services[@]}"; do
  docker image tag "cuddly-${service}:latest" "cuddly-${service}:${release}"
done

"${compose[@]}" up -d --no-deps --no-build control-api
deadline=$((SECONDS + 90))
control_health="starting"
while (( SECONDS < deadline )); do
  control_health="$(docker inspect -f '{{.State.Health.Status}}' cuddly-control-api-1)"
  [[ "$control_health" == "healthy" ]] && break
  sleep 2
done
if [[ "$control_health" != "healthy" ]]; then
  echo "Control API failed health check: ${control_health}" >&2
  exit 1
fi

"${compose[@]}" up -d --no-deps --no-build runner-agent gateway console
deadline=$((SECONDS + 90))
runner_health="starting"
gateway_health="starting"
console_health="starting"
while (( SECONDS < deadline )); do
  runner_health="$(docker inspect -f '{{.State.Health.Status}}' cuddly-runner-agent-1)"
  gateway_health="$(docker inspect -f '{{.State.Health.Status}}' cuddly-gateway-1)"
  console_health="$(docker inspect -f '{{.State.Health.Status}}' cuddly-console-1)"
  if [[ "$runner_health" == "healthy" && "$gateway_health" == "healthy" && "$console_health" == "healthy" ]]; then
    break
  fi
  sleep 2
done
if [[ "$runner_health" != "healthy" || "$gateway_health" != "healthy" || "$console_health" != "healthy" ]]; then
  echo "Service health failure: runner=${runner_health} gateway=${gateway_health} console=${console_health}" >&2
  exit 1
fi

"${compose[@]}" up -d --no-deps --no-build build-worker
deadline=$((SECONDS + 60))
worker_state="created"
while (( SECONDS < deadline )); do
  worker_state="$(docker inspect -f '{{.State.Status}}' cuddly-build-worker-1)"
  [[ "$worker_state" == "running" ]] && break
  sleep 2
done
if [[ "$worker_state" != "running" ]]; then
  echo "Build worker failed to start: ${worker_state}" >&2
  exit 1
fi

curl -fsS http://127.0.0.1:9888/api/v1/admin/environments >/dev/null
curl -fsS http://127.0.0.1:9888/api/v1/environments/shared/matrix >/dev/null
curl -fsS http://127.0.0.1:9872/health/ready >/dev/null

docker exec cuddly-postgres-1 psql -U cuddly -d cuddly -AtF '|' -c \
  "SELECT 'environment',slug,status,backend_origin FROM environments ORDER BY slug; SELECT 'project_environment_configs',count(*) FROM project_environment_configs; SELECT 'jobs',count(*) FROM build_jobs; SELECT 'artifacts',count(*) FROM artifacts; SELECT 'revisions',count(*) FROM environment_revisions; SELECT 'bindings',count(*) FROM site_bindings;" \
  >"$backup/database-counts-after.txt"

printf 'release=%s\nbackup=%s\n' "$release" "$backup"
