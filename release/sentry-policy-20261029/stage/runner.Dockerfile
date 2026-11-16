FROM cuddly-runner-agent:before-sentry-policy-20261029
COPY runner-main.js /app/apps/runner-agent/dist/main.js
COPY sentry-build-policy.js /app/sentry-build-policy.mjs
COPY verify-sentry-policy.mjs /app/verify-sentry-policy.mjs
RUN node --check /app/apps/runner-agent/dist/main.js && node /app/verify-sentry-policy.mjs
