#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
template=${CUDDLY_NGINX_PREVIEW_TEMPLATE:-"$script_dir/preview-wildcard.conf.template"}
base_domain=${CUDDLY_PREVIEW_BASE_DOMAIN:-bifrost.vanillacake.cn}
sites_available=${CUDDLY_NGINX_SITES_AVAILABLE:-/etc/nginx/sites-available}
sites_enabled=${CUDDLY_NGINX_SITES_ENABLED:-/etc/nginx/sites-enabled}
site_name=${CUDDLY_NGINX_PREVIEW_SITE_NAME:-cuddly-preview-wildcard}
nginx_bin=${CUDDLY_NGINX_BIN:-/usr/sbin/nginx}
letsencrypt_dir=${CUDDLY_LETSENCRYPT_DIR:-/etc/letsencrypt}
worker_uid_file=$letsencrypt_dir/.cuddly-nginx-worker-uid

install_acl_tool() {
  if command -v setfacl >/dev/null 2>&1; then
    return
  fi
  if [ "$(id -u)" -ne 0 ]; then
    echo "setfacl is required; rerun this installer as root so it can install the acl package" >&2
    exit 2
  fi
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends acl
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y acl
  elif command -v yum >/dev/null 2>&1; then
    yum install -y acl
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache acl
  else
    echo "setfacl is required; install the operating system acl package first" >&2
    exit 2
  fi
  if ! command -v setfacl >/dev/null 2>&1; then
    echo "The acl package was installed, but setfacl is still unavailable" >&2
    exit 2
  fi
}

detect_nginx_worker_uid() {
  worker_uid=${CUDDLY_NGINX_WORKER_UID:-}
  if [ -z "$worker_uid" ]; then
    worker_user=$(
      "$nginx_bin" -T 2>&1 |
        awk '$1 == "user" { gsub(/;/, "", $2); print $2; exit }' || true
    )
    if [ -n "$worker_user" ]; then
      worker_uid=$(id -u "$worker_user" 2>/dev/null || true)
    fi
  fi
  if [ -z "$worker_uid" ]; then
    worker_uid=$(
      ps -eo uid=,comm=,args= 2>/dev/null |
        awk '$2 == "nginx" && index($0, "nginx: worker process") { print $1; exit }' || true
    )
  fi
  case "$worker_uid" in
    '' | *[!0-9]*)
      echo "Unable to detect the Nginx worker UID; set CUDDLY_NGINX_WORKER_UID explicitly" >&2
      exit 2
      ;;
  esac
  printf '%s\n' "$worker_uid"
}

grant_nginx_certificate_traversal() {
  worker_uid=$1
  live_dir=$letsencrypt_dir/live
  archive_dir=$letsencrypt_dir/archive

  if [ ! -d "$letsencrypt_dir" ]; then
    install -d -m 0700 "$letsencrypt_dir"
  fi
  if [ ! -d "$live_dir" ]; then
    install -d -m 0700 "$live_dir"
  fi
  if [ ! -d "$archive_dir" ]; then
    install -d -m 0700 "$archive_dir"
  fi

  setfacl -m "u:$worker_uid:--x" "$letsencrypt_dir" "$live_dir" "$archive_dir"
}

if [ "${#base_domain}" -gt 253 ] || ! printf '%s\n' "$base_domain" | LC_ALL=C grep -Eq \
  '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'; then
  echo "Invalid CUDDLY_PREVIEW_BASE_DOMAIN: $base_domain" >&2
  exit 2
fi

if [ ! -f "$template" ]; then
  echo "Nginx preview template not found: $template" >&2
  exit 2
fi

case "$letsencrypt_dir" in
  /*) ;;
  *)
    echo "CUDDLY_LETSENCRYPT_DIR must be an absolute path: $letsencrypt_dir" >&2
    exit 2
    ;;
esac

install_acl_tool
worker_uid=$(detect_nginx_worker_uid)
grant_nginx_certificate_traversal "$worker_uid"
printf '%s\n' "$worker_uid" >"$worker_uid_file"
chmod 0644 "$worker_uid_file"

install -d -m 0755 "$sites_available" "$sites_enabled"
temporary=$(mktemp "$sites_available/.${site_name}.XXXXXX")
backup_dir=$(mktemp -d "$sites_available/.${site_name}.backup.XXXXXX")
available_path=$sites_available/$site_name
enabled_path=$sites_enabled/$site_name
available_had_original=false
enabled_had_original=false
configuration_installed=false
configuration_committed=false

if [ -e "$available_path" ] || [ -L "$available_path" ]; then
  cp -a "$available_path" "$backup_dir/available"
  available_had_original=true
fi
if [ -e "$enabled_path" ] || [ -L "$enabled_path" ]; then
  cp -a "$enabled_path" "$backup_dir/enabled"
  enabled_had_original=true
fi

restore_preview_configuration() {
  rm -f "$available_path" "$enabled_path"
  if [ "$available_had_original" = true ]; then
    cp -a "$backup_dir/available" "$available_path"
  fi
  if [ "$enabled_had_original" = true ]; then
    cp -a "$backup_dir/enabled" "$enabled_path"
  fi
}

cleanup() {
  status=$?
  set +e
  if [ "$configuration_installed" = true ] && [ "$configuration_committed" != true ]; then
    restore_preview_configuration
    echo "Restored the previous Nginx preview configuration after installation failure" >&2
  fi
  rm -f "$temporary"
  rm -rf "$backup_dir"
  trap - EXIT
  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT TERM

escaped_letsencrypt_dir=$(printf '%s\n' "$letsencrypt_dir" | sed 's/[\\&|]/\\&/g')
sed \
  -e "s/__CUDDLY_PREVIEW_BASE_DOMAIN__/$base_domain/g" \
  -e "s|__CUDDLY_LETSENCRYPT_DIR__|$escaped_letsencrypt_dir|g" \
  "$template" >"$temporary"
chmod 0644 "$temporary"
mv -f "$temporary" "$available_path"
ln -sfn "$available_path" "$enabled_path"
configuration_installed=true

"$nginx_bin" -t
"$nginx_bin" -s reload
configuration_committed=true

echo "Installed wildcard preview edge for *.$base_domain"
echo "Nginx worker UID $worker_uid can traverse the Certbot roots under $letsencrypt_dir"
echo "The certificate manager grants read access separately for each managed hostname"

reload_watcher_installer=$script_dir/install-certificate-reload-watcher.sh
if [ -f "$reload_watcher_installer" ]; then
  CUDDLY_LETSENCRYPT_DIR=$letsencrypt_dir CUDDLY_NGINX_BIN=$nginx_bin \
    sh "$reload_watcher_installer"
fi
