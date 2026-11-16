#!/usr/bin/env bash
set -euo pipefail

release="configuration-groups-20260826-1303"
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

docker image tag "cuddly-control-api:pre-${release}" cuddly-control-api:latest
"${compose[@]}" up -d --no-deps --no-build control-api
wait_for_health cuddly-control-api-1
