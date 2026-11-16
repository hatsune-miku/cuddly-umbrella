# Rollback

The pre-deployment source, database dump, Artifact inventory, and image tags are stored in:

`/home/miku/cuddly-backups/pre-multi-env-20260825-193318`

The migrated schema remains backward-compatible with the immediately previous images. For a fast image rollback:

```bash
cd /home/miku/cuddly-umbrella
docker compose -p cuddly -f docker-compose.yml -f docker-compose.production.yml stop build-worker
for service in control-api build-worker runner-agent gateway console; do
  docker image tag "cuddly-${service}:pre-multi-env-20260825-193318" "cuddly-${service}:latest"
done
docker compose -p cuddly -f docker-compose.yml -f docker-compose.production.yml up -d --no-deps --no-build control-api runner-agent gateway console
docker compose -p cuddly -f docker-compose.yml -f docker-compose.production.yml up -d --no-deps --no-build build-worker
```

If the database itself must be restored, stop all application services first and restore `postgres.dump` with `pg_restore`; this is intentionally not part of the fast rollback path.
