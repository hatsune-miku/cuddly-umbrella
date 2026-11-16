#!/usr/bin/env bash
set -euo pipefail
cd /home/miku/cuddly-umbrella
release=release/workspace-no-check-20260918
old_runner=sha256:e1304ad5bea56bfadec3f8ba64d187ef257138c93accb12d3983f54fde0cdc95
test "$(docker inspect cuddly-runner-agent-1 --format '{{.Image}}')" = "$old_runner"
docker tag "$old_runner" cuddly-runner-agent:before-workspace-no-check-20260918
mkdir -p "$release/stage"
tar -xzf "$release/image.tar.gz" -C "$release/stage"
docker build --pull=false -f "$release/stage/runner.Dockerfile" -t cuddly-runner-agent:workspace-no-check-20260918 "$release/stage"
compose=(docker compose -p cuddly -f docker-compose.yml -f docker-compose.production.yml)
paused=0
switched=0
cleanup() {
  result=$?
  trap - EXIT
  if test "$result" != 0 && test "$switched" = 1; then
    docker tag "$old_runner" cuddly-runner-agent:latest
    tar -xzf "$release/sources-before.tar.gz"
    "${compose[@]}" up -d --no-deps --no-build --wait --wait-timeout 60 runner-agent || true
  fi
  if test "$paused" = 1; then docker unpause cuddly-build-worker-1; fi
  exit "$result"
}
trap cleanup EXIT
docker pause cuddly-build-worker-1
paused=1
docker exec cuddly-runner-agent-1 node -e 'fetch("http://127.0.0.1:9882/health/ready").then(r=>r.json()).then(s=>{if(s.busy || s.activeCount !== 0) throw new Error("Runner busy; no restart"); console.log("Runner idle")})'
active=$(docker exec cuddly-postgres-1 psql -U cuddly -d cuddly -Atc "select count(*) from build_jobs where status not in ('QUEUED','SUCCEEDED','FAILED','CANCELED');")
test "$active" = 0 || { echo 'Active build lease; no restart'; exit 1; }
tar -tzf "$release/sources.tar.gz" > "$release/source-paths.txt"
while IFS= read -r file; do
  case "$file" in /*|*../*) echo 'Unsafe archive path'; exit 1;; esac
  if test -e "$file"; then printf '%s\n' "$file"; fi
done < "$release/source-paths.txt" > "$release/existing-paths.txt"
tar --no-recursion -czf "$release/sources-before.tar.gz" -T "$release/existing-paths.txt"
switched=1
tar -xzf "$release/sources.tar.gz"
docker tag cuddly-runner-agent:workspace-no-check-20260918 cuddly-runner-agent:latest
"${compose[@]}" up -d --no-deps --no-build --wait --wait-timeout 60 runner-agent
docker exec cuddly-runner-agent-1 sha256sum /app/apps/runner-agent/dist/main.js
docker exec cuddly-runner-agent-1 node -e 'fetch("http://127.0.0.1:9882/health/ready").then(r=>{if(!r.ok)throw Error("Not ready");return r.json()}).then(console.log)'
docker unpause cuddly-build-worker-1
paused=0
docker inspect cuddly-runner-agent-1 --format '{{.Name}} {{.Image}}'
echo 'Workspace noCheck deployed; dispatch resumed.'
