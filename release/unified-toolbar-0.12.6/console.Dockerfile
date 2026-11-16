ARG BASE_IMAGE=cuddly-console:version-context-0.12.5
FROM ${BASE_IMAGE}
COPY console/ /usr/share/nginx/html/
RUN chmod -R a+rX /usr/share/nginx/html
