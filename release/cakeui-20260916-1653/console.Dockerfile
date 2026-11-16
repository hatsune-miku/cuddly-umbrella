ARG BASE_IMAGE
FROM ${BASE_IMAGE}
# Preserve old hashed assets so tabs opened before deployment can finish loading.
COPY console/ /usr/share/nginx/html/
RUN chmod -R a+rX /usr/share/nginx/html
