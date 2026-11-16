FROM cuddly-console:pre-profile-20261106
COPY apps/console/dist /usr/share/nginx/html
RUN chmod -R a+rX /usr/share/nginx/html
