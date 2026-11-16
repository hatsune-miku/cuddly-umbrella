#!/usr/bin/env bash
set -euo pipefail
trap 'echo "verification_failed_at_line=$LINENO" >&2' ERR

cd /home/miku/cuddly-umbrella

gateway_state="$(docker inspect -f '{{.State.Health.Status}}' cuddly-gateway-1)"
gateway_image="$(docker inspect -f '{{.Image}}' cuddly-gateway-1)"
[[ "$gateway_state" == "healthy" ]]

body="$(mktemp)"
trap 'rm -f "$body"' EXIT

status="$(
  curl -sS -o "$body" -w '%{http_code}' \
    -H 'Accept: text/html' \
    'https://m.bifrost.vanillacake.cn/gift-gacha.htm?strategy=1'
)"

[[ "$status" == "200" ]]
grep -q '/__cuddly/resource-proxy.js' "$body"
if grep -q '/__cuddly/hooks/k-inject.js' "$body"; then
  echo 'k-inject is still present in live preview HTML' >&2
  exit 1
fi

curl -fsS https://m.bifrost.vanillacake.cn/__cuddly/hooks/k-inject.js >/dev/null

echo "gateway_health=$gateway_state"
echo "gateway_image=$gateway_image"
echo "online_h5_http_status=$status"
echo 'resource_proxy=present'
echo 'k_inject=absent'
echo 'legacy_hook_route=available'
