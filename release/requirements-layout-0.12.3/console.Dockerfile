ARG BASE_IMAGE=cuddly-console:classic-20260916-1719
FROM ${BASE_IMAGE}
COPY console/ /usr/share/nginx/html/
RUN chmod -R a+rX /usr/share/nginx/html
