# Console density release

- Release: `console-density-20260825-173300`
- Scope: Console static assets only
- Source: `apps/console/src/styles.css`
- Rollback image: `cuddly-console:pre-console-density-20260825-173300`
- Rollback source backup: `/home/miku/cuddly-backups/pre-console-density-20260825-173300`

Verification:

- Desktop target grid: two columns at 961 px and wider
- Compact target row: approximately 128 px with 34 px actions
- Narrow layout: one column with 44 px actions and selects at 540 px
- Console typecheck, eight unit tests, and production build pass
