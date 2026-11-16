FROM cuddly-console:pc-login-20261105-2105
COPY apps/console/dist/pc-plugin/ /usr/share/nginx/html/pc-plugin/
RUN chmod -R a+rX /usr/share/nginx/html/pc-plugin
