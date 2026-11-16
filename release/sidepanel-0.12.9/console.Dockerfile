ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY console/ /usr/share/nginx/html/
RUN chmod -R a+rX /usr/share/nginx/html
