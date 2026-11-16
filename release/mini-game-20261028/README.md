# mini_game Remote support — 2026-10-28

Deployed Bifrost control-api and runner-agent only. Console and Gateway consume the module configuration dynamically and were not rebuilt or restarted.

- Added `mini_game` / `apps/mini_game`, using its `build` script and standalone `rspack.config.ts`.
- Enabled `[热更] mini_game` globally and in `shared`, `qa`, and `tttt`.
- Added the module to `main`, `main-qa`, and `main-tttt` Remote allowlists. Other project and site settings were verified unchanged.
- No mini_game build was requested; the database contains zero mini_game build jobs after deployment.
- No current artifact selections or requirement configurations were changed.

## Verification

- 461 tests passed, 1 skipped; full workspace typecheck passed.
- Control API and Runner builds passed.
- Actual mini_game config at KOOK `origin/feat/mini-game-main` was checked for the exact scoped patch, idempotency, and syntax; no business build was executed.
- Both replaced containers are healthy; public HTTPS MCP authentication check passed.
- Worker dispatch was paused only during the idle Runner switch, then resumed.

## Deployed artifacts

| Service | Image ID | Bundle SHA-256 |
| --- | --- | --- |
| control-api | `sha256:0c4adb4d5df9fb4504bdb751780b8f15bb6c57a371b7390a8a8f637419e11e0a` | `69d6f891aac96cf4f521099ac234ea8adb2bd12867fb6344e6cf20592d909a36` |
| runner-agent | `sha256:3e96387184aa9a0213fb8e50b2599e841198c5d53bdeee160ac41e7c0a48a7f1` | `7917ce6ed1d0a2cb2f63630ab9f7fd0b1f8d9bd174b3943e490b35ef1f19a58f` |

## Recovery material

Remote directory: `/home/miku/cuddly-umbrella/release/mini-game-20261028`.

The deployment script preserves prior images under `before-mini-game-20261028` tags and existing source files in `sources-before.tar.gz`. `configuration-before.json` records the module and site configuration before enablement. Deployment failures automatically restore service images and source files; later administrative configuration changes must be restored separately if rolling back after enablement. No schema changes were introduced beyond inserting the new disabled built-in template on startup.
