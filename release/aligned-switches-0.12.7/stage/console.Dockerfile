ARG BASE_IMAGE=cuddly-console:unified-toolbar-0.12.6
FROM ${BASE_IMAGE}
COPY console/ /usr/share/nginx/html/
RUN chmod -R a+rX /usr/share/nginx/html
