# Aligned segmented navigation — 0.12.7

Both console and extension use matching primary/secondary segmented controls: 36px groups with 32px buttons, shared surface/radius/padding. Environment and endpoint selectors have matching 36px outer height. Actual button edges are asserted, not just wrapper centers. Extension remains 1.2x; generated PC UI is synchronized. No business logic changed.

Verified: extension 152 tests; console typecheck/build; screenshot checks for aligned controls, desktop/mobile/extension/PC layouts and queue stability; help checks; KFC manifests and 25-file loadable package. Actual KFC client install/reload was not exercised.

Only console restarted. Production assets match local hashes, anonymous auth session still returns 401. Image: `sha256:a1f3f6555b9a8de021d6f818da740b8cc522958ba253330c4c362509a27f6646`.

KFC web and extension 0.12.7 published and read back. Four platform records match local ZIP SHA256 `f5822f134ae1adee20581b3e92d1fdf04f51d6fc0b2abe1a42538eb9d3129c68`.
