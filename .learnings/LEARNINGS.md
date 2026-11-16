# Learnings

## [LRN-20260726-001] correction

**Logged**: 2026-07-26T11:01:09+08:00
**Priority**: high
**Status**: resolved
**Area**: docs

### Summary

Cuddly must present QA with a complete package-to-branch artifact matrix; builds only create candidates and must never implicitly alter an environment.

### Details

The initial summary overemphasized commit SHA, build jobs, and applying build results to environments. The correct product model is branch-centric for QA:

- Every package row shows the branch of the artifact currently in use.
- A branch dropdown exposes available branch-labeled artifacts and their latest build time.
- `打最新包` builds the branch's current code into a new artifact candidate.
- A successful build has no deployment or environment side effect; QA must explicitly select/use the artifact.
- Commit SHA is not a QA-facing concept and is optional even as internal metadata.
- Environment state is always a complete current matrix, never an accumulated description of prior build/merge/override operations.

### Suggested Action

Keep build, artifact availability, and environment selection as separate domain states and separate UI actions. Show current selection and newly available artifacts side by side.

### Metadata

- Source: user_feedback
- Related Files: PROJECT_SUMMARY.md
- Tags: qa-ux, branch-matrix, artifact-selection, no-side-effects

### Resolution

- **Resolved**: 2026-07-26T11:01:09+08:00
- **Notes**: Updated the project summary to make the branch matrix and explicit artifact switching the primary product contract.

---

## [LRN-20260726-002] correction

**Logged**: 2026-07-26T11:10:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: frontend

### Summary

The Cuddly extension prototype should deliberately reuse the visual language of `kaccount-switch` so QA can transfer an existing mental model.

### Details

The user clarified that similarity to the account-switching extension is desirable. The prototype therefore adopts its compact 380px popup, white header card, dense action rows, pink accent, scrollable item list, small status badges, and fixed bottom status bar while preserving Cuddly-specific package and build workflows.

### Suggested Action

Prefer familiar internal-tool patterns over inventing a separate dashboard aesthetic when the target QA audience already understands an existing extension.

### Metadata

- Source: user_feedback
- Related Files: prototype/index.html
- Tags: qa-ux, browser-extension, visual-consistency

### Resolution

- **Resolved**: 2026-07-26T11:37:27+08:00
- **Notes**: Implemented and visually verified against the account-switch extension screenshot and source layout.

---

## [LRN-20260726-003] correction

**Logged**: 2026-07-26T11:50:21+08:00
**Priority**: medium
**Status**: resolved
**Area**: frontend

### Summary

Interactive prototypes should be delivered as a self-contained single HTML file whenever practical.

### Details

The first browser-extension prototype split its CSS and JavaScript into separate files and loaded its icon runtime from a CDN. The preferred handoff is one directly openable `index.html` with styles, behavior, and icon assets embedded so QA can move or share one file and use it offline.

### Suggested Action

For standalone prototype work, inline local CSS and JavaScript, bundle required icon runtimes, and verify that the final HTML has no external `src`, `href`, or CSS URL dependencies.

### Metadata

- Source: user_feedback
- Related Files: prototype/index.html
- Tags: prototype, html, offline, handoff
- See Also: LRN-20260726-002

### Resolution

- **Resolved**: 2026-07-26T11:50:21+08:00
- **Notes**: Consolidated the prototype into one offline-capable HTML file and removed the separate CSS and JavaScript files.

---
