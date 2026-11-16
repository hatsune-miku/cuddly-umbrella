#!/usr/bin/env bash
set -euo pipefail

release="configuration-groups-20260826-1303"
root="/home/miku/cuddly-umbrella"
payload="/home/miku/cuddly-deploy/${release}"
backup="/home/miku/cuddly-backups/pre-${release}"
extension_archive="cuddly-kook-preview-0.10.2.zip"
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

mkdir -p "$backup" "$payload" "$root/release"
cd "$root"

for service in control-api console; do
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
  "SELECT token,created_at FROM configuration_groups ORDER BY created_at DESC,token DESC;" \
  >"$backup/configuration-groups-before.txt"

tar -xzf "$payload/source.tar.gz" -C "$root"
cp "$payload/$extension_archive" "$root/release/$extension_archive"

docker build \
  --network host \
  --build-arg HTTP_PROXY=http://127.0.0.1:7897 \
  --build-arg HTTPS_PROXY=http://127.0.0.1:7897 \
  -f docker/node-service.Dockerfile \
  --build-arg APP=control-api \
  -t "cuddly-control-api:${release}" \
  .

docker build \
  --network host \
  --build-arg HTTP_PROXY=http://127.0.0.1:7897 \
  --build-arg HTTPS_PROXY=http://127.0.0.1:7897 \
  -f docker/console.Dockerfile \
  -t "cuddly-console:${release}" \
  .

docker image tag "cuddly-control-api:${release}" cuddly-control-api:latest
docker image tag "cuddly-console:${release}" cuddly-console:latest

"${compose[@]}" up -d --no-deps --no-build control-api
wait_for_health cuddly-control-api-1

invalid_rows="$(docker exec cuddly-postgres-1 psql -U cuddly -d cuddly -Atc \
  "SELECT count(*) FROM configuration_groups WHERE revision IS NULL OR revision < 1 OR updated_by IS NULL OR updated_at IS NULL;")"
[[ "$invalid_rows" == "0" ]]

trigger_count="$(docker exec cuddly-postgres-1 psql -U cuddly -d cuddly -Atc \
  "SELECT count(*) FROM pg_trigger WHERE tgrelid = 'configuration_groups'::regclass AND tgname = 'configuration_groups_fill_audit' AND NOT tgisinternal;")"
[[ "$trigger_count" == "1" ]]

docker exec -i cuddly-postgres-1 psql -v ON_ERROR_STOP=1 -U cuddly -d cuddly <<'SQL'
BEGIN;
WITH candidate AS (
  SELECT environment.id AS environment_id,
         environment.slug AS environment_slug,
         binding.id AS site_binding_id,
         binding.target_id
  FROM site_bindings AS binding
  JOIN environments AS environment ON environment.slug = binding.environment_slug
  WHERE binding.enabled = true
  ORDER BY binding.id
  LIMIT 1
)
INSERT INTO configuration_groups
  (token, name, environment_id, environment_slug, site_binding_id, schema_version, items, created_by)
SELECT md5('cuddly configuration group rollback probe 20260826-1303'),
       'Rollback compatibility probe',
       environment_id,
       environment_slug,
       site_binding_id,
       1,
       jsonb_build_array(jsonb_build_object('targetId', target_id, 'mode', 'official')),
       'gz'
FROM candidate;

DO $probe$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM configuration_groups
    WHERE token = md5('cuddly configuration group rollback probe 20260826-1303')
      AND revision = 1
      AND updated_by = 'gz'
      AND updated_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'configuration group rollback compatibility probe failed';
  END IF;
END
$probe$;
ROLLBACK;
SQL

"${compose[@]}" up -d --no-deps --no-build console
wait_for_health cuddly-console-1

curl -fsS http://127.0.0.1:9888/ >/dev/null
docker exec cuddly-postgres-1 psql -U cuddly -d cuddly -AtF '|' -c \
  "SELECT token,revision,created_at,updated_at FROM configuration_groups ORDER BY created_at DESC,token DESC;" \
  >"$backup/configuration-groups-after.txt"

printf 'release=%s\nbackup=%s\ncontrol_image=%s\nconsole_image=%s\n' \
  "$release" \
  "$backup" \
  "$(docker inspect -f '{{.Config.Image}}' cuddly-control-api-1)" \
  "$(docker inspect -f '{{.Config.Image}}' cuddly-console-1)"
