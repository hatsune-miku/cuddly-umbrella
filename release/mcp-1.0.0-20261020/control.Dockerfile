FROM cuddly-control-api:before-mcp-1.0.0-20261020
COPY main.js /app/apps/control-api/dist/main.js
RUN node --check /app/apps/control-api/dist/main.js
