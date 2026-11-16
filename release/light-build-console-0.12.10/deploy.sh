#!/usr/bin/env bash
set -euo pipefail
cd /home/miku/cuddly-umbrella
release=release/light-build-console-0.12.10
old_console=sha256:8d4346944464c89ff9534445f0d86f6fd3d59174b681e2bbbca53336d7d1327a
old_runner=sha256:7ca175e3daa0ff93f0dd329d6d61dd99c13a4508ffc7a200ab08349058be2c73
test "$(docker inspect cuddly-console-1 --format '{{.Image}}')" = "$old_console"
test "$(docker inspect cuddly-runner-agent-1 --format '{{.Image}}')" = "$old_runner"
docker tag "$old_console" cuddly-console:before-light-console-0.12.10
docker tag "$old_runner" cuddly-runner-agent:before-light-console-0.12.10
mkdir -p "$release/stage"
tar -xzf "$release/images.tar.gz" -C "$release/stage"
docker build --pull=false -f "$release/stage/console.Dockerfile" -t cuddly-console:light-console-0.12.10 "$release/stage"
docker build --pull=false -f "$release/stage/runner.Dockerfile" -t cuddly-runner-agent:light-console-0.12.10 "$release/stage"
docker run --rm cuddly-console:light-console-0.12.10 nginx -t
compose=(docker compose -p cuddly -f docker-compose.yml -f docker-compose.production.yml)
paused=0
switched=0
cleanup() {
  result=$?
  trap - EXIT
  if test "$result" != 0 && test "$switched" = 1; then
    docker tag "$old_runner" cuddly-runner-agent:latest
    docker tag "$old_console" cuddly-console:latest
    tar -xzf "$release/sources-before.tar.gz"
    "${compose[@]}" up -d --no-deps --no-build --wait --wait-timeout 60 runner-agent console || true
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
docker tag cuddly-console:light-console-0.12.10 cuddly-console:latest
docker tag cuddly-runner-agent:light-console-0.12.10 cuddly-runner-agent:latest
"${compose[@]}" up -d --no-deps --no-build --wait --wait-timeout 60 runner-agent console
docker exec cuddly-runner-agent-1 sha256sum /app/apps/runner-agent/dist/main.js
docker unpause cuddly-build-worker-1
paused=0
docker inspect cuddly-runner-agent-1 cuddly-console-1 --format '{{.Name}} {{.Image}}'
echo 'Light console deployed; dispatch resumed.'
