#!/usr/bin/env bash
set -euo pipefail

release="multi-env-20260825-193318"
root="/home/miku/cuddly-umbrella"
payload="/home/miku/cuddly-deploy/${release}"
backup="/home/miku/cuddly-backups/pre-${release}"
compose=(docker compose -p cuddly -f docker-compose.yml -f docker-compose.production.yml)
services=(control-api build-worker runner-agent gateway console)

cd "$root"
active_jobs="$(docker exec cuddly-postgres-1 psql -U cuddly -d cuddly -Atc \
  "SELECT count(*) FROM build_jobs WHERE status NOT IN ('SUCCEEDED','FAILED','CANCELED')")"
if [[ "$active_jobs" != "0" ]]; then
  echo "Refusing deployment with ${active_jobs} active build jobs" >&2
  exit 1
fi

test -s "$backup/postgres.dump"
test -s "$backup/source.tar.gz"
test -s "$backup/database-counts-before.txt"
test -s "$backup/artifact-files-before.txt"
grep -q 'project_environment_configs' packages/db/src/schema.ts
for service in "${services[@]}"; do
  docker image inspect "cuddly-${service}:pre-${release}" >/dev/null
done

cd "$payload/image-overlay"
for service in "${services[@]}"; do
  docker build -f "Dockerfile.${service}" -t "cuddly-${service}:${release}" .
  docker image tag "cuddly-${service}:${release}" "cuddly-${service}:latest"
done

cd "$root"
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
  docker logs --tail=100 cuddly-control-api-1 >&2 || true
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

