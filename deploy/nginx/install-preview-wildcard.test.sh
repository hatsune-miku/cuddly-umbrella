#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
installer=$script_dir/install-preview-wildcard.sh
template=$script_dir/preview-wildcard.conf.template
fixture=$script_dir/test-fixtures/fake-nginx.sh
worker_uid=42424
temporary_root=$(mktemp -d)
fake_nginx=$temporary_root/fake-nginx
tests_run=0

cleanup() {
  rm -rf "$temporary_root"
}
trap cleanup EXIT INT TERM

cp "$fixture" "$fake_nginx"
chmod 0755 "$fake_nginx"

fail() {
  echo "not ok - $*" >&2
  exit 1
}

pass() {
  tests_run=$((tests_run + 1))
  echo "ok $tests_run - $1"
}

assert_named_acl() {
  acl_path=$1
  expected_permissions=$2
  getfacl -cpn "$acl_path" | grep -Fqx "user:$worker_uid:$expected_permissions" ||
    fail "$acl_path does not grant $expected_permissions to UID $worker_uid"
}

assert_no_named_acl() {
  acl_path=$1
  if getfacl -cpn "$acl_path" | grep -Fq "user:$worker_uid:"; then
    fail "$acl_path unexpectedly grants access to UID $worker_uid"
  fi
  if getfacl -cpn "$acl_path" | grep -Fq "default:user:$worker_uid:"; then
    fail "$acl_path unexpectedly grants inherited access to UID $worker_uid"
  fi
}

assert_no_default_acl() {
  acl_path=$1
  if getfacl -cpn "$acl_path" | grep -Fq "default:user:$worker_uid:"; then
    fail "$acl_path unexpectedly grants inherited access to UID $worker_uid"
  fi
}

run_installer() {
  case_root=$1
  CUDDLY_NGINX_PREVIEW_TEMPLATE="$template" \
    CUDDLY_NGINX_SITES_AVAILABLE="$case_root/sites-available" \
    CUDDLY_NGINX_SITES_ENABLED="$case_root/sites-enabled" \
    CUDDLY_NGINX_BIN="$fake_nginx" \
    CUDDLY_LETSENCRYPT_DIR="$case_root/letsencrypt" \
    CUDDLY_NGINX_WORKER_UID="$worker_uid" \
    sh "$installer"
}

empty_case=$temporary_root/empty
run_installer "$empty_case" >/dev/null
assert_named_acl "$empty_case/letsencrypt" --x
assert_named_acl "$empty_case/letsencrypt/live" --x
assert_named_acl "$empty_case/letsencrypt/archive" --x
assert_no_default_acl "$empty_case/letsencrypt"
assert_no_default_acl "$empty_case/letsencrypt/live"
assert_no_default_acl "$empty_case/letsencrypt/archive"
[ "$(cat "$empty_case/letsencrypt/.cuddly-nginx-worker-uid")" = "$worker_uid" ] ||
  fail 'the detected Nginx worker UID was not persisted'
[ -L "$empty_case/sites-enabled/cuddly-preview-wildcard" ] ||
  fail 'the generated preview configuration was not enabled'
pass 'installation succeeds before any certificate lineage exists'

unrelated_case=$temporary_root/unrelated
mkdir -p \
  "$unrelated_case/letsencrypt/live/unrelated.example.com" \
  "$unrelated_case/letsencrypt/archive/unrelated.example.com"
printf '%s\n' unrelated >"$unrelated_case/letsencrypt/archive/unrelated.example.com/privkey1.pem"
ln -s ../../archive/unrelated.example.com/privkey1.pem \
  "$unrelated_case/letsencrypt/live/unrelated.example.com/privkey.pem"
run_installer "$unrelated_case" >/dev/null
assert_named_acl "$unrelated_case/letsencrypt" --x
assert_named_acl "$unrelated_case/letsencrypt/live" --x
assert_named_acl "$unrelated_case/letsencrypt/archive" --x
assert_no_named_acl "$unrelated_case/letsencrypt/live/unrelated.example.com"
assert_no_named_acl "$unrelated_case/letsencrypt/archive/unrelated.example.com"
assert_no_named_acl "$unrelated_case/letsencrypt/archive/unrelated.example.com/privkey1.pem"
pass 'installation does not expose unrelated certificate lineages'

rollback_case=$temporary_root/rollback
mkdir -p \
  "$rollback_case/sites-available" \
  "$rollback_case/sites-enabled" \
  "$rollback_case/letsencrypt/live" \
  "$rollback_case/letsencrypt/archive"
printf '%s\n' 'old wildcard configuration' >"$rollback_case/sites-available/cuddly-preview-wildcard"
printf '%s\n' 'legacy configuration' >"$rollback_case/sites-available/legacy-preview"
old_enabled_target=$rollback_case/sites-available/legacy-preview
ln -s "$old_enabled_target" "$rollback_case/sites-enabled/cuddly-preview-wildcard"
if CUDDLY_TEST_NGINX_T_FAIL=1 run_installer "$rollback_case" >/dev/null 2>&1; then
  fail 'the installer unexpectedly succeeded after nginx -t failed'
fi
[ "$(cat "$rollback_case/sites-available/cuddly-preview-wildcard")" = 'old wildcard configuration' ] ||
  fail 'the previous sites-available configuration was not restored'
[ -L "$rollback_case/sites-enabled/cuddly-preview-wildcard" ] ||
  fail 'the previous sites-enabled symlink was not restored'
[ "$(readlink "$rollback_case/sites-enabled/cuddly-preview-wildcard")" = "$old_enabled_target" ] ||
  fail 'the restored sites-enabled symlink points to the wrong target'
pass 'nginx validation failure restores the previous configuration'

echo "1..$tests_run"
