FROM cuddly-runner-agent:before-mini-game-20261028
COPY runner-main.js /app/apps/runner-agent/dist/main.js
RUN node --check /app/apps/runner-agent/dist/main.js
