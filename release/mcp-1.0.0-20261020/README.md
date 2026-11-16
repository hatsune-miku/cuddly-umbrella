# Bifrost MCP 1.0.0

Implemented and deployed API support on 2026-10-20.

## Delivered

- `apps/mcp-server`: official MCP SDK based stdio service; 24 read tools, 33 tools in default operate mode, 43 in admin mode.
- Two resources and two workflow prompts; bounded log output and waiting, pagination, build idempotency, revision conflict propagation, credential redaction, explicit destructive-operation confirmation.
- Browser-based Feishu identity delegation with consent, loopback callback, state, PKCE S256, single-use 60-second codes, independently revocable sessions, and local user-profile credential storage.
- Compatible artifact summaries and file pagination API additions.
- Setup guide and JSON/TOML client examples. No client configuration or real user login was performed automatically.
- Personal-project code conventions applied to new code. Existing CakeUI authorization styles reused; no console/extension redesign.

## Validation

- Workspace: 438 tests passed, 1 skipped.
- All workspace typechecks passed; final changed-package typechecks passed after the final edits.
- MCP and control API production builds passed.
- Actual compiled stdio processes negotiated successfully for read/operate/admin; tool counts, resources and missing-auth errors verified.
- MCP Client -> actual control API -> MemoryStore integration covers authenticated actor, CSRF, build deduplication/cancel/retry, requirement updates/conflicts, preview creation/revocation, and artifact pagination.
- Headless browser exercised consent -> loopback redirect -> PKCE exchange -> authenticated API -> logout with an isolated fixture identity. Desktop and 360px screenshots inspected in `output/mcp-review/`. No real Feishu account was used in automated tests.
- Live anonymous `/api/v1/auth/session` remains 401. Authorization page routes unauthenticated requests to existing Feishu login (302), CSS returns 200, invalid grant exchange returns 400.

## Deployment

Only control-api was replaced. No DB migration, new port, new domain, Runner restart, worker restart, gateway restart, console deployment, extension release, KFC publication, real build, requirement mutation or Git push.

Old control API image: `sha256:c767f6baf97ebfc28996c01ec968c27581cd918b5180b960e561a7d0cef17103`.

New control API image: `sha256:da08d88ea12d579d7718484ec452eb1c7c2ff855744b05ed5ee7d83b3d709a9a`.

Local/live bundle SHA256: `d813259b93a8447251b7c8e19b0d223d0aa0a668270a0a4664a22d4c56e64307`.

Previous image tag and source backup are retained in this release directory on the server. The deployment script checks the initial image and rolls back on startup/verification failure.

## Boundaries

The MCP is a local stdio process, not a public Streamable HTTP endpoint. Access modes filter tools locally; issued session credentials inherit the existing Feishu user's permissions and are not server-enforced scoped tokens. Auth codes are held in the single control API process and expire on restart; multi-replica deployment needs shared short-lived storage or sticky routing.

The MCP does not operate the browser extension/PC injector UI, does not implement arbitrary shell/HTTP/SSH or database writes, and does not revive disabled shared publishing. Full docs: `apps/mcp-server/README.md`.
