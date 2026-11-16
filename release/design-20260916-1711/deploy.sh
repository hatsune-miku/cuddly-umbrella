#!/usr/bin/env bash
set -euo pipefail
cd /home/miku/cuddly-umbrella
release=release/design-20260916-1711
test -f "$release/images.tar.gz"
test -f "$release/sources.tar.gz"
test "$(docker inspect cuddly-console-1 --format '{{.Image}}')" = 'sha256:95042a4d6e9c1614dc4b0a6d72a3649a042218d6df88abfd88646b8629d1345e'
docker tag 95042a4d6e9c1614dc4b0a6d72a3649a042218d6df88abfd88646b8629d1345e cuddly-console:before-design-20260916-1711
mkdir -p "$release/stage"
tar -xzf "$release/images.tar.gz" -C "$release/stage"
docker build --pull=false \
  --build-arg BASE_IMAGE=cuddly-console:before-design-20260916-1711 \
  -f "$release/stage/console.Dockerfile" -t cuddly-console:design-20260916-1711 "$release/stage"
docker run --rm cuddly-console:design-20260916-1711 nginx -t

tar -tzf "$release/sources.tar.gz" > "$release/source-paths.txt"
while IFS= read -r file; do
  case "$file" in /*|*../*) echo 'Unsafe archive path'; exit 1;; esac
  if test -e "$file"; then printf '%s\n' "$file"; fi
done < "$release/source-paths.txt" > "$release/existing-paths.txt"
tar --no-recursion -czf "$release/sources-before.tar.gz" -T "$release/existing-paths.txt"

compose=(docker compose -p cuddly -f docker-compose.yml -f docker-compose.production.yml)
rollback() {
  trap - ERR
  echo 'Deployment failed; restoring the previous console image.'
  docker tag cuddly-console:before-design-20260916-1711 cuddly-console:latest
  tar -xzf "$release/sources-before.tar.gz"
  "${compose[@]}" up -d --no-deps --no-build --wait --wait-timeout 60 console
  exit 1
}
trap rollback ERR
tar -xzf "$release/sources.tar.gz"
docker tag cuddly-console:design-20260916-1711 cuddly-console:latest
"${compose[@]}" up -d --no-deps --no-build --wait --wait-timeout 60 console
curl --fail --silent --show-error http://127.0.0.1:9888/ > /dev/null
curl --fail --silent --show-error http://127.0.0.1:9888/ui/cakeui-theme.css > /dev/null
"${compose[@]}" ps
trap - ERR
echo 'Design deployment complete; rollback image and source backup retained.'
