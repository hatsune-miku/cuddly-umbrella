#!/usr/bin/env bash
set -euo pipefail

release="environment-resource-proxy-20260826-1203"
root="/home/miku/cuddly-umbrella"
payload="/home/miku/cuddly-deploy/${release}"
backup="/home/miku/cuddly-backups/pre-${release}"
compose=(docker compose -p cuddly -f docker-compose.yml -f docker-compose.production.yml)

wait_for_health() {
  local container="$1"
  local deadline=$((SECONDS + 90))
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

mkdir -p "$backup" "$payload"
cd "$root"

for service in control-api gateway console; do
  image_id="$(docker inspect -f '{{.Image}}' "cuddly-${service}-1")"
  docker image inspect "$image_id" >/dev/null
  docker image tag "$image_id" "cuddly-${service}:pre-${release}"
done

docker exec cuddly-postgres-1 pg_dump -U cuddly -d cuddly -Fc >"$backup/postgres.dump"
tar \
  --exclude='./data' \
  --exclude='./release' \
  --exclude='./node_modules' \
  --exclude='*/node_modules' \
  --exclude='*/dist' \
  -czf "$backup/source.tar.gz" \
  -C "$root" .
docker exec cuddly-postgres-1 psql -U cuddly -d cuddly -AtF '|' -c \
  "SELECT slug,backend_origin,use_internal_proxy FROM environments ORDER BY slug;" \
  >"$backup/environments-before.txt"

tar -xzf "$payload/source.tar.gz" -C "$root"

for service in control-api gateway; do
  docker build \
    --network host \
    --build-arg HTTP_PROXY=http://127.0.0.1:7897 \
    --build-arg HTTPS_PROXY=http://127.0.0.1:7897 \
    -f docker/node-service.Dockerfile \
    --build-arg "APP=${service}" \
    -t "cuddly-${service}:${release}" \
    .
  docker image tag "cuddly-${service}:${release}" "cuddly-${service}:latest"
done

docker build \
  --network host \
  --build-arg HTTP_PROXY=http://127.0.0.1:7897 \
  --build-arg HTTPS_PROXY=http://127.0.0.1:7897 \
  -f docker/console.Dockerfile \
  -t "cuddly-console:${release}" \
  .
docker image tag "cuddly-console:${release}" cuddly-console:latest

"${compose[@]}" up -d --no-deps --no-build control-api
wait_for_health cuddly-control-api-1

docker exec -i cuddly-postgres-1 psql -v ON_ERROR_STOP=1 -U cuddly -d cuddly <<'SQL'
UPDATE environments
SET resource_proxy_prefixes = '["https://img.chuanyuapp.com/"]'::jsonb
WHERE slug = 'tttt';

INSERT INTO audit_events (id, actor, action, subject_type, subject_id, payload)
SELECT gen_random_uuid(), 'gz', 'environment.resource_proxy.configure', 'environment', id::text,
       jsonb_build_object('slug', slug, 'resourceProxyPrefixes', resource_proxy_prefixes)
FROM environments
WHERE slug = 'tttt';
SQL

"${compose[@]}" up -d --no-deps --no-build gateway console
wait_for_health cuddly-gateway-1
wait_for_health cuddly-console-1

docker exec cuddly-postgres-1 psql -U cuddly -d cuddly -AtF '|' -c \
  "SELECT slug,backend_origin,use_internal_proxy,resource_proxy_prefixes FROM environments ORDER BY slug;" \
  >"$backup/environments-after.txt"

curl -fsS http://127.0.0.1:9872/health/ready >/dev/null
curl -fsS http://127.0.0.1:9888/ >/dev/null

printf 'release=%s\nbackup=%s\n' "$release" "$backup"
