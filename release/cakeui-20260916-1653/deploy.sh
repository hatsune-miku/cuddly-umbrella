#!/usr/bin/env bash
set -euo pipefail
cd /home/miku/cuddly-umbrella
release=release/cakeui-20260916-1653
test -f "$release/images.tar.gz"
test -f "$release/sources.tar.gz"
test "$(docker inspect cuddly-console-1 --format '{{.Image}}')" = 'sha256:f3a950ad7f90c8209e56ffd27c702e1743934463fae9f0d3427e80c459851974'
test "$(docker inspect cuddly-control-api-1 --format '{{.Image}}')" = 'sha256:4ce9ddadf638df3507540e8c6f9c7fb587aa29005f6459963743135a034ed8a1'
docker tag f3a950ad7f90c8209e56ffd27c702e1743934463fae9f0d3427e80c459851974 cuddly-console:before-cakeui-20260916-1653
docker tag 4ce9ddadf638df3507540e8c6f9c7fb587aa29005f6459963743135a034ed8a1 cuddly-control-api:before-cakeui-20260916-1653
mkdir -p "$release/stage"
tar -xzf "$release/images.tar.gz" -C "$release/stage"
docker build --pull=false --network host \
  --build-arg BASE_IMAGE=cuddly-control-api:before-cakeui-20260916-1653 \
  --build-arg HTTP_PROXY=http://127.0.0.1:7897 --build-arg HTTPS_PROXY=http://127.0.0.1:7897 \
  -f "$release/stage/control.Dockerfile" -t cuddly-control-api:cakeui-20260916-1653 "$release/stage"
docker build --pull=false \
  --build-arg BASE_IMAGE=cuddly-console:before-cakeui-20260916-1653 \
  -f "$release/stage/console.Dockerfile" -t cuddly-console:cakeui-20260916-1653 "$release/stage"
docker run --rm cuddly-console:cakeui-20260916-1653 nginx -t

# Snapshot every existing payload path. No secrets or data directories are in this payload.
tar -tzf "$release/sources.tar.gz" > "$release/source-paths.txt"
while IFS= read -r file; do
  case "$file" in /*|*../*) echo 'Unsafe archive path'; exit 1;; esac
  if test -e "$file"; then printf '%s\n' "$file"; fi
done < "$release/source-paths.txt" > "$release/existing-paths.txt"
tar --no-recursion -czf "$release/sources-before.tar.gz" -T "$release/existing-paths.txt"

compose=(docker compose -p cuddly -f docker-compose.yml -f docker-compose.production.yml)
rollback() {
  trap - ERR
  echo 'Deployment failed; restoring the two previous images.'
  docker tag cuddly-console:before-cakeui-20260916-1653 cuddly-console:latest
  docker tag cuddly-control-api:before-cakeui-20260916-1653 cuddly-control-api:latest
  tar -xzf "$release/sources-before.tar.gz"
  "${compose[@]}" up -d --no-deps --no-build --wait --wait-timeout 60 control-api console
  exit 1
}
trap rollback ERR
tar -xzf "$release/sources.tar.gz"
docker tag cuddly-console:cakeui-20260916-1653 cuddly-console:latest
docker tag cuddly-control-api:cakeui-20260916-1653 cuddly-control-api:latest
"${compose[@]}" up -d --no-deps --no-build --wait --wait-timeout 60 control-api console
curl --fail --silent --show-error http://127.0.0.1:9888/ > /dev/null
curl --fail --silent --show-error http://127.0.0.1:9888/ui/cakeui.css > /dev/null
"${compose[@]}" ps
trap - ERR
echo 'CakeUI deployment completed; previous images and source backup retained.'
