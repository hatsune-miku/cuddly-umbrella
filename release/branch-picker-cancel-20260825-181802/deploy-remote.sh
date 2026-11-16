#!/usr/bin/env bash
set -euo pipefail

release="branch-picker-cancel-20260825-181802"
root="/home/miku/cuddly-umbrella"
payload="/home/miku/cuddly-deploy/${release}"
backup="/home/miku/cuddly-backups/pre-${release}"
compose=(docker compose -p cuddly -f docker-compose.yml -f docker-compose.production.yml)

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
"${compose[@]}" stop control-api

for service in control-api build-worker runner-agent console; do
  image_id="$(docker inspect -f '{{.Image}}' "cuddly-${service}-1")"
  docker image inspect "$image_id" >/dev/null
  docker image tag "$image_id" "cuddly-${service}:pre-${release}"
done

docker exec cuddly-postgres-1 pg_dump -U cuddly -d cuddly -Fc >"$backup/postgres.dump"
docker exec cuddly-postgres-1 psql -U cuddly -d cuddly -AtF '|' -c \
  "SELECT install_command, build_command FROM build_targets WHERE id='webapp'" \
  >"$backup/webapp-commands-before.txt"
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

cd "$payload"
for service in control-api build-worker runner-agent console; do
  docker build \
    -f "Dockerfile.${service}" \
    -t "cuddly-${service}:${release}" \
    .
  docker image tag "cuddly-${service}:${release}" "cuddly-${service}:latest"
done

cd "$root"
"${compose[@]}" up -d --no-deps --no-build runner-agent control-api

deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
  runner_health="$(docker inspect -f '{{.State.Health.Status}}' cuddly-runner-agent-1)"
  control_health="$(docker inspect -f '{{.State.Health.Status}}' cuddly-control-api-1)"
  if [[ "$runner_health" == "healthy" && "$control_health" == "healthy" ]]; then
    break
  fi
  sleep 2
done
if [[ "$runner_health" != "healthy" || "$control_health" != "healthy" ]]; then
  echo "Core services failed health checks: runner=${runner_health} control=${control_health}" >&2
  exit 1
fi

"${compose[@]}" up -d --no-deps --no-build build-worker console
deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
  console_health="$(docker inspect -f '{{.State.Health.Status}}' cuddly-console-1)"
  worker_state="$(docker inspect -f '{{.State.Status}}' cuddly-build-worker-1)"
  if [[ "$console_health" == "healthy" && "$worker_state" == "running" ]]; then
    break
  fi
  sleep 2
done
if [[ "$console_health" != "healthy" || "$worker_state" != "running" ]]; then
  echo "Front/worker services failed checks: console=${console_health} worker=${worker_state}" >&2
  exit 1
fi

printf 'release=%s\nbackup=%s\n' "$release" "$backup"
