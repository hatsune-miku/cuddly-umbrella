# multi-env-20260825-193318

- Adds first-class QA environments with an environment name, immutable slug, backend origin, and `ACTIVE` / `FROZEN` / `ARCHIVED` lifecycle.
- Keeps each project global while storing install, build, output, enabled, and required settings per project/environment pair.
- Scopes Build Jobs, Artifacts, Revisions, Preview Sessions, branch catalogs, and queue presentation by environment.
- Splits a site's frontend fallback origin from the environment backend origin and allows one official origin to expose multiple environment candidates.
- Keeps legacy `shared` data and site bindings through an in-place, repeatable PostgreSQL migration with old-image write compatibility.
- Uses root-relative Remote asset paths for preview-host isolation while retaining compatibility with existing absolute Remote Artifacts.
- Adds short-lived, bounded Gateway caches for site bindings and runtime settings to avoid a database lookup for every asset request.
- Excludes archived environments from automatic certificate maintenance and avoids Git access for frozen-environment branch listings.
- Console and browser extension are environment-aware. The extension release is `cuddly-kook-preview-0.5.0.zip`.

Validation before deployment:

- Full typecheck passed for all workspace packages.
- Full test suite passed: 265 tests, 1 skipped.
- Full production build passed.
- Real legacy database upgraded in place; 10 jobs and 6 Artifacts were retained.
- Migration was initialized three times; data counts and environment foreign-key OIDs stayed stable.
- Browser verification covered environment creation, switching, frozen-state behavior, environment-following settings, and site fallback labels.
- The exact pre-deployment production database dump was restored into disposable PostgreSQL 16, migrated twice, and retained 43 Jobs, 26 Artifacts, 3 Revisions, and 2 SiteBindings with stable environment-constraint OIDs.

Payload checksums:

- `source-overlay.tar`: `6A81A85BA5D10D49360553F63B4005CFF1F30028F09720ADC8BAB995070BE270`
- `image-overlay.tar`: `2CA055B238061F7D6C6D9CAE5C13EFB103E8F60E5219A050679BE89D13B237A4`
- `cuddly-kook-preview-0.5.0.zip`: `ED4572412B0185878F7FC53AAFB028DAAC7BEAB396E6854BBDF750F35C20E6CB`

Deployment services:

- `control-api`
- `build-worker`
- `runner-agent`
- `gateway`
- `console`
