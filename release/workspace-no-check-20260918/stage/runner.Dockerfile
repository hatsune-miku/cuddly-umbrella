FROM cuddly-runner-agent:before-workspace-no-check-20260918
COPY main.js /app/apps/runner-agent/dist/main.js
RUN node --check /app/apps/runner-agent/dist/main.js
RUN node -e "const ts=require('typescript'); if(!ts.parseConfigFileTextToJson) process.exit(1); console.log(ts.version)"
