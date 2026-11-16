FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git netcat-openbsd openssh-client \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile

ARG APP
RUN pnpm --filter "@cuddly/${APP}" build

ENV NODE_ENV=production
ENV CUDDLY_APP=${APP}

CMD ["sh", "-c", "node apps/${CUDDLY_APP}/dist/main.js"]
