ARG BASE_IMAGE=cuddly-console:queue-layout-0.12.4
FROM ${BASE_IMAGE}
COPY console/ /usr/share/nginx/html/
RUN chmod -R a+rX /usr/share/nginx/html
