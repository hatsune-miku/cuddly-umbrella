#!/bin/sh
set -eu

/usr/sbin/nginx -t >/dev/null 2>&1
/usr/sbin/nginx -s reload >/dev/null 2>&1
