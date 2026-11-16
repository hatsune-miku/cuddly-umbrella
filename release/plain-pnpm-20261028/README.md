# Plain pnpm commands — 2026-10-28

Deployed control-api and runner-agent after 457 passing tests (1 skipped), full workspace typecheck, and service builds.

## Changes

- Global templates and database command defaults now invoke `pnpm`, with no explicit version.
- Runner no longer picks a pnpm version, reads packageManager for a custom override, or creates job-local pnpm/PATH shims. Native pnpm/Corepack behavior is preserved.
- Converted 15 global project definitions and 15 project configurations in each of `shared`, `qa`, and `tttt` to plain pnpm. All other fields were verified unchanged. npm-based projects were untouched.
- Frozen-lockfile validation and existing outdated-lockfile fallback behavior are unchanged.
- Sentry compatibility was not changed. No build jobs were created or retried.

## Verification

The image warms the environment's default pnpm without selecting a version. It resolved to 12.15.0 during this release. `verify-pnpm.cjs` confirms that plain pnpm reads workspace `overrides`, with no dependency install or business build.

Both services passed readiness checks, public HTTPS MCP authentication remained healthy, and the idle Runner switch completed with build-worker dispatch resumed.

| Service | Image ID | Bundle SHA-256 |
| --- | --- | --- |
| control-api | `sha256:70a7846af1fc3db3f5078336ebe079a2e3f0320f556c121783b6e6d5310bbd15` | `b719915fcdcf5d1a7ccd792e8b2f607819806b9a63f1adba4774a516d8333608` |
| runner-agent | `sha256:d93f195706282e2ff35821a3e53254108b55d33d5af8cffbfc82fc33df3004ba` | `948f9deaea07d028886b80ceeac2dfe64dca088bb888b8cfb9cc3ca423ee613a` |

## Recovery

The remote release directory contains `sources-before.tar.gz` and `configuration-before.json`. Previous service images are tagged `before-plain-pnpm-20261028`. Deployment errors restore source and image snapshots automatically. A later rollback must also restore project and environment command configuration from the saved JSON through the administrative API; historical build-job snapshots are intentionally unchanged.
