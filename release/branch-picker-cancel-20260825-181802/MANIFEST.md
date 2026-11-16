# branch-picker-cancel-20260825-181802

- Console and browser extension: searchable branch picker, newest-build ordering, live queue stages.
- Control/Worker/Runner: safe queued and running build cancellation through `CANCELING`.
- Management project/environment settings are open; internal service APIs remain Bearer protected.
- Branch catalog uses bounded projections instead of loading full job snapshots and Artifact manifests.
- The built-in `webapp` template follows its repository's npm workflow.

Expected service images before deployment:

- `cuddly-control-api:pre-branch-picker-cancel-20260825-181802`
- `cuddly-build-worker:pre-branch-picker-cancel-20260825-181802`
- `cuddly-runner-agent:pre-branch-picker-cancel-20260825-181802`
- `cuddly-console:pre-branch-picker-cancel-20260825-181802`
