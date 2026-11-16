#!/usr/bin/env bash
set -euo pipefail

release="product-brand-20260826-1329"
root="/home/miku/cuddly-umbrella"
payload="/home/miku/cuddly-deploy/${release}"
backup="/home/miku/cuddly-backups/pre-${release}"
extension_archive="cuddly-kook-preview-0.10.3.zip"
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

active_build_count() {
  docker exec cuddly-postgres-1 psql -U cuddly -d cuddly -Atc \
    "SELECT count(id) FROM build_jobs WHERE status IN ('LEASED','CHECKOUT','INSTALLING','BUILDING','VALIDATING','UPLOADING','CANCELING');"
}

mkdir -p "$backup" "$payload" "$root/release"
cd "$root"

for service in console gateway runner-agent; do
  image_id="$(docker inspect -f '{{.Image}}' "cuddly-${service}-1")"
  docker image inspect "$image_id" >/dev/null
  docker image tag "$image_id" "cuddly-${service}:pre-${release}"
done

tar \
  --exclude='./data' \
  --exclude='./release' \
  --exclude='./node_modules' \
  --exclude='*/node_modules' \
  --exclude='*/dist' \
  --exclude='./.git' \
  --exclude='./.playwright-mcp' \
  -czf "$backup/source.tar.gz" \
  -C "$root" .

tar -xzf "$payload/source.tar.gz" -C "$root"
cp "$payload/$extension_archive" "$root/release/$extension_archive"

docker build \
  --network host \
  --build-arg HTTP_PROXY=http://127.0.0.1:7897 \
  --build-arg HTTPS_PROXY=http://127.0.0.1:7897 \
  -f docker/console.Dockerfile \
  -t "cuddly-console:${release}" \
  .

for service in gateway runner-agent; do
  docker build \
    --network host \
    --build-arg HTTP_PROXY=http://127.0.0.1:7897 \
    --build-arg HTTPS_PROXY=http://127.0.0.1:7897 \
    -f docker/node-service.Dockerfile \
    --build-arg "APP=${service}" \
    -t "cuddly-${service}:${release}" \
    .
done

if [[ "$(active_build_count)" != "0" ]]; then
  printf 'A build became active while images were built; no service was switched.\n' >&2
  exit 20
fi

for service in console gateway runner-agent; do
  docker image tag "cuddly-${service}:${release}" "cuddly-${service}:latest"
done

"${compose[@]}" up -d --no-deps --no-build runner-agent
wait_for_health cuddly-runner-agent-1
"${compose[@]}" up -d --no-deps --no-build gateway
wait_for_health cuddly-gateway-1
"${compose[@]}" up -d --no-deps --no-build console
wait_for_health cuddly-console-1

curl -fsS http://127.0.0.1:9888/ >/dev/null
curl -fsS http://127.0.0.1:9872/health/ready >/dev/null
docker exec cuddly-console-1 sh -c "grep -R -q 'Cuddly' /usr/share/nginx/html/assets"
grep -q '"name": "Cuddly QA"' apps/browser-extension/manifest.json

printf 'release=%s\nbackup=%s\nconsole_image=%s\ngateway_image=%s\nrunner_image=%s\n' \
  "$release" \
  "$backup" \
  "$(docker inspect -f '{{.Image}}' cuddly-console-1)" \
  "$(docker inspect -f '{{.Image}}' cuddly-gateway-1)" \
  "$(docker inspect -f '{{.Image}}' cuddly-runner-agent-1)"
