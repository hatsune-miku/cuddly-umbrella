#!/usr/bin/env bash
set -euo pipefail
umask 077

origin="http://127.0.0.1:9888"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl --fail-with-body -sS "$origin/api/v1/admin/build-targets" >"$tmp/all.json"
jq -e '.items | map(select(.id == "webapp")) | length == 1' "$tmp/all.json" >/dev/null

jq '
  .items[]
  | select(.id == "webapp")
  | {
      id,
      name,
      kind,
      repositoryUrl,
      defaultBranch,
      installCommand,
      buildCommand,
      outputDirectory,
      siteAdapter,
      enabled,
      required
    }
  | .installCommand = "npm run i"
  | .buildCommand = "npm run build_fast"
' "$tmp/all.json" >"$tmp/webapp-update.json"

before_auth="$(jq -r '.items[] | select(.id == "webapp") | .gitAuthorizationConfigured' "$tmp/all.json")"
curl --fail-with-body -sS \
  -X PUT \
  -H 'Content-Type: application/json' \
  -H 'X-Cuddly-Actor: gz' \
  --data-binary @"$tmp/webapp-update.json" \
  "$origin/api/v1/admin/build-targets/webapp" \
  >"$tmp/result.json"

jq -e '
  .id == "webapp"
  and .installCommand == "npm run i"
  and .buildCommand == "npm run build_fast"
' "$tmp/result.json" >/dev/null
after_auth="$(jq -r '.gitAuthorizationConfigured' "$tmp/result.json")"
test "$before_auth" = "$after_auth"

jq -c '{id, installCommand, buildCommand, gitAuthorizationConfigured, enabled}' "$tmp/result.json"
