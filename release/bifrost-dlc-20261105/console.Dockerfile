FROM cuddly-console:pre-bifrost-dlc-20261105
COPY apps/console/dist/pc-plugin/ /usr/share/nginx/html/pc-plugin/
COPY apps/console/dist/help/ /usr/share/nginx/html/help/
RUN chmod -R a+rX /usr/share/nginx/html/pc-plugin /usr/share/nginx/html/help
