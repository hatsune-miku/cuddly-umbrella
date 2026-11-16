# KOOK incremental Remote configuration compatibility

Deployed 2026-09-18. Runner now accepts both the historical PUB_PATH/templateName (or remoteName) expression and `get_remote_asset_public_path()`. Only output.publicPath is overridden to `auto`; the incremental helper receives the artifact-specific origin-relative REMOTE_ASSET_PUBLIC_PATH for release manifests and persistent cache identity. This prevents metadata becoming `auto/` or pointing at the official shared asset namespace. The known SENTRY_UPLOAD_DISABLE switch is preserved and OR-combined with the runner's upload-disable flag. Unknown expressions still fail closed.

No business sources, database project commands, environment settings, UI, API or gateway were modified. No complete business build was submitted automatically.

Validation:

- Runner unit suite: 79 passed; runner typecheck and production bundle build passed.
- Workspace suite: 405 passed / 1 skipped before the final extra CRLF regression test (subsequently passed in the 79-test runner suite).
- Read-only evaluation of 14 real local KOOK Remote configs, actual incremental helper, release-manifest plugin and persistent cache calculation passed.
- Deployed bundle pure patch functions checked against cached commit `bdcb9d0ee9552f17e198f6a517f5009157689c63` from failed voice_runtime/voice_panel jobs; production `auto`, artifact metadata paths, Sentry compatibility and idempotency passed. No install, compile or uploads in this check.
- Runner readiness and zero active tasks verified before restart with dispatch paused. Dispatch resumed after healthy startup. No running builds interrupted.

Previous image: `sha256:c7d153c4b18f4a117bc215b5116f40c33cdb0495ad528e9fc5d89ecf5d091306`.
Deployed image: `sha256:7ca175e3daa0ff93f0dd329d6d61dd99c13a4508ffc7a200ab08349058be2c73`.
Deployed main.js SHA256: `8244ae952346dee320fcaf4b621f8ec6e1f2fcc7c256a90a28cdb43284b391a5` (matches local bundle).

Source backup and old image tag are retained on the server under this release directory. The deploy script guards the original image and fails without restart if builds are active.
