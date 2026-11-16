FROM cuddly-runner-agent:before-light-console-0.12.10
COPY main.js /app/apps/runner-agent/dist/main.js
RUN node --check /app/apps/runner-agent/dist/main.js
