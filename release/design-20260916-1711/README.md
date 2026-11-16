# 0.12.1 frontend design release

Released 2026-09-16, Asia/Shanghai. Design direction and scope are documented in
`docs/FRONTEND_REDESIGN_0.12.1.md`.

## Scope

- Shared CakeUI theme, console, browser-extension and reused PC-plugin appearance.
- Login/completion and online tutorial appearance; refreshed tutorial screenshots.
- Existing two-column console and 560×600 single-column extension layouts retained.
- No application, authentication, build, proxy or hot-module behavior changes.

## Verification

- Repository tests: 394 passed, 1 skipped. Extension tests: 151 passed.
- Workspace typecheck and console production build passed.
- Browser fixtures checked branch selection, settings, queues, history, cancellation/retry
  visibility, unavailable-branch handling and existing layout dimensions.
- Online asset SHA-256 comparisons passed, including main bundles, PC-plugin styles,
  shared theme, authentication styles and refreshed tutorial images.
- Live login and OAuth completion rendering passed; anonymous session API remains 401.
- Online tutorial checks passed: search, anchors, modal/keyboard handling, downloads,
  mobile overflow and local-only requests. No real-user OAuth flow was performed.

## Deployment

Only `cuddly-console-1` was recreated. API, runner, build-worker, gateway, Mihomo,
certificate manager and PostgreSQL were not restarted. Console is healthy.

- New image: `cuddly-console:design-20260916-1711`
- New image ID: `sha256:432955ee8ada43db7ab60cefb48c8c6b3d2fc22a6ca83a8b8bb8cc40eb82be94`
- Rollback image: `cuddly-console:before-design-20260916-1711`
- Previous image ID: `sha256:95042a4d6e9c1614dc4b0a6d72a3649a042218d6df88abfd88646b8629d1345e`
- Remote release directory: `/home/miku/cuddly-umbrella/release/design-20260916-1711`
- Remote source backup: `sources-before.tar.gz` in the release directory.

Rollback from `/home/miku/cuddly-umbrella` if needed:

```sh
docker tag cuddly-console:before-design-20260916-1711 cuddly-console:latest
tar -xzf release/design-20260916-1711/sources-before.tar.gz
docker compose -p cuddly -f docker-compose.yml -f docker-compose.production.yml up -d --no-deps --no-build --wait console
```

## KFC

Both `cuddly` (website manifest) and `cuddly-browser-extension` published as 0.12.1.
POST returned 201 for both; subsequent authenticated GET confirmed latest version.
All four extension platform entries match the local archive hash:

`e3ab727c9655f9402078b5f3278f819c94ee9e98d4edbd5d204ccc6d5b28549c`

Archive: `dist-kfc/cuddly-browser-extension_0.12.1.zip`, 25 loadable root files.
No credentials were written to release files. No git commit, branch, worktree or push.
