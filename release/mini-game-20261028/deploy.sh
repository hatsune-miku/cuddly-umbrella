#!/usr/bin/env bash
set -euo pipefail
cd /home/miku/cuddly-umbrella
release=release/mini-game-20261028
old_control=sha256:21f5bf8a8f1eb2da7147c9936354152451d582f7da8d702b760b1720af5ea6c8
old_runner=sha256:a1d667eaa6a42d5dd8e0acf8222ed2ca4fd8ff277297240c15886a6e26d243dc
test "$(docker inspect cuddly-control-api-1 --format '{{.Image}}')" = "$old_control"
test "$(docker inspect cuddly-runner-agent-1 --format '{{.Image}}')" = "$old_runner"
test ! -e "$release/sources-before.tar.gz"
docker tag "$old_control" cuddly-control-api:before-mini-game-20261028
docker tag "$old_runner" cuddly-runner-agent:before-mini-game-20261028
mkdir -p "$release/stage"
tar -xzf "$release/image.tar.gz" -C "$release/stage"
docker build --pull=false -f "$release/stage/control.Dockerfile" -t cuddly-control-api:mini-game-20261028 "$release/stage"
docker build --pull=false -f "$release/stage/runner.Dockerfile" -t cuddly-runner-agent:mini-game-20261028 "$release/stage"
compose=(docker compose -p cuddly -f docker-compose.yml -f docker-compose.production.yml)
paused=0
switched=0
cleanup() {
  result=$?
  trap - EXIT
  if test "$result" != 0 && test "$switched" = 1; then
    docker tag "$old_control" cuddly-control-api:latest
    docker tag "$old_runner" cuddly-runner-agent:latest
    tar -xzf "$release/sources-before.tar.gz"
    "${compose[@]}" up -d --no-deps --no-build --wait --wait-timeout 60 control-api runner-agent || true
  fi
  if test "$paused" = 1; then docker unpause cuddly-build-worker-1; fi
  exit "$result"
}
trap cleanup EXIT
docker pause cuddly-build-worker-1
paused=1
docker exec cuddly-runner-agent-1 node -e 'fetch("http://127.0.0.1:9882/health/ready").then(r=>r.json()).then(s=>{if(s.busy || s.activeCount !== 0) throw Error("Runner busy; no restart"); console.log("Runner idle")}).catch(e=>{console.error(e);process.exit(1)})'
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
docker tag cuddly-control-api:mini-game-20261028 cuddly-control-api:latest
docker tag cuddly-runner-agent:mini-game-20261028 cuddly-runner-agent:latest
"${compose[@]}" up -d --no-deps --no-build --wait --wait-timeout 60 control-api runner-agent
docker exec cuddly-control-api-1 node -e '(async()=>{const r=await fetch("http://127.0.0.1:9880/health/ready");if(!r.ok)throw Error("Control not ready");const a=await fetch("https://bifrost.vanillacake.cn/api/v1/mcp");if(a.status!==401)throw Error("MCP auth failed");console.log("Control ready; public HTTPS auth healthy")})().catch(e=>{console.error(e);process.exit(1)})'
docker exec cuddly-runner-agent-1 node -e 'fetch("http://127.0.0.1:9882/health/ready").then(r=>{if(!r.ok)throw Error("Runner not ready");return r.json()}).then(console.log).catch(e=>{console.error(e);process.exit(1)})'
test "$(docker exec cuddly-postgres-1 psql -U cuddly -d cuddly -Atc "select count(*) from build_targets where id='mini_game' and output_directory='apps/mini_game/dist';")" = 1
docker exec cuddly-control-api-1 sha256sum /app/apps/control-api/dist/main.js
docker exec cuddly-runner-agent-1 sha256sum /app/apps/runner-agent/dist/main.js
docker unpause cuddly-build-worker-1
paused=0
docker inspect cuddly-control-api-1 cuddly-runner-agent-1 --format '{{.Name}} {{.Image}}'
echo 'Bifrost mini_game support deployed; no build jobs created.'
