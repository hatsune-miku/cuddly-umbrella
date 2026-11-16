#!/usr/bin/env bash
set -euo pipefail
repo=/home/miku/cuddly-umbrella
stage=/home/miku/cuddly-releases/mcp-identity-20261106-1122
backup=/home/miku/cuddly-backups/pre-mcp-identity-20261106-1122
test ! -e "$backup"
install -d -m 0700 "$backup"
umask 077
cd "$repo"
tar -czf "$backup/source.tar.gz" apps/mcp-server/src/client.ts apps/control-api/dist
docker tag "$(docker inspect cuddly-control-api-1 --format '{{.Image}}')" cuddly-control-api:pre-mcp-identity-20261106-1122
docker build -f "$stage/release/mcp-identity-20261106-1122/control.Dockerfile" -t cuddly-control-api:mcp-identity-20261106-1122 "$stage"
tar -C "$stage" -cf - apps/mcp-server/src/client.ts apps/mcp-server/src/server.test.ts apps/mcp-server/src/integration.test.ts apps/mcp-server/scripts/verify-http-login.ts apps/mcp-server/scripts/smoke.mjs apps/mcp-server/README.md apps/mcp-server/dist apps/control-api/dist | tar -C "$repo" -xf -
docker tag cuddly-control-api:mcp-identity-20261106-1122 cuddly-control-api:latest
docker compose -p cuddly -f docker-compose.yml -f docker-compose.production.yml up -d --no-deps --no-build --wait --wait-timeout 90 control-api
docker ps --filter name=cuddly-control-api --format '{{.Names}} {{.Status}}'
