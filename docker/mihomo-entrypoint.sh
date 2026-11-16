#!/bin/sh
set -eu

config_dir=/root/.config/mihomo
config_path="$config_dir/config.yaml"
mkdir -p "$config_dir"

cat > "$config_path" <<EOF
mixed-port: 7890
allow-lan: true
bind-address: "*"
mode: direct
log-level: info
external-controller: 0.0.0.0:9090
secret: ""
ipv6: false
tun:
  enable: false
proxies: []
proxy-groups: []
rules:
  - MATCH,DIRECT
EOF
chmod 600 "$config_path"

exec /mihomo -d "$config_dir"
