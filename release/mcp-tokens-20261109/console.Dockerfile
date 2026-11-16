FROM cuddly-console:pre-mcp-tokens-20261109
COPY apps/console/dist /usr/share/nginx/html
RUN chmod -R a+rX /usr/share/nginx/html
