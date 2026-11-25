#!/usr/bin/env bash
set -Eeuo pipefail
repo=/home/miku/cuddly-umbrella
stage=/home/miku/cuddly-releases/dependency-egress-20261117
backup=/home/miku/cuddly-backups/pre-dependency-egress-20261117
cd "$repo"
compose=(docker compose -p cuddly -f docker-compose.yml -f docker-compose.production.yml)

function require_idle() {
  local active
  active=$(docker exec cuddly-postgres-1 psql -U cuddly -d cuddly -Atc "SELECT count(*) FROM build_jobs WHERE status NOT IN ('QUEUED','SUCCEEDED','FAILED','CANCELED')")
  test "$active" = 0
  docker exec cuddly-runner-agent-1 node -e "fetch('http://127.0.0.1:9882/health/ready').then(r=>r.json()).then(r=>{if(!r.ok||r.activeCount!==0)process.exit(1)}).catch(()=>process.exit(1))"
}

require_idle
# Refuse to overwrite a Runner source changed since the inspected upstream baseline.
test "$(sha256sum apps/runner-agent/src/runner.ts | cut -d' ' -f1)" = 5eb37e33d40cead942b92fb66087b7656a40dac2170daea904baba2fe06a6362
umask 077
if [ ! -e "$backup" ]; then
  mkdir -p "$backup"
  tar -czf "$backup/source.tar.gz" apps/runner-agent/src apps/runner-agent/dist docker-compose.production.yml
  cp docker-compose.production.yml "$backup/docker-compose.production.yml"
  docker tag "$(docker inspect cuddly-runner-agent-1 --format '{{.Image}}')" cuddly-runner-agent:pre-dependency-egress-20261117
else
  test -s "$backup/source.tar.gz"
  cmp "$backup/docker-compose.production.yml" docker-compose.production.yml
  test "$(docker inspect cuddly-runner-agent-1 --format '{{.Image}}')" = "$(docker image inspect cuddly-runner-agent:pre-dependency-egress-20261117 --format '{{.Id}}')"
fi
# Migrate with an authorized sudo/trustd session before stopping the queue.
test -d "$repo/data/docker/dependency-cache/toolchains/corepack/v1"
docker image inspect cuddly-runner-agent:dependency-egress-20261117 >/dev/null
docker image inspect cuddly-runner-egress:dependency-egress-20261117 >/dev/null
docker compose -p cuddly -f docker-compose.yml -f "$stage/docker-compose.production.yml" config --quiet

worker_stopped=0
switched=0
function recover() {
  local status=$?
  trap - ERR
  set +e
  if [ "$switched" = 1 ]; then
    "${compose[@]}" stop runner-agent
    cp "$backup/docker-compose.production.yml" docker-compose.production.yml
    docker rm -f cuddly-runner-egress-1
    tar -xzf "$backup/source.tar.gz" -C "$repo"
    docker tag cuddly-runner-agent:pre-dependency-egress-20261117 cuddly-runner-agent:latest
    "${compose[@]}" up -d --no-deps --no-build --force-recreate --wait --wait-timeout 60 runner-agent
  fi
  if [ "$worker_stopped" = 1 ]; then "${compose[@]}" start build-worker; fi
  echo "Deployment failed; recovery attempted. Backup: $backup" >&2
  exit "$status"
}
trap recover ERR
"${compose[@]}" stop build-worker
worker_stopped=1
require_idle
# Preserve the old writable-layer caches before recreating the container.
if [ ! -s "$backup/legacy-download-caches.tar" ]; then
  docker exec cuddly-runner-agent-1 tar -C /root -cf - .cache .npm .local/share/pnpm/store > "$backup/legacy-download-caches.tar.partial"
  mv "$backup/legacy-download-caches.tar.partial" "$backup/legacy-download-caches.tar"
fi

cp "$stage/docker-compose.production.yml" docker-compose.production.yml
switched=1
cp "$stage/docker/runner-egress.Dockerfile" "$stage/docker/runner-egress.yaml" docker/
tar -xzf "$stage/runner-source.tar.gz" -C "$repo"
docker tag cuddly-runner-agent:dependency-egress-20261117 cuddly-runner-agent:latest
docker tag cuddly-runner-egress:dependency-egress-20261117 cuddly-runner-egress:latest
"${compose[@]}" up -d --no-deps --no-build --wait --wait-timeout 60 runner-egress
"${compose[@]}" up -d --no-deps --no-build --force-recreate --wait --wait-timeout 60 runner-agent
docker exec -i cuddly-control-api-1 node --input-type=module <<'JS'
const response = await fetch('http://runner-agent:9882/health/ready', { signal: AbortSignal.timeout(5000) })
const status = await response.json()
if (!response.ok || !status.ok || status.activeCount !== 0) process.exit(1)
console.log('Runner reachable through existing Docker service name')
JS
docker run --rm --network container:cuddly-runner-egress-1 -v "$stage/release:/probe:ro" --entrypoint node cuddly-runner-agent:dependency-egress-20261117 /probe/network-probe.mjs
"${compose[@]}" start build-worker
worker_stopped=0
trap - ERR
"${compose[@]}" ps --format '{{.Service}} {{.State}} {{.Health}}'
echo "Release dependency-egress-20261117 deployed. Backup: $backup"
