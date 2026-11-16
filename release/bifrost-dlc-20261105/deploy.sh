#!/usr/bin/env bash
set -euo pipefail
repo=/home/miku/cuddly-umbrella
stage=/home/miku/cuddly-releases/bifrost-dlc-20261105
backup=/home/miku/cuddly-backups/pre-bifrost-dlc-20261105
test ! -e "$backup"
install -d -m 0700 "$backup"
umask 077
docker exec cuddly-postgres-1 pg_dump -U cuddly -d cuddly -Fc > "$backup/database.dump"
test -s "$backup/database.dump"
cd "$repo"
tar --exclude=node_modules --exclude='*/node_modules' -czf "$backup/source.tar.gz" apps/control-api apps/console/pc-plugin apps/console/public/pc-plugin docs/BIFROST_USER_GUIDE.md
docker tag "$(docker inspect cuddly-control-api-1 --format '{{.Image}}')" cuddly-control-api:pre-bifrost-dlc-20261105
docker tag "$(docker inspect cuddly-console-1 --format '{{.Image}}')" cuddly-console:pre-bifrost-dlc-20261105
docker build -f "$stage/release/bifrost-dlc-20261105/control.Dockerfile" -t cuddly-control-api:bifrost-dlc-20261105 "$stage"
docker build -f "$stage/release/bifrost-dlc-20261105/console.Dockerfile" -t cuddly-console:bifrost-dlc-20261105 "$stage"
docker run --rm --entrypoint node cuddly-control-api:bifrost-dlc-20261105 --check /app/apps/control-api/dist/main.js
tar -C "$stage" -cf - apps/control-api/src/app.ts apps/control-api/dist apps/console/pc-plugin apps/console/public/pc-plugin docs/BIFROST_USER_GUIDE.md | tar -C "$repo" -xf -
docker tag cuddly-control-api:bifrost-dlc-20261105 cuddly-control-api:latest
docker tag cuddly-console:bifrost-dlc-20261105 cuddly-console:latest
docker compose -p cuddly -f docker-compose.yml -f docker-compose.production.yml up -d --no-deps --no-build --wait --wait-timeout 90 control-api console
docker ps --filter name=cuddly --format '{{.Names}} {{.Status}}'
