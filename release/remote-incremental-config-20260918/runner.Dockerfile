ARG BASE_IMAGE=cuddly-runner-agent:before-remote-incremental-20260918
FROM ${BASE_IMAGE}
COPY main.js /app/apps/runner-agent/dist/main.js
RUN node --check /app/apps/runner-agent/dist/main.js
