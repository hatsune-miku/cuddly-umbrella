#!/usr/bin/env bash
set -euo pipefail
cd /home/miku/cuddly-umbrella
release=release/remote-incremental-config-20260918
old=sha256:c7d153c4b18f4a117bc215b5116f40c33cdb0495ad528e9fc5d89ecf5d091306
test "$(docker inspect cuddly-runner-agent-1 --format '{{.Image}}')" = "$old"
docker tag "$old" cuddly-runner-agent:before-remote-incremental-20260918
docker build --pull=false -f "$release/runner.Dockerfile" -t cuddly-runner-agent:remote-incremental-20260918 "$release"
compose=(docker compose -p cuddly -f docker-compose.yml -f docker-compose.production.yml)
paused=0
switched=0
cleanup() {
  result=$?
  trap - EXIT
  if test "$result" != 0 && test "$switched" = 1; then
    docker tag "$old" cuddly-runner-agent:latest
    tar -xzf "$release/sources-before.tar.gz"
    "${compose[@]}" up -d --no-deps --no-build --wait --wait-timeout 60 runner-agent || true
  fi
  if test "$paused" = 1; then docker unpause cuddly-build-worker-1; fi
  exit "$result"
}
trap cleanup EXIT
# Quiesce dispatch before the idle check so a new job cannot slip into the restart window.
docker pause cuddly-build-worker-1
paused=1
docker exec cuddly-runner-agent-1 node -e 'fetch("http://127.0.0.1:9882/health/ready").then(r=>r.json()).then(s=>{if(s.busy || s.activeCount !== 0) throw new Error("Runner busy; deployment aborted without restart"); console.log("Runner idle")})'
active=$(docker exec cuddly-postgres-1 psql -U cuddly -d cuddly -Atc "select count(*) from build_jobs where status not in ('QUEUED','SUCCEEDED','FAILED','CANCELED');")
test "$active" = 0 || { echo 'Active build lease; deployment aborted without restart'; exit 1; }
tar -czf "$release/sources-before.tar.gz" apps/runner-agent/src/runner.ts apps/runner-agent/src/runner.test.ts apps/runner-agent/dist/main.js
tar -xzf "$release/sources.tar.gz"
switched=1
docker tag cuddly-runner-agent:remote-incremental-20260918 cuddly-runner-agent:latest
"${compose[@]}" up -d --no-deps --no-build --wait --wait-timeout 60 runner-agent
docker exec cuddly-runner-agent-1 node -e 'fetch("http://127.0.0.1:9882/health/ready").then(r=>{if(!r.ok)throw new Error("Runner not ready"); return r.json()}).then(s=>console.log(JSON.stringify(s)))'
docker exec cuddly-runner-agent-1 sha256sum /app/apps/runner-agent/dist/main.js
docker unpause cuddly-build-worker-1
paused=0
docker inspect cuddly-runner-agent-1 --format '{{.Image}}'
echo 'Runner updated; dispatch resumed. No website or other services restarted.'
