ARG BASE_IMAGE=cuddly-console:latest
FROM ${BASE_IMAGE}

# Overlay only the public guide; preserve the currently deployed console bundle.
COPY apps/console/public/help /usr/share/nginx/html/help
COPY docker/console.nginx.conf /etc/nginx/conf.d/default.conf
RUN chmod -R a+rX /usr/share/nginx/html/help
