# Version context controls — 0.12.5

Moved environment and endpoint controls beside the requirements/branches tabs in the console and extension. The extension endpoint remains automatically detected and read-only; URL environment locks remain effective. Context controls are visible in both modes, with the console environment selector retained in build history. Narrow console layouts wrap.

Verification: extension 152/152; repository 394 passed, 1 skipped; console build/typecheck; screenshot layout assertions (desktop, mobile, extension 1.2x, PC); help tests. KFC package validated with 25 root files.

Deployed only the console service; backend services were not restarted. Public assets match local SHA256 hashes. Anonymous API authentication remains 401. Console image: `sha256:0e6a6cd4bfabdee59ddf120fed2e5d04e0ffe37ebdf490466c873d824c3ee61b`.

KFC web and browser extension 0.12.5 published and read back. All four extension platform records match ZIP SHA256 `2a5a7f2c18b5498121b4bcb1d4908898c773a0f779485d536fbaaff0fc266f04`. Actual KFC client installation/reload was not performed.
