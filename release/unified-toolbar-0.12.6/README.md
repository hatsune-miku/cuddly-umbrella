# Unified navigation toolbar — 0.12.6

Console and extension now combine primary navigation, contextual secondary navigation, and environment/endpoint controls. Only project mode shows requirements/branches. Console history exposes filters next to navigation; extension queue mode exposes current queue/history tabs. Narrow layouts wrap. PC UI is generated from extension source.

UI maintenance documentation records the standing requirement to change and verify console and extension together while retaining classic CakeUI.

Verification: extension 152 passed; repository 394 passed, 1 skipped; console typecheck/build; screenshot assertions for desktop, mobile, 1.2x extension and PC; queue frame stability and help checks. Package contains 25 loadable root files. Actual KFC client installation/reload was not performed.

Only console was restarted. Public assets exactly match local hashes; anonymous API session remains 401. Image: `sha256:a39ae095e92cab7a8de928550387a4bd3442ca0790752d4782571c2dac7de691`.

KFC web and extension 0.12.6 published and read back. All four platform records match local ZIP SHA256 `0516f310b94f1d4e9ff0aba36b426516ecf9f23c1a7fe30aed58f9914ddddab4`.
