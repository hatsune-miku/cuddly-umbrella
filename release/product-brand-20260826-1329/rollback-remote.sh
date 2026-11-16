#!/usr/bin/env bash
set -euo pipefail

release="product-brand-20260826-1329"
root="/home/miku/cuddly-umbrella"
compose=(docker compose -p cuddly -f docker-compose.yml -f docker-compose.production.yml)

wait_for_health() {
  local container="$1"
  local deadline=$((SECONDS + 120))
  local health="starting"
  while (( SECONDS < deadline )); do
    health="$(docker inspect -f '{{.State.Health.Status}}' "$container")"
    [[ "$health" == "healthy" ]] && return 0
    sleep 2
  done
  docker logs --tail=100 "$container" >&2 || true
  printf '%s did not become healthy: %s\n' "$container" "$health" >&2
  return 1
}

cd "$root"
docker image tag "cuddly-console:pre-${release}" cuddly-console:latest
"${compose[@]}" up -d --no-deps --no-build console
wait_for_health cuddly-console-1

docker image tag "cuddly-gateway:pre-${release}" cuddly-gateway:latest
"${compose[@]}" up -d --no-deps --no-build gateway
wait_for_health cuddly-gateway-1

active_builds="$(docker exec cuddly-postgres-1 psql -U cuddly -d cuddly -Atc \
  "SELECT count(id) FROM build_jobs WHERE status IN ('LEASED','CHECKOUT','INSTALLING','BUILDING','VALIDATING','UPLOADING','CANCELING');")"
if [[ "$active_builds" != "0" ]]; then
  printf 'Console and Gateway rolled back; Runner rollback deferred because a build is active.\n' >&2
  exit 20
fi

docker image tag "cuddly-runner-agent:pre-${release}" cuddly-runner-agent:latest
"${compose[@]}" up -d --no-deps --no-build runner-agent
wait_for_health cuddly-runner-agent-1
