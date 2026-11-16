#!/usr/bin/env bash
set -euo pipefail

root=/home/miku/cuddly-umbrella/data/docker/artifacts
old_line="$({
  docker exec cuddly-postgres-1 psql -U cuddly -d cuddly -AtF '|' -c \
    "SELECT id, storage_key, built_at FROM artifacts WHERE target_id = 'base' AND branch = 'master' AND status = 'READY' ORDER BY built_at DESC, id DESC LIMIT 1"
} | tr -d '\r')"
IFS='|' read -r old_id old_storage_key old_built_at <<<"$old_line"
test -n "$old_id"
test -d "$root/$old_storage_key"

response="$(curl --fail-with-body --silent --show-error \
  -X POST 'http://127.0.0.1:9888/api/v1/build-jobs' \
  -H 'content-type: application/json' \
  -H 'x-cuddly-actor: gz' \
  -H 'idempotency-key: retention-live-check-20260825-170803' \
  --data '{"targetId":"base","branch":"master","profile":"qa-web"}')"
job_id="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"$response")"

printf 'job_id=%s\n' "$job_id"
printf 'old_id=%s\n' "$old_id"
printf 'old_storage_key=%s\n' "$old_storage_key"
printf 'old_built_at=%s\n' "$old_built_at"
printf 'old_directory_present=yes\n'
