#!/usr/bin/env bash
set -euo pipefail
repo=/home/miku/cuddly-umbrella
stage=/home/miku/cuddly-releases/pc-login-form-20261105-2110
cd "$repo"
docker build -f "$stage/release/pc-login-form-20261105-2110/control.Dockerfile" -t cuddly-control-api:pc-login-form-20261105-2110 "$stage"
tar -C "$stage" -cf - apps/control-api/src/pc-login.ts apps/control-api/src/pc-login.test.ts apps/control-api/dist | tar -C "$repo" -xf -
docker tag cuddly-control-api:pc-login-form-20261105-2110 cuddly-control-api:latest
docker compose -p cuddly -f docker-compose.yml -f docker-compose.production.yml up -d --no-deps --no-build --wait --wait-timeout 90 control-api
docker ps --filter name=cuddly-control-api --format '{{.Names}} {{.Status}}'
