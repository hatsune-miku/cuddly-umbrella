FROM cuddly-control-api:before-plain-pnpm-20261028
COPY control-main.js /app/apps/control-api/dist/main.js
RUN node --check /app/apps/control-api/dist/main.js
