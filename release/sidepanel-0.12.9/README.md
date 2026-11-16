# Side Panel — 0.12.9

Browser toolbar actions now open Chrome Side Panel (Chrome 116+); the stable extension source directory is unchanged. Side Panel reuses popup.html through a CSP-safe redirect, adapts to the browser-owned viewport, tracks the active tab in its owning window, and preserves per-tab drafts. Generation guards prevent late context/queue/requirement results from overwriting another tab; old target dialogs close during navigation.

PC uses the same responsive page and generated product/version metadata. Its host entry is 0.2.0: a nonmodal right panel with keyboard/pointer resizing and persisted width. Local kook-plugin-tools/user-plugins/bifrost.js is updated; the hosted /pc-plugin/bifrost.js is available for other injector installations. Re-injection is needed to replace installed host files. KOOK itself was not restarted or reinjected automatically. Guest permissions and in-place-only behavior remain intact.

Checks: extension 153 tests; workspace 398 passed / 1 skipped; injector 20 tests; workspace typechecks; console build; real Chromium extension load, Side Panel behavior/open/bootstrap; browser fixtures at 320/400/560/720 widths for branches, picker, requirements, share, queue/history/job details, tab/window changes, draft isolation; real PC host + adapter handshake, width persistence, queue dialog and nonmodal interaction. The KFC client install/reload workflow itself was not exercised.

Deployment updates only the console image and relevant source assets; existing image and source backup plus guarded rollback retained in this directory. No backend/repository credentials or environment data are included in the payload.

Deployed and publicly verified by byte hashes on 2026-09-18. Console image: `sha256:8d4346944464c89ff9534445f0d86f6fd3d59174b681e2bbbca53336d7d1327a`. KFC web and extension 0.12.9 published; four extension platform records read back and matched ZIP SHA256 `31bbad360b19c209e63acd9138f148fffaa5a368404c1d7982f3b74130b75080`. PC host source/download SHA256: `71153dc770dcb9030b5584b156ee4860591223ecc88832c5d73a07ef410afbd0`. The separate injector application's KFC bundle was not republished.
