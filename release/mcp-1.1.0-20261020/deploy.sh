#!/usr/bin/env bash
set -euo pipefail
cd /home/miku/cuddly-umbrella
release=release/mcp-1.1.0-20261020
old_control=sha256:da08d88ea12d579d7718484ec452eb1c7c2ff855744b05ed5ee7d83b3d709a9a
old_console=sha256:595d08f2fc4ed286fc7acb93b2c279155fd380ab85830a77726b1d9148b922d0
test "$(docker inspect cuddly-control-api-1 --format '{{.Image}}')" = "$old_control"
test "$(docker inspect cuddly-console-1 --format '{{.Image}}')" = "$old_console"
docker tag "$old_control" cuddly-control-api:before-mcp-1.1.0-20261020
docker tag "$old_console" cuddly-console:before-mcp-1.1.0-20261020
mkdir -p "$release/stage"
tar -xzf "$release/image.tar.gz" -C "$release/stage"
docker build --pull=false -f "$release/stage/control.Dockerfile" -t cuddly-control-api:mcp-1.1.0-20261020 "$release/stage"
docker build --pull=false -f "$release/stage/console.Dockerfile" -t cuddly-console:mcp-1.1.0-20261020 "$release/stage"
docker run --rm --network cuddly_default --entrypoint nginx cuddly-console:mcp-1.1.0-20261020 -t
compose=(docker compose -p cuddly -f docker-compose.yml -f docker-compose.production.yml)
switched=0
cleanup() {
  result=$?
  trap - EXIT
  if test "$result" != 0 && test "$switched" = 1; then
    docker tag "$old_control" cuddly-control-api:latest
    docker tag "$old_console" cuddly-console:latest
    tar -xzf "$release/sources-before.tar.gz"
    "${compose[@]}" up -d --no-deps --no-build --wait --wait-timeout 60 control-api console || true
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
docker tag cuddly-control-api:mcp-1.1.0-20261020 cuddly-control-api:latest
docker tag cuddly-console:mcp-1.1.0-20261020 cuddly-console:latest
"${compose[@]}" up -d --no-deps --no-build --wait --wait-timeout 60 control-api console
docker exec cuddly-control-api-1 node -e '
  (async () => {
    const ready = await fetch("http://127.0.0.1:9880/health/ready");
    if (!ready.ok) throw Error("API not ready");
    const base = "https://bifrost.vanillacake.cn";
    const resource = base + "/api/v1/mcp";
    const unauth = await fetch(resource);
    if (unauth.status !== 401 || !unauth.headers.get("www-authenticate")?.includes("resource_metadata=")) throw Error("MCP authentication discovery failed");
    const meta = await fetch(base + "/.well-known/oauth-protected-resource/api/v1/mcp").then(r => r.json());
    if (meta.resource !== resource) throw Error("Protected resource metadata not proxied");
    const oauth = await fetch(base + "/.well-known/oauth-authorization-server").then(r => r.json());
    if (!oauth.code_challenge_methods_supported?.includes("S256")) throw Error("PKCE metadata missing");
    const auth = await fetch(base + "/api/v1/auth/session");
    if (auth.status !== 401) throw Error("Regular API authentication broken");
    const internal = await fetch(base + "/api/v1/internal/proxy-config");
    if (internal.status !== 404) throw Error("Internal API exposed");
    const home = await fetch(base);
    if (!home.ok) throw Error("Console unavailable");
    console.log("Live HTTPS MCP discovery, PKCE, anonymous denial, internal isolation and console passed");
  })().catch(e => {console.error(e); process.exit(1)});
'
docker exec cuddly-control-api-1 sha256sum /app/apps/control-api/dist/main.js
docker inspect cuddly-control-api-1 cuddly-console-1 --format '{{.Name}} {{.Image}}'
echo 'HTTP MCP deployed; runner, gateway and worker unchanged.'
