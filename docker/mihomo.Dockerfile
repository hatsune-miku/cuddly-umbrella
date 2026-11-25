FROM metacubex/mihomo:v1.19.34

COPY docker/mihomo-entrypoint.sh /usr/local/bin/cuddly-mihomo-entrypoint
RUN chmod 755 /usr/local/bin/cuddly-mihomo-entrypoint

ENTRYPOINT ["/usr/local/bin/cuddly-mihomo-entrypoint"]
