FROM cuddly-runner-agent:before-plain-pnpm-20261028
COPY runner-main.js /app/apps/runner-agent/dist/main.js
RUN node --check /app/apps/runner-agent/dist/main.js
# Warm the environment's default pnpm outside Bifrost's own packageManager scope.
# No version is selected by the Runner or the business-project command templates.
COPY verify-pnpm.cjs /tmp/verify-pnpm.cjs
RUN node /tmp/verify-pnpm.cjs
