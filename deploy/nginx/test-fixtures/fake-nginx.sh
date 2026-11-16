#!/bin/sh
set -eu

case "${1:-}" in
  -T)
    printf '%s\n' 'user nginx;'
    ;;
  -t)
    if [ "${CUDDLY_TEST_NGINX_T_FAIL:-0}" = 1 ]; then
      echo 'fake nginx configuration test failed' >&2
      exit 1
    fi
    ;;
  -s)
    if [ "${2:-}" != reload ]; then
      echo "unexpected fake nginx signal: ${2:-}" >&2
      exit 2
    fi
    ;;
  *)
    echo "unexpected fake nginx arguments: $*" >&2
    exit 2
    ;;
esac
