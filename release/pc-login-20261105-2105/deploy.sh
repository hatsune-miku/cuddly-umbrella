#!/usr/bin/env bash
set -euo pipefail
repo=/home/miku/cuddly-umbrella
stage=/home/miku/cuddly-releases/pc-login-20261105-2105
backup=/home/miku/cuddly-backups/pre-pc-login-20261105-2105
test ! -e "$backup"
install -d -m 0700 "$backup"
umask 077
docker exec cuddly-postgres-1 pg_dump -U cuddly -d cuddly -Fc > "$backup/database.dump"
test -s "$backup/database.dump"
cd "$repo"
tar --exclude=node_modules --exclude='*/node_modules' -czf "$backup/source.tar.gz" apps/control-api apps/console/pc-plugin apps/console/public/pc-plugin apps/browser-extension/popup.js docs/BIFROST_USER_GUIDE.md README.md
docker tag "$(docker inspect cuddly-control-api-1 --format '{{.Image}}')" cuddly-control-api:pre-pc-login-20261105-2105
docker tag "$(docker inspect cuddly-console-1 --format '{{.Image}}')" cuddly-console:pre-pc-login-20261105-2105
docker build -f "$stage/release/pc-login-20261105-2105/control.Dockerfile" -t cuddly-control-api:pc-login-20261105-2105 "$stage"
docker build -f "$stage/release/pc-login-20261105-2105/console.Dockerfile" -t cuddly-console:pc-login-20261105-2105 "$stage"
docker run --rm --entrypoint node cuddly-control-api:pc-login-20261105-2105 --check /app/apps/control-api/dist/main.js
tar -C "$stage" -cf - apps/control-api/src/app.ts apps/control-api/src/pc-login.ts apps/control-api/src/pc-login.test.ts apps/control-api/src/auth-routes.test.ts apps/control-api/dist apps/console/pc-plugin apps/console/public/pc-plugin apps/browser-extension/popup.js docs/BIFROST_USER_GUIDE.md README.md | tar -C "$repo" -xf -
docker tag cuddly-control-api:pc-login-20261105-2105 cuddly-control-api:latest
docker tag cuddly-console:pc-login-20261105-2105 cuddly-console:latest
docker compose -p cuddly -f docker-compose.yml -f docker-compose.production.yml up -d --no-deps --no-build --wait --wait-timeout 90 control-api console
docker ps --filter name=cuddly --format '{{.Names}} {{.Status}}'
