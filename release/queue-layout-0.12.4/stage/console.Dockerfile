ARG BASE_IMAGE=cuddly-console:requirements-layout-0.12.3
FROM ${BASE_IMAGE}
COPY console/ /usr/share/nginx/html/
RUN chmod -R a+rX /usr/share/nginx/html
