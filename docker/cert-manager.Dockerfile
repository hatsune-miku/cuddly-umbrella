FROM node:24-bookworm-slim AS build

RUN corepack enable

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @cuddly/cert-manager build

FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends acl ca-certificates certbot \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/apps/cert-manager/dist ./dist

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "dist/main.js"]
