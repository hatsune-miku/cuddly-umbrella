# Workspace-wide TypeScript noCheck

Deployed 2026-09-18, Runner only. No UI, API, gateway or project database commands changed.

After checkout and before installation/build, every workspace `tsconfig.json` and `tsconfig.*.json` receives `compilerOptions.noCheck = true`. This applies to all projects and workspace packages without package-name matching. JSONC is parsed using TypeScript; all other settings, including declaration emission, paths and references are preserved. Dependency/output directories and symlinks are not traversed. Original repository files are untouched: only disposable build checkouts are modified.

Requires a project compiler supporting noCheck (TypeScript 5.6+; the verified KOOK compiler is 5.9.3). Syntax, configuration, emit and bundler errors still fail normally; exit codes are never swallowed. This does not disable the Bifrost runner's own type checks or remove existing unrelated import-path compatibility patches.

Verification:

- Workspace tests: 414 passed, 1 skipped; Runner typecheck and production build passed.
- Real local KOOK declaration generation with the project's own TypeScript 5.9.3: 9 baseline diagnostics, 0 with noCheck, 24 declaration outputs captured in memory; no original files changed.
- Coverage includes arbitrary workspace names, JSONC/inheritance, idempotence, dependency/output exclusion, unchanged source files, semantic-error declaration emission, and retained syntax/configuration failures.
- Runner was idle before restart; dispatcher paused for the switch and resumed after readiness passed. No active build interrupted.

Old Runner image: `sha256:e1304ad5bea56bfadec3f8ba64d187ef257138c93accb12d3983f54fde0cdc95`.

New Runner image: `sha256:009a28dc6d67d81303a5456e520f7efcda45dafa9e7a6d22b95d2177c74bea48`.

Local/deployed bundle SHA256: `217214e8cb1e36c59cce51981b80944e2cbfbdd304596827ef93021f9e2aa10a`.

No complete business build was automatically submitted. Failed tasks can now be retried to use this policy.
