ARG BASE_IMAGE
FROM ${BASE_IMAGE}
# Keep previous hashed assets available to tabs opened before this deployment.
COPY console/ /usr/share/nginx/html/
RUN chmod -R a+rX /usr/share/nginx/html
