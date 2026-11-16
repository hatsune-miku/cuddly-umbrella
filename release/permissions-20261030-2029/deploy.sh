#!/usr/bin/env bash
set -euo pipefail
release=permissions-20261030-2029
repo=/home/miku/cuddly-umbrella
stage=/home/miku/cuddly-releases/$release
backup=/home/miku/cuddly-backups/pre-$release
test -f "$stage/apps/control-api/dist/main.js"
test -f "$stage/apps/console/dist/index.html"
test ! -e "$backup"
install -d -m 0700 "$backup"
umask 077
docker exec cuddly-postgres-1 pg_dump -U cuddly -d cuddly -Fc > "$backup/database.dump"
test -s "$backup/database.dump"
docker exec -i cuddly-postgres-1 pg_restore --list < "$backup/database.dump" > "$backup/database-contents.txt"
cd "$repo"
tar --exclude=node_modules --exclude='*/node_modules' -czf "$backup/source.tar.gz" apps/control-api apps/console apps/mcp-server packages/contracts packages/db
docker inspect cuddly-control-api-1 cuddly-console-1 --format '{{.Name}} {{.Image}}' > "$backup/images.txt"
docker tag "$(docker inspect cuddly-control-api-1 --format '{{.Image}}')" "cuddly-control-api:pre-$release"
docker tag "$(docker inspect cuddly-console-1 --format '{{.Image}}')" "cuddly-console:pre-$release"
docker build -f "$stage/release/$release/control.Dockerfile" -t "cuddly-control-api:$release" "$stage"
docker build -f "$stage/release/$release/console.Dockerfile" -t "cuddly-console:$release" "$stage"
docker run --rm --entrypoint node "cuddly-control-api:$release" --check /app/apps/control-api/dist/main.js
tar -C "$stage" -cf - apps/control-api apps/console apps/mcp-server packages/contracts packages/db | tar -C "$repo" -xf -
docker tag "cuddly-control-api:$release" cuddly-control-api:latest
docker tag "cuddly-console:$release" cuddly-console:latest
docker compose -p cuddly -f docker-compose.yml -f docker-compose.production.yml up -d --no-deps --no-build --wait --wait-timeout 90 control-api console
docker ps --filter name=cuddly --format '{{.Names}} {{.Status}}'
printf 'Backup: %s\n' "$backup"
