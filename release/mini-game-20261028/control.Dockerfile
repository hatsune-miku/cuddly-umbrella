FROM cuddly-control-api:before-mini-game-20261028
COPY control-main.js /app/apps/control-api/dist/main.js
RUN node --check /app/apps/control-api/dist/main.js
