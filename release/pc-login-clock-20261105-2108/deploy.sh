#!/usr/bin/env bash
set -euo pipefail
repo=/home/miku/cuddly-umbrella
stage=/home/miku/cuddly-releases/pc-login-clock-20261105-2108
cd "$repo"
docker build -f "$stage/release/pc-login-clock-20261105-2108/control.Dockerfile" -t cuddly-control-api:pc-login-clock-20261105-2108 "$stage"
docker build -f "$stage/release/pc-login-clock-20261105-2108/console.Dockerfile" -t cuddly-console:pc-login-clock-20261105-2108 "$stage"
tar -C "$stage" -cf - apps/control-api/src/pc-login.ts apps/control-api/src/pc-login.test.ts apps/control-api/dist apps/console/pc-plugin apps/console/public/pc-plugin scripts/verify-pc-login.cjs | tar -C "$repo" -xf -
docker tag cuddly-control-api:pc-login-clock-20261105-2108 cuddly-control-api:latest
docker tag cuddly-console:pc-login-clock-20261105-2108 cuddly-console:latest
docker compose -p cuddly -f docker-compose.yml -f docker-compose.production.yml up -d --no-deps --no-build --wait --wait-timeout 90 control-api console
docker ps --filter name=cuddly --format '{{.Names}} {{.Status}}'
