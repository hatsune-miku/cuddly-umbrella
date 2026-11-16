#!/usr/bin/env bash
set -euo pipefail
cd /home/miku/cuddly-umbrella
release=release/classic-20260916-1719
test "$(docker inspect cuddly-console-1 --format '{{.Image}}')" = 'sha256:432955ee8ada43db7ab60cefb48c8c6b3d2fc22a6ca83a8b8bb8cc40eb82be94'
docker tag 432955ee8ada43db7ab60cefb48c8c6b3d2fc22a6ca83a8b8bb8cc40eb82be94 cuddly-console:before-classic-20260916-1719
mkdir -p "$release/stage"
tar -xzf "$release/images.tar.gz" -C "$release/stage"
docker build --pull=false --build-arg BASE_IMAGE=cuddly-console:before-classic-20260916-1719 \
  -f "$release/stage/console.Dockerfile" -t cuddly-console:classic-20260916-1719 "$release/stage"
docker run --rm cuddly-console:classic-20260916-1719 nginx -t
tar -tzf "$release/sources.tar.gz" > "$release/source-paths.txt"
while IFS= read -r file; do
  case "$file" in /*|*../*) echo 'Unsafe archive path'; exit 1;; esac
  if test -e "$file"; then printf '%s\n' "$file"; fi
done < "$release/source-paths.txt" > "$release/existing-paths.txt"
if test -f docs/FRONTEND_REDESIGN_0.12.1.md; then printf '%s\n' docs/FRONTEND_REDESIGN_0.12.1.md >> "$release/existing-paths.txt"; fi
tar --no-recursion -czf "$release/sources-before.tar.gz" -T "$release/existing-paths.txt"
compose=(docker compose -p cuddly -f docker-compose.yml -f docker-compose.production.yml)
rollback() {
  trap - ERR
  docker tag cuddly-console:before-classic-20260916-1719 cuddly-console:latest
  tar -xzf "$release/sources-before.tar.gz"
  "${compose[@]}" up -d --no-deps --no-build --wait --wait-timeout 60 console
  exit 1
}
trap rollback ERR
tar -xzf "$release/sources.tar.gz"
rm -f -- docs/FRONTEND_REDESIGN_0.12.1.md
docker tag cuddly-console:classic-20260916-1719 cuddly-console:latest
"${compose[@]}" up -d --no-deps --no-build --wait --wait-timeout 60 console
curl --fail --silent --show-error http://127.0.0.1:9888/ > /dev/null
curl --fail --silent --show-error http://127.0.0.1:9888/ui/cakeui-theme.css > /dev/null
"${compose[@]}" ps
trap - ERR
echo 'Classic CakeUI restored. No backend services were restarted.'
