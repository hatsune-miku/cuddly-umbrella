#!/usr/bin/env bash
set -euo pipefail

release="environment-resource-proxy-20260826-1203"
root="/home/miku/cuddly-umbrella"
compose=(docker compose -p cuddly -f docker-compose.yml -f docker-compose.production.yml)

cd "$root"
for service in control-api gateway console; do
  docker image tag "cuddly-${service}:pre-${release}" "cuddly-${service}:latest"
done
"${compose[@]}" up -d --no-deps --no-build control-api gateway console
