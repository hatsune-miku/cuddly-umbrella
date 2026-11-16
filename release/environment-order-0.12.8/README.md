# Environment display priority — 0.12.8

Added optional integer sortOrder (-1000000..1000000) to environment settings/contracts. PostgreSQL migrates an additive NOT NULL sort_order column with default 0. Directories order by priority, name, slug, id; memory store follows the same priority/name policy. Legacy saves that omit the field preserve the stored value. Audits include the effective priority. No production environment priorities were changed (qa, tttt, shared remain 0).

Console settings expose a labeled CakeUI NumberBox and sidebar priority. Successful saves re-read server directory order. Existing extension environment selectors consume that same directory order unchanged; selected environment and URL locks are unaffected. Version 0.12.8 and tutorial updated.

Verification: 398 tests passed, 1 skipped; extension 152 passed; workspace typechecks passed; console build; screenshot checks for setting value and console/extension order; help checks. Public asset SHA256 checks passed and anonymous API session remains 401. Live database query confirmed sort_order is migrated. Actual KFC client installation/reload not exercised.

Deployed only API and console; runner, worker, gateway and database were not restarted. Backups and guarded rollback scripts retained. Rollback leaves the additive column in place for compatibility.

- Console image: sha256:ffcd60d6e9ec6e91fa71d15595ca3675a1b6c3be96e445ea643b1e3d05820ff5
- API image: sha256:c767f6baf97ebfc28996c01ec968c27581cd918b5180b960e561a7d0cef17103
- KFC web and extension 0.12.8 published and read back; all four extension platform records match ZIP SHA256 747d3594c8cdf16b654307d1f871463652ebbb1898a4331aab285d438079e151.
