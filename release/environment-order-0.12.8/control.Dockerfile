ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY packages/contracts/src/index.ts /app/packages/contracts/src/index.ts
COPY packages/db/src/schema.ts /app/packages/db/src/schema.ts
COPY packages/db/src/postgres-store.ts /app/packages/db/src/postgres-store.ts
COPY packages/db/src/memory-store.ts /app/packages/db/src/memory-store.ts
RUN pnpm --filter @cuddly/control-api build
