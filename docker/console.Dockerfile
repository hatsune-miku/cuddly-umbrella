FROM node:24-bookworm-slim AS build

RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile

RUN pnpm --filter @cuddly/console build

FROM nginx:1.29-alpine
COPY docker/console.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/console/dist /usr/share/nginx/html
RUN chmod -R a+rX /usr/share/nginx/html
