# Bifrost MCP 1.1.0 — remote HTTP

Deployed 2026-10-20.

Endpoint: `https://bifrost.vanillacake.cn/api/v1/mcp`

## Delivered

- Streamable HTTP integrated into control-api, with existing 43-tool implementation and stdio compatibility.
- Standard protected-resource and authorization-server discovery, dynamic client registration, PKCE S256, Feishu login and explicit browser consent.
- Server-enforced read/operate/admin scopes (24/33/43 tools); default consent is operate, never admin.
- Audience-bound MCP-only tokens, one-hour access tokens, rotating refresh tokens, seven-day maximum connections capped by the original identity session.
- Replay detection, revocation, safe Origin handling, bounded requests and registry sizes, two-trusted-proxy-hop OAuth rate limiting.
- Atomic private-file OAuth state persistence. State and internal API session secrets are excluded from this release.
- Remote client JSON/TOML instructions and example file; no client installation or local credentials were configured automatically.

## Verification

- Final full suite: 456 passed, 1 skipped, 45 test files passed.
- Workspace typechecks passed; final changed control-api typecheck passed after hardening.
- Official MCP SDK URL-only automatic discovery -> registration -> consent -> PKCE -> authenticated HTTP client passed in isolated integration tests.
- Real HTTP clients verified all three scope/tool-count combinations, API identity, CSRF-backed writes, build idempotency/cancel, unauthorized tools, token audience separation, code replay, refresh replay, revocation, expiry and persistence.
- Real headless Chromium verified desktop/mobile consent and cross-origin callback CSP; screenshots inspected under `output/mcp-review/http-authorize*.png`.
- Production-style bundled smoke ran successfully in an isolated read-only Linux container with no external network and an in-memory database.
- Existing compiled stdio smoke passed for all three modes.
- Live HTTPS: discovery metadata and PKCE advertised correctly, anonymous MCP and normal API calls remain 401, internal API stays 404, console remains available, forged forwarded prefixes cannot reset OAuth rate-limit accounting.
- No live Feishu account was used to authorize a test MCP client; no real builds or business records were created.

## Deployment

Only control-api and the console image's Nginx configuration changed. Console static assets, Runner, build-worker, gateway, cert-manager, Postgres and Mihomo were not replaced. No new port, domain, database migration, extension release, KFC publication, Git commit or push.

Final control-api image: `sha256:2991dccea0478b8313e87daed8f57aa9a845b198933930322044e468602ceb30`

Final console image: `sha256:2df9f8e85963e7be6da22fa37183add14db2d85541fa9968a153e74040f68e1f`

Final control-api bundle SHA256: `119de5b7121ca7ad5e9cb8c67e760a8a6266e51b7db319ab0aab119469999d7b`

Previous images and source snapshots retained on server. The first deployment installed transport/auth/proxy support; the second tightened proxy trust and revalidated the final bundle. Both scripts include health checks and automatic failure rollback.

Before-release control-api: `sha256:da08d88ea12d579d7718484ec452eb1c7c2ff855744b05ed5ee7d83b3d709a9a`

Before-release console: `sha256:595d08f2fc4ed286fc7acb93b2c279155fd380ab85830a77726b1d9148b922d0`

## Operational boundaries

Single control-api instance only: pending authorization requests/codes are in-memory, clients/connections persist in `/srv/cuddly/secrets/mcp/oauth-state.json`. Multi-replica deployment requires shared transactional storage. Ingress assumes exactly two trusted proxies: host TLS Nginx -> console Nginx. Changes to that topology must review proxy trust/rate limiting.

HTTP clients must support Streamable HTTP and OAuth; the legacy standalone SSE transport is not provided. OAuth scope consent is not organizational RBAC. Removing a client-side configuration alone does not guarantee server-side revocation; use the advertised revocation endpoint.

Full guide: `apps/mcp-server/README.md`.
