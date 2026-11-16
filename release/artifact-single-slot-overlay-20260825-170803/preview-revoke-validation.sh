#!/usr/bin/env bash
set -euo pipefail

site_artifact_id="$({
  docker exec cuddly-postgres-1 psql -U cuddly -d cuddly -At -c \
    "SELECT item.artifact_id FROM environments AS environment JOIN environment_revision_items AS item ON item.revision_id = environment.current_revision_id WHERE environment.slug = 'shared' AND item.target_id = 'webapp'"
} | tr -d '\r')"
test -n "$site_artifact_id"

body="$(printf '{"siteBindingId":"main","siteArtifactId":"%s","selections":[],"ttlMinutes":5}' "$site_artifact_id")"
response="$(curl --fail-with-body --silent --show-error \
  -X POST 'http://127.0.0.1:9888/api/v1/previews' \
  -H 'content-type: application/json' \
  -H 'x-cuddly-actor: gz' \
  --data "$body")"
token="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])' <<<"$response")"
test -n "$token"

before="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  "http://127.0.0.1:9888/api/v1/previews/$token")"
first_delete="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  -X DELETE "http://127.0.0.1:9888/api/v1/previews/$token")"
second_delete="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  -X DELETE "http://127.0.0.1:9888/api/v1/previews/$token")"
after="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  "http://127.0.0.1:9888/api/v1/previews/$token")"

printf 'preview_create=201\n'
printf 'preview_get_before=%s\n' "$before"
printf 'preview_delete_first=%s\n' "$first_delete"
printf 'preview_delete_second=%s\n' "$second_delete"
printf 'preview_get_after=%s\n' "$after"
docker exec cuddly-postgres-1 psql -U cuddly -d cuddly -AtF '|' -c \
  "SELECT revoked_at IS NOT NULL, expires_at > now() FROM preview_sessions WHERE token = '$token'"
