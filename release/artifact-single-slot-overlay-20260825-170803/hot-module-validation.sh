#!/usr/bin/env bash
set -euo pipefail

site_artifact_id="$({
  docker exec cuddly-postgres-1 psql -U cuddly -d cuddly -At -c \
    "SELECT item.artifact_id FROM environments AS environment JOIN environment_revision_items AS item ON item.revision_id = environment.current_revision_id WHERE environment.slug = 'shared' AND item.target_id = 'webapp'"
} | tr -d '\r')"
remote_artifact_id="$({
  docker exec cuddly-postgres-1 psql -U cuddly -d cuddly -At -c \
    "SELECT id FROM artifacts WHERE target_id = 'base' AND branch = 'master' AND status = 'READY' ORDER BY built_at DESC, id DESC LIMIT 1"
} | tr -d '\r')"
entry_path="$({
  docker exec cuddly-postgres-1 psql -U cuddly -d cuddly -At -c \
    "SELECT manifest -> 'serve' -> 'remote' ->> 'entryPath' FROM artifacts WHERE id = '$remote_artifact_id'"
} | tr -d '\r')"
test -n "$site_artifact_id"
test -n "$remote_artifact_id"
test -n "$entry_path"

body="$(printf '{"siteBindingId":"main","siteArtifactId":"%s","selections":[{"targetId":"base","artifactId":"%s"}],"ttlMinutes":5}' "$site_artifact_id" "$remote_artifact_id")"
response="$(curl --fail-with-body --silent --show-error \
  -X POST 'http://127.0.0.1:9888/api/v1/previews' \
  -H 'content-type: application/json' \
  -H 'x-cuddly-actor: gz' \
  --data "$body")"
token="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])' <<<"$response")"
test -n "$token"
trap 'curl --silent --show-error --output /dev/null -X DELETE "http://127.0.0.1:9888/api/v1/previews/$token" || true' EXIT

site_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  -H 'Host: main.bifrost.vanillacake.cn' \
  -H "x-cuddly-preview-token: $token" \
  'http://127.0.0.1:9872/')"
entry_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  -H 'Host: main.bifrost.vanillacake.cn' \
  "http://127.0.0.1:9872/__cuddly/preview-artifacts/$remote_artifact_id/$entry_path")"
hot_module_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  -H 'Host: main.bifrost.vanillacake.cn' \
  -H "x-cuddly-preview-token: $token" \
  'http://127.0.0.1:9872/api/v3/version/hot-module')"
test "$site_status" = 200
test "$entry_status" = 200
test "$hot_module_status" = 200 -o "$hot_module_status" = 401
printf 'site_preview_status=%s\n' "$site_status"
printf 'remote_entry_status=%s\n' "$entry_status"
printf 'hot_module_unauthenticated_status=%s\n' "$hot_module_status"

curl --fail-with-body --silent --show-error --output /dev/null \
  -X DELETE "http://127.0.0.1:9888/api/v1/previews/$token"
trap - EXIT
after="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  "http://127.0.0.1:9888/api/v1/previews/$token")"
printf 'preview_get_after_revoke=%s\n' "$after"
