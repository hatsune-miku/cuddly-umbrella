#!/usr/bin/env bash
set -euo pipefail

root="/home/miku/cuddly-umbrella"
backup="/home/miku/cuddly-backups/pre-artifact-single-slot-20260825-170803"

test -s "$backup/postgres.dump"
mkdir -p "$backup/artifacts-copy"
cp -R "$root/data/docker/artifacts/." "$backup/artifacts-copy/"
tar \
  --exclude='./data' \
  --exclude='./release' \
  --exclude='./node_modules' \
  --exclude='*/node_modules' \
  --exclude='*/dist' \
  -czf "$backup/source.tar.gz" \
  -C "$root" .

docker exec cuddly-postgres-1 psql -U cuddly -d cuddly -Atc \
  "SELECT status || '|' || count(*) FROM artifacts GROUP BY status ORDER BY status" \
  >"$backup/artifact-status-before.txt"
find "$root/data/docker/artifacts/ready" -mindepth 2 -maxdepth 2 -type d -printf '%P\n' \
  | sort >"$backup/artifact-directories-before.txt"

source_files="$(find "$root/data/docker/artifacts" -type f | wc -l)"
backup_files="$(find "$backup/artifacts-copy" -type f | wc -l)"
source_bytes="$(find "$root/data/docker/artifacts" -type f -printf '%s\n' | awk '{total += $1} END {print total + 0}')"
backup_bytes="$(find "$backup/artifacts-copy" -type f -printf '%s\n' | awk '{total += $1} END {print total + 0}')"
if [[ "$source_files" != "$backup_files" || "$source_bytes" != "$backup_bytes" ]]; then
  echo "Artifact backup mismatch: files ${source_files}/${backup_files}, bytes ${source_bytes}/${backup_bytes}" >&2
  exit 1
fi

printf 'files=%s\nbytes=%s\n' "$backup_files" "$backup_bytes" >"$backup/backup-complete.txt"
cat "$backup/backup-complete.txt"
