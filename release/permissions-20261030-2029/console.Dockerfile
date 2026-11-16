FROM cuddly-console:pre-permissions-20261030-2029
COPY apps/console/dist/ /usr/share/nginx/html/
RUN chmod -R a+rX /usr/share/nginx/html
