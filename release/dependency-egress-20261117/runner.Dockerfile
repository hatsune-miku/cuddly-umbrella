ARG RUNNER_IMAGE=cuddly-runner-agent:pre-dependency-egress-20261117
FROM ${RUNNER_IMAGE}
COPY apps/runner-agent/dist/main.js /app/apps/runner-agent/dist/main.js
RUN node --check /app/apps/runner-agent/dist/main.js
