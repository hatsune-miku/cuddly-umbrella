#!/usr/bin/env bash
set -euo pipefail
cd /home/miku/cuddly-umbrella
release=release/requirements-layout-0.12.3
test "$(docker inspect cuddly-console-1 --format '{{.Image}}')" = 'sha256:c5c357b73f3d217e02b2517309af320c162ae749f9bbcd09d163fefe857fa1c9'
docker tag c5c357b73f3d217e02b2517309af320c162ae749f9bbcd09d163fefe857fa1c9 cuddly-console:before-requirements-layout-0.12.3
mkdir -p "$release/stage"
tar -xzf "$release/images.tar.gz" -C "$release/stage"
docker build --pull=false --build-arg BASE_IMAGE=cuddly-console:before-requirements-layout-0.12.3 \
  -f "$release/stage/console.Dockerfile" -t cuddly-console:requirements-layout-0.12.3 "$release/stage"
docker run --rm cuddly-console:requirements-layout-0.12.3 nginx -t
tar -tzf "$release/sources.tar.gz" > "$release/source-paths.txt"
while IFS= read -r file; do
  case "$file" in /*|*../*) echo 'Unsafe archive path'; exit 1;; esac
  if test -e "$file"; then printf '%s\n' "$file"; fi
done < "$release/source-paths.txt" > "$release/existing-paths.txt"
tar --no-recursion -czf "$release/sources-before.tar.gz" -T "$release/existing-paths.txt"
compose=(docker compose -p cuddly -f docker-compose.yml -f docker-compose.production.yml)
rollback() {
  trap - ERR
  docker tag cuddly-console:before-requirements-layout-0.12.3 cuddly-console:latest
  tar -xzf "$release/sources-before.tar.gz"
  "${compose[@]}" up -d --no-deps --no-build --wait --wait-timeout 60 console
  exit 1
}
trap rollback ERR
tar -xzf "$release/sources.tar.gz"
docker tag cuddly-console:requirements-layout-0.12.3 cuddly-console:latest
"${compose[@]}" up -d --no-deps --no-build --wait --wait-timeout 60 console
curl --fail --silent --show-error http://127.0.0.1:9888/pc-plugin/cake-layout.css > /dev/null
"${compose[@]}" ps
trap - ERR
echo 'Requirement list layout deployed. No backend services restarted.'
