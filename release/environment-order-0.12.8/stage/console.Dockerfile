ARG BASE_IMAGE=cuddly-console:aligned-switches-0.12.7
FROM ${BASE_IMAGE}
COPY console/ /usr/share/nginx/html/
RUN chmod -R a+rX /usr/share/nginx/html
