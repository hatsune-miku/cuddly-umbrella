#!/usr/bin/env bash
set -euo pipefail
cd /home/miku/cuddly-umbrella
release=release/sidepanel-0.12.9

test "$(docker inspect cuddly-console-1 --format '{{.Image}}')" = 'sha256:ffcd60d6e9ec6e91fa71d15595ca3675a1b6c3be96e445ea643b1e3d05820ff5'
docker tag ffcd60d6e9ec6e91fa71d15595ca3675a1b6c3be96e445ea643b1e3d05820ff5 cuddly-console:before-sidepanel-0.12.9
mkdir -p "$release/stage"
tar -xzf "$release/images.tar.gz" -C "$release/stage"
docker build --pull=false --build-arg BASE_IMAGE=cuddly-console:before-sidepanel-0.12.9 \
  -f "$release/stage/console.Dockerfile" -t cuddly-console:sidepanel-0.12.9 "$release/stage"
docker run --rm cuddly-console:sidepanel-0.12.9 nginx -t
tar -tzf "$release/sources.tar.gz" > "$release/source-paths.txt"
while IFS= read -r file; do
  case "$file" in /*|*../*) echo 'Unsafe archive path'; exit 1;; esac
  if test -e "$file"; then printf '%s\n' "$file"; fi
done < "$release/source-paths.txt" > "$release/existing-paths.txt"
tar --no-recursion -czf "$release/sources-before.tar.gz" -T "$release/existing-paths.txt"
compose=(docker compose -p cuddly -f docker-compose.yml -f docker-compose.production.yml)
rollback() {
  trap - ERR
  docker tag cuddly-console:before-sidepanel-0.12.9 cuddly-console:latest
  tar -xzf "$release/sources-before.tar.gz"
  "${compose[@]}" up -d --no-deps --no-build --wait --wait-timeout 60 console
  exit 1
}
trap rollback ERR
tar -xzf "$release/sources.tar.gz"
docker tag cuddly-console:sidepanel-0.12.9 cuddly-console:latest
"${compose[@]}" up -d --no-deps --no-build --wait --wait-timeout 60 console
curl --fail --silent --show-error http://127.0.0.1:9888/pc-plugin/bifrost.js > /dev/null
"${compose[@]}" ps
trap - ERR
echo 'Side panel UI deployed; backend services retained.'
