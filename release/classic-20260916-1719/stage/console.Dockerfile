ARG BASE_IMAGE=cuddly-console:design-20260916-1711
FROM ${BASE_IMAGE}
COPY console/ /usr/share/nginx/html/
RUN chmod -R a+rX /usr/share/nginx/html
