ARG MIHOMO_IMAGE=metacubex/mihomo:v1.19.34
FROM ${MIHOMO_IMAGE}
COPY docker/runner-egress.yaml /etc/bifrost-egress.yaml
ENTRYPOINT ["/mihomo", "-d", "/var/lib/mihomo", "-f", "/etc/bifrost-egress.yaml"]
