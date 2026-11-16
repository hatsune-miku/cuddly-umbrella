# KOOK build graph deployment

- Control API template commands pin KOOK projects to pnpm 9.15.9.
- Each KOOK Remote builds only the workspace packages that expose generated `dist` entry points.
- `shared` uses Remote `build:prod`; `tttt` uses Remote `build:ttt`.
- Online H5 uses its compatible default online build in `shared` and `build:dev` in `tttt`.
- Biz uses npm, publishes `build/`, and project commands inherit the Runner SSH identity for private Git dependencies.

Production rollback data is stored at:

```text
/home/miku/cuddly-backups/pre-kook-build-graph-20260825-212000
```

Deployed images:

```text
cuddly-control-api:kook-build-graph-20260825-212000
cuddly-runner-agent:kook-build-graph-20260825-212000
```

Production smoke builds:

```text
discover feature/100  f83a7561-4a7b-4c19-bc98-a11955657978  SUCCEEDED
biz      master       7564640a-d2b8-4ef9-a934-898941d26470  SUCCEEDED
```
