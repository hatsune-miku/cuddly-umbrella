#!/usr/bin/env bash
set -euo pipefail
cd /home/miku/cuddly-umbrella
release=release/mcp-1.0.0-20261020
old_control=sha256:c767f6baf97ebfc28996c01ec968c27581cd918b5180b960e561a7d0cef17103
test "$(docker inspect cuddly-control-api-1 --format '{{.Image}}')" = "$old_control"
docker tag "$old_control" cuddly-control-api:before-mcp-1.0.0-20261020
mkdir -p "$release/stage"
tar -xzf "$release/image.tar.gz" -C "$release/stage"
docker build --pull=false -f "$release/stage/control.Dockerfile" -t cuddly-control-api:mcp-1.0.0-20261020 "$release/stage"
compose=(docker compose -p cuddly -f docker-compose.yml -f docker-compose.production.yml)
switched=0
cleanup() {
  result=$?
  trap - EXIT
  if test "$result" != 0 && test "$switched" = 1; then
    docker tag "$old_control" cuddly-control-api:latest
    tar -xzf "$release/sources-before.tar.gz"
    "${compose[@]}" up -d --no-deps --no-build --wait --wait-timeout 60 control-api || true
  fi
  exit "$result"
}
trap cleanup EXIT
tar -tzf "$release/sources.tar.gz" > "$release/source-paths.txt"
while IFS= read -r file; do
  case "$file" in /*|*../*) echo 'Unsafe archive path'; exit 1;; esac
  if test -e "$file"; then printf '%s\n' "$file"; fi
done < "$release/source-paths.txt" > "$release/existing-paths.txt"
tar --no-recursion -czf "$release/sources-before.tar.gz" -T "$release/existing-paths.txt"
switched=1
tar -xzf "$release/sources.tar.gz"
docker tag cuddly-control-api:mcp-1.0.0-20261020 cuddly-control-api:latest
"${compose[@]}" up -d --no-deps --no-build --wait --wait-timeout 60 control-api
docker exec cuddly-control-api-1 node -e '
  (async () => {
    const ready = await fetch("http://127.0.0.1:9880/health/ready");
    if (!ready.ok) throw Error("API not ready");
    const auth = await fetch("http://127.0.0.1:9880/api/v1/auth/session");
    if (auth.status !== 401) throw Error("Unauthenticated API should remain protected");
    const token = await fetch("http://127.0.0.1:9880/api/v1/auth/mcp/token", {
      method: "POST", headers: {"content-type":"application/json"}, body:"{}"
    });
    if (token.status !== 400 || (await token.json()).code !== "MCP_INVALID_GRANT") throw Error("MCP grant route unavailable");
    console.log("API ready; anonymous access blocked; MCP grant validation active");
  })().catch(e => {console.error(e); process.exit(1)});
'
docker exec cuddly-control-api-1 sha256sum /app/apps/control-api/dist/main.js
docker inspect cuddly-control-api-1 --format '{{.Name}} {{.Image}}'
echo 'MCP API support deployed. Runner, gateway, worker and console unchanged.'
