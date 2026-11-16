#!/usr/bin/env bash
set -euo pipefail
cd /home/miku/cuddly-umbrella
release=release/mcp-1.1.0-20261020
previous=sha256:02203ce3a001c0523f22b57d44672716562f9912bdf3cdd77310a704bb5e9c0e
test "$(docker inspect cuddly-control-api-1 --format '{{.Image}}')" = "$previous"
docker tag "$previous" cuddly-control-api:mcp-1.1.0-initial
tar -xzf "$release/image.tar.gz" -C "$release/stage"
docker build --pull=false -f "$release/stage/control.Dockerfile" -t cuddly-control-api:mcp-1.1.0-20261020 "$release/stage"
compose=(docker compose -p cuddly -f docker-compose.yml -f docker-compose.production.yml)
switched=0
cleanup() {
  result=$?
  trap - EXIT
  if test "$result" != 0 && test "$switched" = 1; then
    docker tag "$previous" cuddly-control-api:latest
    tar -xzf "$release/sources-before-hardening.tar.gz"
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
tar --no-recursion -czf "$release/sources-before-hardening.tar.gz" -T "$release/existing-paths.txt"
switched=1
tar -xzf "$release/sources.tar.gz"
docker tag cuddly-control-api:mcp-1.1.0-20261020 cuddly-control-api:latest
"${compose[@]}" up -d --no-deps --no-build --wait --wait-timeout 60 control-api
docker exec cuddly-control-api-1 node -e '
  (async () => {
    const ready = await fetch("http://127.0.0.1:9880/health/ready");
    if (!ready.ok) throw Error("Not ready");
    const base = "https://bifrost.vanillacake.cn";
    const denied = await fetch(base + "/api/v1/mcp");
    if (denied.status !== 401) throw Error("MCP auth failed");
    const oauth = await fetch(base + "/.well-known/oauth-authorization-server").then(r => r.json());
    if (!oauth.registration_endpoint) throw Error("Discovery failed");
    const remaining = [];
    for (const fake of ["192.0.2.11", "192.0.2.12"]) {
      const response = await fetch(base + "/api/v1/auth/mcp-http/authorize", { headers: { "x-forwarded-for": fake } });
      if (response.status !== 400) throw Error("Validation failed");
      remaining.push(Number(response.headers.get("ratelimit-remaining")));
    }
    if (remaining[0] - remaining[1] !== 1) throw Error("Forwarded header rate-limit bypass");
    console.log("Live HTTPS discovery, auth and proxy rate-limit isolation passed");
  })().catch(e => { console.error(e); process.exit(1) });
'
docker exec cuddly-control-api-1 sha256sum /app/apps/control-api/dist/main.js
docker inspect cuddly-control-api-1 --format '{{.Image}}'
