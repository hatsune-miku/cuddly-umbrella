#!/usr/bin/env bash
set -euo pipefail
cd /home/miku/cuddly-umbrella
release=release/environment-order-0.12.8
test "$(docker inspect cuddly-console-1 --format '{{.Image}}')" = 'sha256:a1f3f6555b9a8de021d6f818da740b8cc522958ba253330c4c362509a27f6646'
docker tag a1f3f6555b9a8de021d6f818da740b8cc522958ba253330c4c362509a27f6646 cuddly-console:before-environment-order-0.12.8
test "$(docker inspect cuddly-control-api-1 --format '{{.Image}}')" = 'sha256:44fbb3f9d05956faf9d19d8ed7d4d4b3fdbac45af09aa879914b8571fadf019b'
docker tag 44fbb3f9d05956faf9d19d8ed7d4d4b3fdbac45af09aa879914b8571fadf019b cuddly-control-api:before-environment-order-0.12.8
mkdir -p "$release/stage"
tar -xzf "$release/images.tar.gz" -C "$release/stage"
docker build --pull=false --build-arg BASE_IMAGE=cuddly-console:before-environment-order-0.12.8 \
  -f "$release/stage/console.Dockerfile" -t cuddly-console:environment-order-0.12.8 "$release/stage"
docker build --pull=false --network host --build-arg BASE_IMAGE=cuddly-control-api:before-environment-order-0.12.8 \
  --build-arg HTTP_PROXY=http://127.0.0.1:7897 --build-arg HTTPS_PROXY=http://127.0.0.1:7897 \
  -f "$release/stage/control.Dockerfile" -t cuddly-control-api:environment-order-0.12.8 "$release/stage"
docker run --rm cuddly-console:environment-order-0.12.8 nginx -t
tar -tzf "$release/sources.tar.gz" > "$release/source-paths.txt"
while IFS= read -r file; do
  case "$file" in /*|*../*) echo 'Unsafe archive path'; exit 1;; esac
  if test -e "$file"; then printf '%s\n' "$file"; fi
done < "$release/source-paths.txt" > "$release/existing-paths.txt"
tar --no-recursion -czf "$release/sources-before.tar.gz" -T "$release/existing-paths.txt"
compose=(docker compose -p cuddly -f docker-compose.yml -f docker-compose.production.yml)
rollback() {
  trap - ERR
  docker tag cuddly-console:before-environment-order-0.12.8 cuddly-console:latest
  docker tag cuddly-control-api:before-environment-order-0.12.8 cuddly-control-api:latest
  tar -xzf "$release/sources-before.tar.gz"
  "${compose[@]}" up -d --no-deps --no-build --wait --wait-timeout 60 control-api console
  exit 1
}
trap rollback ERR
tar -xzf "$release/sources.tar.gz"
docker tag cuddly-console:environment-order-0.12.8 cuddly-console:latest
docker tag cuddly-control-api:environment-order-0.12.8 cuddly-control-api:latest
"${compose[@]}" up -d --no-deps --no-build --wait --wait-timeout 60 control-api console
curl --fail --silent --show-error http://127.0.0.1:9888/pc-plugin/cake-layout.css > /dev/null
"${compose[@]}" ps
trap - ERR
echo 'Environment order deployed. Only API and console restarted; additive database column retained on rollback.'
