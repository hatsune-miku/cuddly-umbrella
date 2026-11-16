#!/usr/bin/env bash
set -euo pipefail

job_id=51bb6df9-4ee0-4d30-b76b-28e4f54b6c6e
old_id=84701fbf-94f4-42a4-b722-3ccdde1a93cd
root=/home/miku/cuddly-umbrella/data/docker/artifacts

curl --fail-with-body --silent --show-error \
  "http://127.0.0.1:9888/api/v1/build-jobs/$job_id" |
  python3 -c 'import json,sys; d=json.load(sys.stdin); print("job_status="+d["status"]); print("started_at="+str(d.get("startedAt"))); print("finished_at="+str(d.get("finishedAt"))); print("failure="+str(d.get("failureMessage")))'

docker exec cuddly-postgres-1 psql -U cuddly -d cuddly -AtF '|' -c \
  "SELECT id, status, storage_key, built_at FROM artifacts WHERE target_id = 'base' AND branch = 'master' ORDER BY built_at DESC, id DESC"

if test -d "$root/ready/base/$old_id"; then
  printf 'old_directory_present=yes\n'
else
  printf 'old_directory_present=no\n'
fi
