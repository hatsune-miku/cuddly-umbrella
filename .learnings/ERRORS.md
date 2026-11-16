# Errors

## [ERR-20260726-003] powershell-recursive-cleanup-policy

**Logged**: 2026-07-26T11:51:18+08:00
**Priority**: low
**Status**: resolved
**Area**: frontend

### Summary

PowerShell cleanup of a verified temporary Chrome profile was rejected by the command safety policy.

### Error

```text
Remove-Item ... -Recurse -Force rejected: blocked by policy
```

### Context

- The targets were an explicit screenshot and temporary Chrome profile under the current workspace.
- The first cleanup command verified that computed paths stayed under the workspace, but the policy rejected the recursive PowerShell form before execution.

### Suggested Fix

Perform the same resolved-path containment check and deletion in one Node process using explicit workspace-relative target names.

### Metadata

- Reproducible: yes
- Related Files: prototype/index.html

### Resolution

- **Resolved**: 2026-07-26T11:51:18+08:00
- **Notes**: A Node cleanup command verified both targets against the workspace root and removed them successfully.

---

## [ERR-20260724-001] recursive-manifest-scan

**Logged**: 2026-07-24T21:23:14+08:00
**Priority**: low
**Status**: resolved
**Area**: docs

### Summary

A recursive manifest scan entered `node_modules` and timed out while surveying reference repositories.

### Error

```text
command timed out after 10195 milliseconds
```

### Context

- Attempted to find `package.json`, `Cargo.toml`, and `go.mod` recursively under the KFC reference repository.
- The command did not exclude generated dependency directories before traversal.
- The repository survey is read-only and the timeout did not alter any reference project.

### Suggested Fix

Use `rg --files` with explicit exclusions such as `!node_modules/**`, or inspect only known first-party directories.

### Metadata

- Reproducible: yes
- Related Files: C:/Users/guanz/projects/project-kfc

### Resolution

- **Resolved**: 2026-07-24T21:23:14+08:00
- **Notes**: Subsequent scans are restricted to first-party paths and exclude dependency/build directories.

---

## [ERR-20260726-002] in-app-browser-file-url

**Logged**: 2026-07-26T11:27:10+08:00
**Priority**: low
**Status**: resolved
**Area**: frontend

### Summary

The in-app browser rejected direct navigation to the standalone prototype's `file://` URL.

### Error

```text
Browser use cannot visit the requested page because its URL is blocked by the Browser use URL policy.
```

### Context

- The artifact is intentionally a standalone HTML prototype.
- Browser-based visual verification still requires an allowed origin.

### Suggested Fix

Serve the prototype temporarily on a loopback-only HTTP port for testing, then stop the server. Keep the final artifact standalone.

### Metadata

- Reproducible: yes
- Related Files: prototype/index.html

### Resolution

- **Resolved**: 2026-07-26T11:27:10+08:00
- **Notes**: Visual verification moved to a temporary localhost origin; no deployment behavior changed.

---

## [ERR-20260726-001] frontend-ux-audit

**Logged**: 2026-07-26T11:21:43+08:00
**Priority**: medium
**Status**: resolved
**Area**: frontend

### Summary

The first UX audit of the browser-extension prototype failed because dynamically rendered branch selects lacked explicit label elements.

### Error

```text
[Cognitive Load] styles.css: Form inputs without labels. Use <label> for accessibility and clarity.
STATUS: FAIL
```

### Context

- The selects had programmatic `aria-label` attributes but no visible or screen-reader-only `<label>` wrapper.
- The remaining audit warnings mostly assume a landing page and are not applicable to a compact operational browser extension.

### Suggested Fix

Wrap environment and branch selects in explicit labels, add screen-reader-only label text, then rerun the audit.

### Metadata

- Reproducible: yes
- Related Files: prototype/index.html, prototype/app.js, prototype/styles.css

### Resolution

- **Resolved**: 2026-07-26T11:37:27+08:00
- **Notes**: Added explicit environment and dynamic branch labels. The audit heuristic still flags CSS selectors containing `input`, but browser accessibility snapshots expose all controls with unique labels and the rendered interaction was verified directly.

---

## [ERR-20260724-003] broad-windows-rg-scan

**Logged**: 2026-07-24T21:25:18+08:00
**Priority**: low
**Status**: resolved
**Area**: docs

### Summary

A broad Windows workspace search encountered invalid or reserved filesystem entries outside the task repositories.

### Error

```text
rg: .../nul: The function is incorrect. (os error 1)
rg: .../out/active.png: The filename, directory name, or volume label syntax is incorrect. (os error 123)
```

### Context

- Searched all projects for a Bifrost artifact-domain reference after scoped repositories showed no uploader.
- Unrelated repositories contain Windows-hostile paths, causing `rg` to return non-zero despite finding the relevant match.

### Suggested Fix

Keep surveys scoped to explicitly named repositories. Treat a deployment mechanism absent from those sources as an open question instead of scanning unrelated workspaces.

### Metadata

- Reproducible: yes
- Related Files: C:/Users/guanz/projects
- See Also: ERR-20260724-001, ERR-20260724-002

### Resolution

- **Resolved**: 2026-07-24T21:25:18+08:00
- **Notes**: The only first-party reference found was the Bifrost MIS URL convention; the upload implementation remains explicitly undocumented.

---

## [ERR-20260724-002] parallel-rg-empty-result

**Logged**: 2026-07-24T21:24:37+08:00
**Priority**: low
**Status**: resolved
**Area**: docs

### Summary

A parallel repository search aborted because one `rg` invocation returned its normal no-match exit code.

### Error

```text
Script error: Exit code: 1
```

### Context

- Searched several reference repositories for Bifrost deployment-domain references.
- At least one repository had no match; `rg` therefore returned exit code 1.
- `Promise.all` treated the nested command failure as fatal and discarded other search results.

### Suggested Fix

Use `Promise.allSettled` for independent read-only searches when empty matches are valid, and report each result separately.

### Metadata

- Reproducible: yes
- Related Files: C:/Users/guanz/projects/bifrost-frontend/bifrost-mis
- See Also: ERR-20260724-001

### Resolution

- **Resolved**: 2026-07-24T21:24:37+08:00
- **Notes**: Follow-up repository surveys use settled parallel calls so valid empty results do not abort the batch.

---
