#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Certificate reload watcher installation must run as root" >&2
  exit 2
fi

letsencrypt_dir=${CUDDLY_LETSENCRYPT_DIR:-/etc/letsencrypt}
nginx_bin=${CUDDLY_NGINX_BIN:-/usr/sbin/nginx}
systemd_dir=${CUDDLY_SYSTEMD_DIR:-/etc/systemd/system}
marker=$letsencrypt_dir/.cuddly-nginx-reload
hook_dir=$letsencrypt_dir/renewal-hooks/deploy
hook=$hook_dir/reload-nginx.sh
service=$systemd_dir/cuddly-nginx-certificate-reload.service
path_unit=$systemd_dir/cuddly-nginx-certificate-reload.path

case "$letsencrypt_dir:$nginx_bin:$systemd_dir" in
  /*:/*:/*) ;;
  *) echo "Certificate watcher paths must be absolute" >&2; exit 2 ;;
esac
if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd is required to bridge the container certificate hook to host Nginx" >&2
  exit 2
fi

install -d -m 0755 "$hook_dir" "$systemd_dir"
touch "$marker"
chmod 0644 "$marker"

cat >"$hook" <<EOF
#!/bin/sh
set -eu
if [ -x "$nginx_bin" ]; then
  "$nginx_bin" -t >/dev/null 2>&1
  "$nginx_bin" -s reload >/dev/null 2>&1
else
  touch "$marker"
fi
EOF
chmod 0755 "$hook"

cat >"$service" <<EOF
[Unit]
Description=Reload host Nginx after Bifrost certificate renewal

[Service]
Type=oneshot
ExecStart=/bin/sh -c '$nginx_bin -t && $nginx_bin -s reload'
EOF

cat >"$path_unit" <<EOF
[Unit]
Description=Watch for Bifrost certificate renewal signals

[Path]
PathChanged=$marker
Unit=cuddly-nginx-certificate-reload.service

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now cuddly-nginx-certificate-reload.path

echo "Installed certificate renewal bridge: $hook -> $marker -> host Nginx"
