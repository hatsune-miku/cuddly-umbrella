ARG BASE_IMAGE
FROM ${BASE_IMAGE}
# Reuse the running release's dependencies; the only API change is OAuth page styling.
COPY control-app.ts /app/apps/control-api/src/app.ts
RUN pnpm --filter @cuddly/control-api build
