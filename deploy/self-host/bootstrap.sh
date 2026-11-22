#!/bin/sh
set -eu

ANLYON_RELEASE_VERSION=""

ANLYON_REPO=${ANLYON_REPO:-}
ANLYON_REF=${ANLYON_REF:-}
ANLYON_SOURCE=${ANLYON_SOURCE:-}
ANLYON_RAW_BASE=${ANLYON_RAW_BASE:-https://raw.githubusercontent.com}
ANLYON_REGISTRY=${ANLYON_REGISTRY:-ghcr.io/anlyonhq}
ANLYON_IMAGES_DEFAULT=${ANLYON_IMAGES_DEFAULT:-build}

ANLYON_DIR=${ANLYON_DIR:-/opt/anlyon}
ANLYON_BIN_DIR=${ANLYON_BIN_DIR:-/usr/local/bin}
ANLYON_SWAPFILE=${ANLYON_SWAPFILE:-/swapfile}
ANLYON_FSTAB=${ANLYON_FSTAB:-/etc/fstab}
ANLYON_SYSTEMD_DIR=${ANLYON_SYSTEMD_DIR:-/etc/systemd/system}
ANLYON_SYSTEMD_RUN=${ANLYON_SYSTEMD_RUN:-/run/systemd/system}
ANLYON_CRON_DIR=${ANLYON_CRON_DIR:-/etc/cron.d}

ANLYON_OS_RELEASE=${ANLYON_OS_RELEASE:-/etc/os-release}
ANLYON_TTY=${ANLYON_TTY:-/dev/tty}
ANLYON_DNS_RESOLVER=${ANLYON_DNS_RESOLVER:-1.1.1.1}
ANLYON_DNS_WAIT=${ANLYON_DNS_WAIT:-600}
ANLYON_DNS_INTERVAL=${ANLYON_DNS_INTERVAL:-10}
ANLYON_CERT_WAIT=${ANLYON_CERT_WAIT:-120}
ANLYON_POLL=${ANLYON_POLL:-5}
ANLYON_BACKUP_KEEP=${ANLYON_BACKUP_KEEP:-7}
ANLYON_CF_API=${ANLYON_CF_API:-https://api.cloudflare.com/client/v4}

LINK_DNS_CLOUDFLARE=https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-dns-records/
LINK_CLOUDFLARE_PROXY=https://developers.cloudflare.com/dns/proxy-status/
LINK_CLOUDFLARE_TOKEN=https://developers.cloudflare.com/fundamentals/api/get-started/create-token/
LINK_DNS_VERCEL=https://vercel.com/docs/domains/managing-dns-records
LINK_DNS_NAMECHEAP=https://www.namecheap.com/support/knowledgebase/article.aspx/319/2237/how-can-i-set-up-an-a-address-record-for-my-domain/
LINK_DNS_GODADDY=https://www.godaddy.com/help/add-an-a-record-19238
LINK_DNS_PORKBUN=https://kb.porkbun.com/article/54-pointing-your-domain-to-hosting-with-a-records
LINK_DNS_SQUARESPACE=https://support.squarespace.com/hc/en-us/articles/360002101888-Adding-custom-DNS-records-to-your-Squarespace-managed-domain
LINK_DNS_ROUTE53=https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resource-record-sets-creating.html
LINK_DNS_DIGITALOCEAN=https://docs.digitalocean.com/products/networking/dns/how-to/manage-records/
LINK_DNS_HOSTINGER=https://www.hostinger.com/support/4468886-how-to-manage-a-records-at-hostinger/
LINK_DNS_GANDI=https://docs.gandi.net/en/domain_names/common_operations/dns_records.html
LINK_FW_HETZNER=https://docs.hetzner.com/cloud/firewalls/getting-started/creating-a-firewall/
LINK_FW_DIGITALOCEAN=https://docs.digitalocean.com/products/networking/firewalls/how-to/configure-rules/
LINK_FW_AWS=https://docs.aws.amazon.com/vpc/latest/userguide/working-with-security-group-rules.html
LINK_DOCKER_SCRIPT=https://get.docker.com

IP4_SOURCES="https://ifconfig.co https://api.ipify.org"
IP6_SOURCES="https://ifconfig.co https://api6.ipify.org"

CLOUDFLARE_V4="173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22"

INSTALL_FILES="docker-compose.yml Caddyfile .env.example install.sh bootstrap.sh"
STATE_NAME=anlyon-selfhost.state
OVERRIDE_NAME=docker-compose.override.yml
MIN_ENGINE=24.0.0
MIN_COMPOSE=2.24.0

usage() {
  cat <<'EOF'
Anlyon, self-hosted.

  curl -fsSL https://anlyon.com/install | sudo sh                 install (asks first)
  curl -fsSL https://anlyon.com/install@<version> | sudo sh       a pinned release
  anlyon-selfhost <command> [flags]                               once installed

Commands
  install            preflight, then each change to the server after asking, then
                     start Anlyon and print the one-time setup URL (the default)
  preflight          only check this server; changes nothing
  status             containers, readiness, version and backups
  logs [service]     recent logs (server, dashboard, caddy, postgres, redis); -f follows
  upgrade            back up, fetch the new version, start it, check health, and go
                     back to the previous images if it does not come up
  backup             database dump, the server's files and the settings into
                     <dir>/backups, the root key into its own file in <dir>/backup-keys
                     (both owner-only); --schedule daily|weekly|off sets up or removes
                     a backup that runs by itself (systemd timer or cron)
  restore <file>     restore a backup into this install (asks you to type "restore")
  uninstall          stop and remove the containers, keep the data; --purge deletes
                     everything (asks you to type "purge")

Install
  --domain <host>        anlyon.example.com (HTTPS with an automatic certificate), or an
                         IP address / localhost[:port] (plain HTTP on port 8080)
  --edition <e>          community (default), team or enterprise
  --dir <path>           install directory (default /opt/anlyon)
  --images build|ghcr    build the images here from source (default for now), or pull
                         ghcr.io/anlyonhq/anlyon-{server,dashboard}:<version>
  --version <x.y.z>      the release to install or upgrade to (ref v<x.y.z>)
  --repo <owner/name>    repository to read from (default AnlyonHQ/anlyon; ANLYON_REPO)
  --ref <ref>            branch, tag or commit (default v<version>, else main; ANLYON_REF)
  --source <git-url>     clone this repository instead (ANLYON_SOURCE)
  --from-dir <path>      use a local checkout (its root, or its deploy/self-host)
  --public-ip <ip>       this server's public IPv4, when it cannot be detected
  --allow-ip-fallback    with --yes: if the domain is not pointed here yet, continue on
                         the IP address over HTTP instead of stopping
  --allow-http           serve a public IP address over plain HTTP (sign-ins, API keys and
                         the setup token cross the network unencrypted); never the default
  --yes, -y              do not ask; accept each change (not the docker group)
  --upgrade              with --yes on an installed server: upgrade it
  --no-docker-install    never install Docker      --docker-method apt|script
  --no-swap              never add swap            --no-firewall   never touch ufw
  --add-docker-group     add your sudo user to the docker group (root-equivalent)
  --no-cli               do not install the anlyon-selfhost command
  --ignore-preflight     continue past failed checks
  --timeout <seconds>    how long to wait for the server to be ready (default 300)
  --backup-schedule daily|weekly|off
                         with --yes: set up scheduled backups (asked at a terminal)

Other
  --keep <n>             backups to keep (default 7)        --force   restore under a
  --purge                uninstall: also delete data        different root key
  --schedule daily|weekly|off   backup: run it by itself    --at <HH:MM>   at this
                         server time (default 03:17)
  -f, --follow           logs: keep following               --tail <n> log lines

Environment: ANLYON_REPO, ANLYON_REF, ANLYON_SOURCE, ANLYON_DIR, GITHUB_TOKEN (private
repositories only; sent to GitHub, never stored or printed).
EOF
}

case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
  *[Uu][Tt][Ff]-8*|*[Uu][Tt][Ff]8*)
    UI_UTF8=1; SYM_OK='✓'; SYM_FAIL='✗'; SYM_WARN='!'; SYM_DOT='·'; SYM_RUN='·'; SYM_BAR='│' ;;
  *) UI_UTF8=0; SYM_OK='ok'; SYM_FAIL='XX'; SYM_WARN='!!'; SYM_DOT='-'; SYM_RUN='..'; SYM_BAR='|' ;;
esac

UI_FANCY=0
have() { command -v "$1" >/dev/null 2>&1; }
ui_is_tty() { [ -t 1 ]; }
C_DIM=""; C_BOLD=""; C_OK=""; C_FAIL=""; C_WARN=""; C_OFF=""; C_CLR=""
ui_init() {
  UI_FANCY=0
  case "${ANLYON_UI:-auto}" in
    fancy) UI_FANCY=1 ;;
    plain) ;;
    *)
      if ui_is_tty && [ -z "${NO_COLOR+set}" ] && [ "${TERM:-dumb}" != dumb ] && [ "${ASSUME_YES:-0}" -ne 1 ]; then
        UI_FANCY=1
      fi ;;
  esac
  if [ "$UI_FANCY" -eq 1 ]; then
    C_DIM=$(printf '\033[2m'); C_BOLD=$(printf '\033[1m'); C_OK=$(printf '\033[32m')
    C_FAIL=$(printf '\033[31m'); C_WARN=$(printf '\033[33m'); C_OFF=$(printf '\033[0m')
    C_CLR=$(printf '\r\033[K')
    UI_COLS=$( (stty size < "$ANLYON_TTY") 2>/dev/null | awk '{ print $2 }' || true)
    case "${UI_COLS:-}" in ""|*[!0-9]*) UI_COLS=80 ;; esac
    [ "$UI_COLS" -ge 40 ] || UI_COLS=40
  else
    C_DIM=""; C_BOLD=""; C_OK=""; C_FAIL=""; C_WARN=""; C_OFF=""; C_CLR=""; UI_COLS=80
  fi
}

say() { printf '%s\n' "$*"; }
note() { printf '  %s\n' "$*"; }
dim() { printf '  %s%s%s\n' "$C_DIM" "$*" "$C_OFF"; }
warn() { printf '%s%s%s %s\n' "$C_WARN" "$SYM_WARN" "$C_OFF" "$*" >&2; }
die() { printf '%s%s%s %s\n' "$C_FAIL" "$SYM_FAIL" "$C_OFF" "$*" >&2; exit 1; }
usage_error() { printf '%s\n' "$*" >&2; printf 'Run with --help for the flags.\n' >&2; exit 2; }
heading() {
  if [ -n "${2:-}" ]; then printf '\n%s%s%s %s%s %s%s\n' "$C_BOLD" "$1" "$C_OFF" "$C_DIM" "$SYM_DOT" "$2" "$C_OFF"
  else printf '\n%s%s%s\n' "$C_BOLD" "$1" "$C_OFF"; fi
}
now() { date +%s; }

fmt_elapsed() {
  if [ "$1" -lt 60 ]; then printf '%ss' "$1"; else printf '%d:%02d' $(($1 / 60)) $(($1 % 60)); fi
}

result_line() {
  rl_kind=$1; rl_msg=$2; rl_secs=${3:-0}
  case "$rl_kind" in
    ok) rl_sym="$C_OK$SYM_OK$C_OFF" ;;
    warn) rl_sym="$C_WARN$SYM_WARN$C_OFF" ;;
    *) rl_sym="$C_FAIL$SYM_FAIL$C_OFF" ;;
  esac
  if [ "$rl_secs" -ge 2 ]; then
    printf '  %s %s  %s%s%s\n' "$rl_sym" "$rl_msg" "$C_DIM" "$(fmt_elapsed "$rl_secs")" "$C_OFF"
  else
    printf '  %s %s\n' "$rl_sym" "$rl_msg"
  fi
}
ok_line() { result_line ok "$@"; }
warn_line() { result_line warn "$@"; }

ui_header() {
  if [ -n "$VERSION" ]; then uh_ver="v$VERSION"
  elif [ -n "$FROM_DIR" ]; then uh_ver="local checkout"
  else uh_ver=${REF:-main}; fi
  printf '\n%sAnlyon self-hosted%s %s%s %s%s\n' "$C_BOLD" "$C_OFF" "$C_DIM" "$SYM_DOT" "$uh_ver" "$C_OFF"
  printf '%s%s%s\n' "$C_DIM" "${1:-Nothing changes on this server without your answer.}" "$C_OFF"
}

LOG_FILE=""
LOG_NAME=""
log_open() {
  if [ -z "$LOG_FILE" ]; then
    LOG_NAME="${CMD:-install}-$(date -u +%Y%m%d-%H%M%S).log"
    LOG_FILE=$(umask 077; mktemp "${TMPDIR:-/tmp}/anlyon-$LOG_NAME.XXXXXX")
  fi
  log_settle
}

LOG_STAY_TMP=0
log_settle() {
  [ -n "$LOG_FILE" ] && [ -d "$ANLYON_DIR" ] && [ "$LOG_STAY_TMP" -eq 0 ] || return 0
  ls_dir="$ANLYON_DIR/logs"
  case "$LOG_FILE" in "$ls_dir"/*) return 0 ;; esac
  (umask 077; mkdir -p "$ls_dir") || return 0
  chmod 700 "$ls_dir" 2>/dev/null || true
  ls_new="$ls_dir/$LOG_NAME"
  (umask 077; cat "$LOG_FILE" >> "$ls_new") || return 0
  chmod 600 "$ls_new" 2>/dev/null || true
  rm -f "$LOG_FILE"
  LOG_FILE=$ls_new
}

log_lines() { if [ -f "$LOG_FILE" ]; then wc -l < "$LOG_FILE" | tr -d ' '; else echo 0; fi; }

log_tail() {
  lt_from=$1
  lt_out=$(tail -n "+$((lt_from + 1))" "$LOG_FILE" 2>/dev/null | grep -v '^--- ' | tail -n 20 || true)
  if [ -n "$lt_out" ]; then
    printf '%s\n' "$lt_out" | sed "s/^/    $C_DIM$SYM_BAR$C_OFF /" >&2
  fi
  printf '  %sFull log: %s%s\n' "$C_DIM" "$LOG_FILE" "$C_OFF" >&2
}

phase_of() {
  tail -n "+$(($2 + 1))" "$LOG_FILE" 2>/dev/null | tail -n 40 | awk -v kind="$1" -v dot="$SYM_DOT" '
    /^--- / { next }
    { l = tolower($0) }
    kind == "build" {
      if (match(l, /\[(server|dashboard)[ \]]/)) img = substr(l, RSTART + 1, RLENGTH - 2)
      if (l ~ /load build definition|load metadata|resolve image config|load \.dockerignore|load build context/) p = "resolving base images"
      else if (l ~ /pnpm install|pnpm fetch|npm ci|npm install|yarn install|apk add|apt-get install|corepack/) p = "installing dependencies"
      else if (l ~ /pnpm (run )?build|vite build|tsc|turbo|esbuild|tsup|--filter/) p = "building"
      else if (l ~ /exporting|writing image|naming to|unpacking to/) p = "exporting image"
    }
    kind == "pull" {
      if (l ~ /pulling fs layer|waiting|downloading|pulling/) p = "downloading layers"
      if (l ~ /download complete|extracting|verifying/) p = "extracting layers"
    }
    kind == "apt" {
      if (l ~ /^(get|hit|ign):|reading package lists|fetched|downloading|apt-get update/) p = "downloading packages"
      else if (l ~ /unpacking|selecting previously|preparing to unpack/) p = "unpacking packages"
      else if (l ~ /setting up|processing triggers/) p = "configuring packages"
    }
    kind == "up" {
      if (l ~ /creat/) p = "creating containers"
      else if (l ~ /waiting|healthy/) p = "waiting for the database"
      else if (l ~ /start/) p = "starting containers"
    }
    END { if (p != "" && img != "") print img " " dot " " p; else print p }'
}

spin_frame() {
  if [ "$UI_UTF8" -eq 1 ]; then
    case $(($1 % 10)) in
      0) FRAME='⠋' ;; 1) FRAME='⠙' ;; 2) FRAME='⠹' ;; 3) FRAME='⠸' ;; 4) FRAME='⠼' ;;
      5) FRAME='⠴' ;; 6) FRAME='⠦' ;; 7) FRAME='⠧' ;; 8) FRAME='⠇' ;; *) FRAME='⠏' ;;
    esac
  else
    # shellcheck disable=SC1003
    case $(($1 % 4)) in 0) FRAME='|' ;; 1) FRAME='/' ;; 2) FRAME='-' ;; *) FRAME='\' ;; esac
  fi
}

STEP_SOFT=0
step() {
  st_run=${1%%|*}; st_rest=${1#*|}; st_kind=$2; shift 2
  st_done=${st_rest%%|*}; st_fail=$st_run
  case "$st_rest" in *"|"*) st_fail=${st_rest#*|} ;; esac
  log_open
  st_from=$(log_lines)
  printf '%s %s (%s)\n' '---' "$st_run" "$(date -u +%H:%M:%SZ)" >> "$LOG_FILE"
  st_start=$(now)
  case "$st_kind" in
    -|"") st_fixed="" ;;
    build|pull|apt|up) st_fixed="" ;;
    *) st_fixed=$st_kind ;;
  esac
  if [ "$UI_FANCY" -ne 1 ]; then
    case "$st_kind" in -|"") ;; *) printf '  %s %s\n' "$SYM_RUN" "$st_run" ;; esac
  fi
  "$@" >> "$LOG_FILE" 2>&1 &
  st_pid=$!
  trap 'step_interrupted' INT TERM
  if [ "$UI_FANCY" -eq 1 ]; then
    st_i=0; st_text=$st_run; st_el=0
    while kill -0 "$st_pid" 2>/dev/null; do
      if [ $((st_i % 5)) -eq 0 ]; then
        st_el=$(( $(now) - st_start ))
        st_phase=$st_fixed
        case "$st_kind" in build|pull|apt|up) st_phase=$(phase_of "$st_kind" "$st_from") ;; esac
        st_text="$st_run${st_phase:+ $SYM_DOT $st_phase}"
        st_max=$((UI_COLS - 14))
        if [ "${#st_text}" -gt "$st_max" ]; then st_text=$(printf '%s' "$st_text" | cut -c "1-$st_max"); fi
      fi
      spin_frame "$st_i"
      printf '%s  %s%s%s %s  %s%s%s' "$C_CLR" "$C_DIM" "$FRAME" "$C_OFF" "$st_text" "$C_DIM" "$(fmt_elapsed "$st_el")" "$C_OFF"
      st_i=$((st_i + 1))
      sleep 0.1 2>/dev/null || sleep 1
    done
    printf '%s' "$C_CLR"
  fi
  st_rc=0; wait "$st_pid" || st_rc=$?
  trap - INT TERM
  st_secs=$(( $(now) - st_start ))
  if [ "$st_rc" -eq 0 ]; then
    ok_line "$st_done" "$st_secs"
  elif [ "$STEP_SOFT" -eq 1 ]; then
    warn_line "$st_fail" "$st_secs"
  else
    result_line fail "$st_fail" "$st_secs" >&2
    log_tail "$st_from"
  fi
  return "$st_rc"
}

step_interrupted() {
  pkill -TERM -P "$st_pid" 2>/dev/null || true
  kill -TERM "$st_pid" 2>/dev/null || true
  printf '%s\n' "$C_CLR" >&2
  warn "Stopped. The log so far: $LOG_FILE"
  exit 130
}

HAVE_TTY=0
open_tty() {
  [ "$HAVE_TTY" -eq 1 ] && return 0
  if (exec 3<"$ANLYON_TTY") 2>/dev/null; then
    exec 3<"$ANLYON_TTY"
    HAVE_TTY=1
  fi
}

ask() {
  ask_q=$1; ask_default=$2
  if [ "$ASSUME_YES" -eq 1 ]; then
    printf '%s?%s %s yes (--yes)\n' "$C_BOLD" "$C_OFF" "$ask_q"
    return 0
  fi
  [ "$HAVE_TTY" -eq 1 ] || die "No terminal to ask on: \"$ask_q\". Re-run with --yes to accept each change."
  if [ "$ask_default" = y ]; then ask_hint='[Y/n]'; else ask_hint='[y/N]'; fi
  printf '%s?%s %s  %s%s%s ' "$C_BOLD" "$C_OFF" "$ask_q" "$C_DIM" "$ask_hint" "$C_OFF" >&2
  ask_answer=""
  IFS= read -r ask_answer <&3 || ask_answer=""
  echo_answer "$ask_answer"
  case "$ask_answer" in
    y|Y|yes|YES|Yes) return 0 ;;
    n|N|no|NO|No) return 1 ;;
    "") [ "$ask_default" = y ] ;;
    *) return 1 ;;
  esac
}

prompt() {
  REPLY=""
  [ "$HAVE_TTY" -eq 1 ] || return 0
  printf '%s?%s %s' "$C_BOLD" "$C_OFF" "$1" >&2
  IFS= read -r REPLY <&3 || REPLY=""
  echo_answer "$REPLY"
}

echo_answer() { [ -t 3 ] || printf '%s\n' "$1" >&2; }

confirm_word() {
  [ "$HAVE_TTY" -eq 1 ] || die "This needs a typed confirmation on a terminal."
  printf '%s?%s Type %s%s%s to continue: ' "$C_BOLD" "$C_OFF" "$C_BOLD" "$1" "$C_OFF" >&2
  confirm_answer=""
  IFS= read -r confirm_answer <&3 || confirm_answer=""
  echo_answer "$confirm_answer"
  [ "$confirm_answer" = "$1" ]
}

read_key() {
  KEY=""
  if [ -t 3 ]; then
    rk_saved=$(stty -g <&3 2>/dev/null || true)
    stty -icanon -echo min 0 time 10 <&3 2>/dev/null || true
    rk_raw=$(dd bs=1 count=1 2>/dev/null <&3; echo x)
    [ -n "$rk_saved" ] && stty "$rk_saved" <&3 2>/dev/null
    rk_raw=${rk_raw%x}
    case "$rk_raw" in
      "") KEY="" ;;
      "$(printf '\n')"|"$(printf '\r')") KEY=enter ;;
      *) KEY=$rk_raw ;;
    esac
  else
    if IFS= read -r rk_line <&3; then
      if [ -z "$rk_line" ]; then KEY=enter; else KEY=$rk_line; fi
    else
      sleep 1
    fi
  fi
}

version_ge() {
  awk -v a="$1" -v b="$2" 'BEGIN {
    sub(/^[^0-9]*/, "", a); sub(/^[^0-9]*/, "", b)
    split(a, x, /[^0-9]+/); split(b, y, /[^0-9]+/)
    for (i = 1; i <= 3; i++) { if (x[i] + 0 > y[i] + 0) exit 0; if (x[i] + 0 < y[i] + 0) exit 1 }
    exit 0 }'
}

is_ipv4() {
  printf '%s' "$1" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' || return 1
  awk -v ip="$1" 'BEGIN { n = split(ip, p, "."); for (i = 1; i <= n; i++) if (p[i] + 0 > 255) exit 1; exit 0 }'
}

is_ipv6() { printf '%s' "$1" | grep -Eq '^[0-9a-fA-F:]+$' && case "$1" in *:*:*) return 0 ;; esac; return 1; }

ipv4_in_cidr() {
  awk -v ip="$1" -v cidr="$2" '
    function n(s,   p) { split(s, p, "."); return ((p[1] * 256 + p[2]) * 256 + p[3]) * 256 + p[4] }
    BEGIN { split(cidr, c, "/"); size = 2 ^ (32 - c[2]); base = n(c[1]); base -= base % size; v = n(ip)
            exit !(v >= base && v < base + size) }'
}

ipv4_in_cloudflare() {
  for cf_range in $CLOUDFLARE_V4; do
    ipv4_in_cidr "$1" "$cf_range" && return 0
  done
  return 1
}

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

http_get() {
  hg_url=$1; shift
  case "$hg_url" in
    https://raw.githubusercontent.com/*|https://github.com/*|https://api.github.com/*)
      if [ -n "${GITHUB_TOKEN:-}" ]; then
        printf 'header = "Authorization: Bearer %s"\n' "$GITHUB_TOKEN" | curl --config - -fsSL "$@" "$hg_url"
        return
      fi ;;
  esac
  curl -fsSL "$@" "$hg_url"
}

env_get() { [ -r "$2" ] || return 0; sed -n "s/^$1=//p" "$2" | tail -n 1; }
state_file() { printf '%s/%s' "$ANLYON_DIR" "$STATE_NAME"; }
state_get() { env_get "$1" "$(state_file)"; }

compose() { (cd "$ANLYON_DIR" && docker compose "$@"); }

is_installed() { [ -n "$(state_get COMPLETED_AT 2>/dev/null || true)" ]; }
is_partial() { ! is_installed && { [ -e "$ANLYON_DIR/.env" ] || [ -e "$(state_file)" ]; }; }
mark_complete() {
  mc_file=$(state_file)
  [ -e "$mc_file" ] || return 0
  grep -v '^COMPLETED_AT=' "$mc_file" > "$mc_file.tmp" || true
  printf 'COMPLETED_AT=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$mc_file.tmp"
  chmod 600 "$mc_file.tmp"
  mv -f "$mc_file.tmp" "$mc_file"
}

existing_ancestor() {
  ea=$1
  while [ ! -d "$ea" ]; do ea=$(dirname "$ea"); done
  printf '%s' "$ea"
}

parse_args() {
  case "${0##*/}" in anlyon-selfhost) CMD=help ;; *) CMD=install ;; esac
  DOMAIN=""; EDITION=community; IMAGES=""; VERSION=""; FROM_DIR=""; PUBLIC_IP_FLAG=""
  ASSUME_YES=0; UPGRADE=0; ALLOW_IP_FALLBACK=0; ALLOW_HTTP=0; IGNORE_PREFLIGHT=0
  NO_SWAP=0; NO_FIREWALL=0; NO_DOCKER_INSTALL=0; DOCKER_METHOD=apt; ADD_DOCKER_GROUP=0; NO_CLI=0
  READY_TIMEOUT=300; KEEP=$ANLYON_BACKUP_KEEP; PURGE=0; FORCE=0; FOLLOW=0; TAIL=200
  BACKUP_SCHEDULE=""; BACKUP_AT=03:17
  POS1=""; POS_COUNT=0
  REPO=$ANLYON_REPO; REF=$ANLYON_REF; SOURCE=$ANLYON_SOURCE

  if [ $# -gt 0 ]; then
    case "$1" in
      install|preflight|status|logs|upgrade|backup|restore|uninstall|help|version) CMD=$1; shift ;;
    esac
  fi

  while [ $# -gt 0 ]; do
    case "$1" in
      --*=*) pa_opt=${1%%=*}; pa_val=${1#*=}; shift; set -- "$pa_opt" "$pa_val" "$@"; continue ;;
    esac
    case "$1" in
      --domain|--edition|--dir|--images|--version|--repo|--ref|--source|--from-dir|--public-ip|--docker-method|--timeout|--keep|--tail|--schedule|--backup-schedule|--at)
        [ $# -ge 2 ] || usage_error "$1 needs a value."
        case "$1" in
          --domain) DOMAIN=$2 ;;
          --edition) EDITION=$2 ;;
          --dir) ANLYON_DIR=$2 ;;
          --images) IMAGES=$2 ;;
          --version) VERSION=${2#v} ;;
          --repo) REPO=$2 ;;
          --ref) REF=$2 ;;
          --source) SOURCE=$2 ;;
          --from-dir) FROM_DIR=$2 ;;
          --public-ip) PUBLIC_IP_FLAG=$2 ;;
          --docker-method) DOCKER_METHOD=$2 ;;
          --timeout) READY_TIMEOUT=$2 ;;
          --keep) KEEP=$2 ;;
          --tail) TAIL=$2 ;;
          --schedule|--backup-schedule) BACKUP_SCHEDULE=$2 ;;
          --at) BACKUP_AT=$2 ;;
        esac
        shift 2 ;;
      --yes|-y) ASSUME_YES=1; shift ;;
      --upgrade) UPGRADE=1; shift ;;
      --allow-ip-fallback) ALLOW_IP_FALLBACK=1; shift ;;
      --allow-http) ALLOW_HTTP=1; shift ;;
      --ignore-preflight) IGNORE_PREFLIGHT=1; shift ;;
      --no-swap) NO_SWAP=1; shift ;;
      --no-firewall) NO_FIREWALL=1; shift ;;
      --no-docker-install) NO_DOCKER_INSTALL=1; shift ;;
      --add-docker-group) ADD_DOCKER_GROUP=1; shift ;;
      --no-cli) NO_CLI=1; shift ;;
      --purge) PURGE=1; shift ;;
      --force) FORCE=1; shift ;;
      -f|--follow) FOLLOW=1; shift ;;
      -h|--help) CMD=help; shift ;;
      -*) usage_error "Unknown option: $1" ;;
      *)
        POS_COUNT=$((POS_COUNT + 1))
        [ "$POS_COUNT" -eq 1 ] || usage_error "Unexpected argument: $1"
        POS1=$1; shift ;;
    esac
  done

  case "$EDITION" in community|team|enterprise) ;; *) usage_error "--edition must be community, team or enterprise." ;; esac
  case "$DOCKER_METHOD" in apt|script) ;; *) usage_error "--docker-method must be apt or script." ;; esac
  case "${IMAGES:-build}" in build|ghcr) ;; *) usage_error "--images must be build or ghcr." ;; esac
  for pa_num in "$READY_TIMEOUT" "$KEEP" "$TAIL"; do
    case "$pa_num" in ""|*[!0-9]*) usage_error "--timeout, --keep and --tail take a whole number." ;; esac
  done
  [ "$KEEP" -ge 1 ] || usage_error "--keep must be at least 1."
  case "$BACKUP_SCHEDULE" in ""|daily|weekly|off) ;; *) usage_error "--schedule must be daily, weekly or off." ;; esac
  printf '%s' "$BACKUP_AT" | grep -Eq '^([01][0-9]|2[0-3]):[0-5][0-9]$' || usage_error "--at must be a time such as 03:17 (24-hour, server time)."
  if [ -n "$VERSION" ]; then
    printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-.+][0-9A-Za-z.-]+)?$' ||
      usage_error "--version must look like 1.2.3."
  fi
  if [ -n "$PUBLIC_IP_FLAG" ] && ! is_ipv4 "$PUBLIC_IP_FLAG"; then usage_error "--public-ip must be an IPv4 address."; fi
  case "$REPO" in ""|*/*) ;; *) usage_error "--repo must look like owner/name." ;; esac
  case "$CMD" in
    restore) [ -n "$POS1" ] || usage_error "restore needs the backup file: anlyon-selfhost restore <file>" ;;
    logs) ;;
    *) [ -z "$POS1" ] || usage_error "Unexpected argument: $POS1" ;;
  esac
  if [ -n "$FROM_DIR" ]; then
    [ -d "$FROM_DIR" ] || usage_error "--from-dir $FROM_DIR is not a directory."
    FROM_DIR=$(cd "$FROM_DIR" && pwd)
  fi
  return 0
}

resolve_source() {
  if [ -z "$VERSION" ] && [ -z "$REF" ] && [ -n "$ANLYON_RELEASE_VERSION" ]; then VERSION=$ANLYON_RELEASE_VERSION; fi
  [ -n "$IMAGES" ] || IMAGES=$(state_get IMAGES 2>/dev/null || true)
  [ -n "$IMAGES" ] || IMAGES=$ANLYON_IMAGES_DEFAULT
  if [ "$IMAGES" = ghcr ] && [ -z "$VERSION" ]; then
    usage_error "--images ghcr needs --version (the release whose images to pull)."
  fi
  if [ -z "$REF" ]; then
    if [ -n "$VERSION" ]; then REF="v$VERSION"; else REF=main; fi
  fi
  [ -n "$REPO" ] || REPO=AnlyonHQ/anlyon
  GIT_URL=${SOURCE:-https://github.com/$REPO.git}
}

address_for() {
  af=$(lower "$1" | sed -e 's#^https\{0,1\}://##' -e 's#/*$##')
  case "$af" in */*|*@*|*" "*|"") usage_error "--domain must be a host name such as anlyon.example.com, an IP address, or localhost." ;; esac
  HOST=${af%:*}; af_port=""
  [ "$HOST" != "$af" ] && af_port=${af##*:}
  if [ -n "$af_port" ]; then
    case "$af_port" in *[!0-9]*) usage_error "The port in --domain must be a number." ;; esac
    { [ "$af_port" -ge 1 ] && [ "$af_port" -le 65535 ]; } || usage_error "The port in --domain must be 1-65535."
  fi
  DOMAIN=$af
  if [ "$HOST" = localhost ] || is_ipv4 "$HOST"; then
    IS_HOSTNAME=0; HTTP_PORT=${af_port:-8080}; HTTPS_PORT=8443
    PUBLIC_URL="http://$HOST:$HTTP_PORT"
  else
    printf '%s' "$HOST" | grep -Eq '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$' ||
      usage_error "--domain must be a host name such as anlyon.example.com, an IP address, or localhost."
    IS_HOSTNAME=1; HTTP_PORT=80; HTTPS_PORT=${af_port:-443}
    if [ "$HTTPS_PORT" = 443 ]; then PUBLIC_URL="https://$HOST"; else PUBLIC_URL="https://$HOST:$HTTPS_PORT"; fi
  fi
}

require_root() {
  [ "$(id -u)" = 0 ] && return 0
  case "${0##*/}" in bootstrap.sh|anlyon-selfhost) rr_file=1 ;; *) rr_file=0 ;; esac
  if [ "$rr_file" -eq 1 ] && [ -f "$0" ] && have sudo; then
    say "Anlyon installs system-wide; continuing with sudo."
    exec sudo --preserve-env=GITHUB_TOKEN,ANLYON_REPO,ANLYON_REF,ANLYON_SOURCE,ANLYON_DIR sh "$0" "$@"
  fi
  die "Run this as root: curl -fsSL https://anlyon.com/install | sudo sh"
}

pf_reset() { PF_ROWS=""; PF_FAILS=0; PF_FATAL=0; PF_WARNS=0; PF_FIXES=" "; }
pf_row() {
  PF_ROWS="$PF_ROWS$1|$2|$3
"
  case "$1" in
    fail) PF_FAILS=$((PF_FAILS + 1)) ;;
    fatal) PF_FATAL=$((PF_FATAL + 1)) ;;
    warn) PF_WARNS=$((PF_WARNS + 1)) ;;
  esac
}
pf_fix() { PF_FIXES="$PF_FIXES$1 "; }
pf_has_fix() { case "$PF_FIXES" in *" $1 "*) return 0 ;; esac; return 1; }
pf_status_of() { printf '%s' "$PF_ROWS" | awk -F'|' -v l="$1" '$2 == l { s = $1 } END { print s }'; }
pf_render() {
  printf '%s' "$PF_ROWS" | while IFS='|' read -r pr_st pr_label pr_detail; do
    pr_more=""
    case "$pr_st" in
      ok) pr_sym="$C_OK$SYM_OK$C_OFF" ;;
      warn) pr_sym="$C_WARN$SYM_WARN$C_OFF" ;;
      fix) pr_sym="$C_FAIL$SYM_FAIL$C_OFF"; pr_more=" ${C_DIM}(offered below)$C_OFF" ;;
      *) pr_sym="$C_FAIL$SYM_FAIL$C_OFF" ;;
    esac
    printf '  %s %-12s %s%s\n' "$pr_sym" "$pr_label" "$pr_detail" "$pr_more"
  done
}

os_field() { sed -n "s/^$1=//p" "$ANLYON_OS_RELEASE" 2>/dev/null | head -n 1 | tr -d '"'; }

check_system() {
  OS_ID=""; OS_CODENAME=""
  cs_kernel=$(uname -s 2>/dev/null || echo unknown)
  if [ "$cs_kernel" != Linux ]; then
    pf_row fatal System "$cs_kernel: the installer runs on Linux servers"
    return
  fi
  if [ ! -r "$ANLYON_OS_RELEASE" ]; then
    pf_row warn OS "unknown Linux (no $ANLYON_OS_RELEASE); tested on Ubuntu 22.04/24.04 and Debian 12"
    return
  fi
  OS_ID=$(os_field ID)
  OS_CODENAME=$(os_field UBUNTU_CODENAME)
  [ -n "$OS_CODENAME" ] || OS_CODENAME=$(os_field VERSION_CODENAME)
  cs_ver=$(os_field VERSION_ID)
  cs_name=$(os_field PRETTY_NAME)
  [ -n "$cs_name" ] || cs_name="$OS_ID $cs_ver"
  case "$OS_ID:$cs_ver" in
    ubuntu:22.04|ubuntu:24.04|debian:12) pf_row ok OS "$cs_name" ;;
    *) pf_row warn OS "$cs_name: not tested (Ubuntu 22.04/24.04 and Debian 12 are)" ;;
  esac
}

check_arch() {
  case "$(uname -m 2>/dev/null || echo unknown)" in
    x86_64|amd64) pf_row ok Architecture "x86_64" ;;
    aarch64|arm64) pf_row ok Architecture "arm64" ;;
    *) pf_row fail Architecture "$(uname -m 2>/dev/null): images exist for x86_64 and arm64 only" ;;
  esac
}

check_cpu() {
  cc_n=$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 0)
  if [ "$cc_n" -ge 2 ]; then pf_row ok CPU "$cc_n cores"
  else pf_row fail CPU "$cc_n core: 2 or more are needed"; fi
}

check_memory() {
  MEM_MB=$(free -m 2>/dev/null | awk '/^Mem:/ { print $2 }')
  SWAP_MB=$(free -m 2>/dev/null | awk '/^Swap:/ { print $2 }')
  MEM_MB=${MEM_MB:-0}; SWAP_MB=${SWAP_MB:-0}
  SWAP_ADD_GB=0
  if [ "$MEM_MB" -ge 3584 ]; then
    pf_row ok Memory "$MEM_MB MB"
  elif [ "$MEM_MB" -lt 1792 ]; then
    pf_row fail Memory "$MEM_MB MB: at least 2 GB is needed (4 GB recommended)"
  elif [ $((MEM_MB + SWAP_MB)) -ge 3584 ]; then
    pf_row ok Memory "$MEM_MB MB plus $SWAP_MB MB swap"
  else
    SWAP_ADD_GB=$(( (4096 - MEM_MB - SWAP_MB + 1023) / 1024 ))
    [ "$SWAP_ADD_GB" -ge 2 ] || SWAP_ADD_GB=2
    pf_row fix Memory "$MEM_MB MB and $SWAP_MB MB swap: below 4 GB; a ${SWAP_ADD_GB} GB swap file makes up the difference"
    pf_fix swap
  fi
}

check_disk() {
  cd_path=$(existing_ancestor "$ANLYON_DIR")
  cd_kb=$(df -Pk "$cd_path" 2>/dev/null | awk 'NR == 2 { print $4 }')
  if [ -d /var/lib/docker ]; then
    cd_docker=$(df -Pk /var/lib/docker 2>/dev/null | awk 'NR == 2 { print $4 }')
    if [ -n "$cd_docker" ] && [ -n "$cd_kb" ] && [ "$cd_docker" -lt "$cd_kb" ]; then cd_kb=$cd_docker; fi
  fi
  if [ -z "$cd_kb" ]; then pf_row warn Disk "could not read free space"; return; fi
  cd_gb=$((cd_kb / 1048576))
  if [ "$cd_kb" -ge 20971520 ]; then pf_row ok Disk "$cd_gb GB free"
  else pf_row fail Disk "$cd_gb GB free: 20 GB is needed (images, database, backups)"; fi
}

port_in_use() {
  if have ss; then
    piu_list=$(ss -Htln 2>/dev/null | awk '{ print $4 }')
  elif have netstat; then
    piu_list=$(netstat -tln 2>/dev/null | awk 'NR > 2 { print $4 }')
  else
    return 2
  fi
  printf '%s\n' "$piu_list" | grep -Eq "[:.]$1\$"
}

check_ports() {
  cp_busy=""; cp_unknown=0
  for cp_p in $HTTP_PORT $HTTPS_PORT; do
    cp_rc=0; port_in_use "$cp_p" || cp_rc=$?
    case "$cp_rc" in 0) cp_busy="$cp_busy $cp_p" ;; 2) cp_unknown=1 ;; esac
  done
  if [ "$cp_unknown" -eq 1 ]; then
    pf_row warn Ports "could not check $HTTP_PORT and $HTTPS_PORT (no ss or netstat)"
  elif [ -n "$cp_busy" ]; then
    pf_row fail Ports "in use:$cp_busy. See what holds them: ss -ltnp"
  else
    pf_row ok Ports "$HTTP_PORT and $HTTPS_PORT are free"
  fi
}

check_docker() {
  DOCKER_VERSION=""; COMPOSE_VERSION=""
  if ! have docker; then
    pf_row fix Docker "not installed"; pf_fix docker; return
  fi
  DOCKER_VERSION=$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)
  if [ -z "$DOCKER_VERSION" ]; then
    pf_row fix Docker "installed, but the engine is not running"; pf_fix docker-start; return
  fi
  COMPOSE_VERSION=$(docker compose version --short 2>/dev/null || true)
  if ! version_ge "$DOCKER_VERSION" "$MIN_ENGINE"; then
    pf_row fix Docker "Engine $DOCKER_VERSION is older than ${MIN_ENGINE%.0}"; pf_fix docker; return
  fi
  if [ -z "$COMPOSE_VERSION" ]; then
    pf_row fix Docker "Engine $DOCKER_VERSION without the Compose v2 plugin"; pf_fix docker; return
  fi
  if ! version_ge "$COMPOSE_VERSION" "$MIN_COMPOSE"; then
    pf_row fix Docker "Compose $COMPOSE_VERSION is older than $MIN_COMPOSE"; pf_fix docker; return
  fi
  if [ "$IMAGES" = build ] && ! docker buildx version >/dev/null 2>&1; then
    pf_row fix Docker "Engine $DOCKER_VERSION, Compose $COMPOSE_VERSION, but no buildx to build the images"; pf_fix docker; return
  fi
  pf_row ok Docker "Engine $DOCKER_VERSION, Compose $COMPOSE_VERSION"
}

check_time() {
  if ! have timedatectl; then
    pf_row warn Clock "cannot tell whether the clock is synchronised (no timedatectl)"; return
  fi
  case "$(timedatectl show -p NTPSynchronized --value 2>/dev/null || true)" in
    yes) pf_row ok Clock "synchronised" ;;
    *) pf_row warn Clock "not synchronised: certificates and sign-in need the right time (timedatectl set-ntp true)" ;;
  esac
}

check_privileges() {
  if [ "$(id -u)" = 0 ]; then
    if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then pf_row ok Privileges "root (sudo from $SUDO_USER)"
    else pf_row ok Privileges "root"; fi
  else
    pf_row fatal Privileges "not root: run with sudo"
  fi
}

check_tools() {
  TOOLS_MISSING=""
  have curl || TOOLS_MISSING="$TOOLS_MISSING curl"
  if needs_git && ! have git; then TOOLS_MISSING="$TOOLS_MISSING git"; fi
  if [ -z "$TOOLS_MISSING" ]; then
    pf_row ok Tools "curl$(needs_git && printf ', git')"
  elif have apt-get; then
    pf_row fix Tools "missing:$TOOLS_MISSING"; pf_fix tools
  else
    pf_row fail Tools "missing:$TOOLS_MISSING; install them with the system's package manager"
  fi
}

needs_git() { [ -z "$FROM_DIR" ] && { [ "$IMAGES" = build ] || [ -n "$SOURCE" ]; }; }

check_dns() {
  if [ "$IS_HOSTNAME" -ne 1 ]; then
    pf_row ok DNS "skipped: $HOST is served over plain HTTP"
    return
  fi
  dns_evaluate
  case "$DNS_STATUS" in
    ok) pf_row ok DNS "$HOST -> $PUBLIC_IP4 (this server)" ;;
    unknown) pf_row warn DNS "could not find this server's public IP; pass --public-ip" ;;
    missing) pf_row fix DNS "$HOST has no A record yet"; pf_fix dns ;;
    extra) pf_row fix DNS "$HOST -> $(dns_join "$DNS_A"): also points at other servers"; pf_fix dns ;;
    proxied) pf_row fix DNS "$HOST is behind Cloudflare's proxy (orange cloud)"; pf_fix dns ;;
    aaaa) pf_row fix DNS "$HOST has an AAAA record for another server ($(dns_join "$DNS_AAAA"))"; pf_fix dns ;;
    *) pf_row fix DNS "$HOST -> $(dns_join "$DNS_A"), but this server is $PUBLIC_IP4"; pf_fix dns ;;
  esac
}

run_preflight() {
  pf_reset
  check_privileges
  check_system
  check_arch
  check_cpu
  check_memory
  check_disk
  check_ports
  check_docker
  check_tools
  check_time
  check_dns
  heading "Preflight" "nothing has changed yet"
  pf_render
}

dns_join() { printf '%s' "$1" | tr '\n' ' ' | sed -e 's/ *$//' -e 's/ /, /g'; }

detect_public_ip() {
  PUBLIC_IP4=""; PUBLIC_IP6=""
  if [ -n "$PUBLIC_IP_FLAG" ]; then PUBLIC_IP4=$PUBLIC_IP_FLAG
  else
    dp_seen=""
    for dp_src in $IP4_SOURCES; do
      dp_ip=$(http_get "$dp_src" -4 --max-time 5 2>/dev/null | tr -d ' \r\n' || true)
      is_ipv4 "$dp_ip" || continue
      if [ -z "$dp_seen" ]; then dp_seen=$dp_ip
      elif [ "$dp_seen" = "$dp_ip" ]; then PUBLIC_IP4=$dp_ip
      else dp_seen="conflict"; fi
    done
    if [ -z "$PUBLIC_IP4" ] && is_ipv4 "$dp_seen" && local_has_ip "$dp_seen"; then PUBLIC_IP4=$dp_seen; fi
    if [ -z "$PUBLIC_IP4" ]; then
      prompt "Could not tell this server's public IPv4 address. Type it (or Enter to skip): "
      if is_ipv4 "$REPLY"; then PUBLIC_IP4=$REPLY; fi
    fi
  fi
  for dp_src in $IP6_SOURCES; do
    dp_ip=$(http_get "$dp_src" -6 --max-time 5 2>/dev/null | tr -d ' \r\n' || true)
    if is_ipv6 "$dp_ip"; then PUBLIC_IP6=$dp_ip; break; fi
  done
}

local_has_ip() { have hostname && hostname -I 2>/dev/null | tr ' ' '\n' | grep -qx "$1"; }

dns_query() {
  dq_type=$1; dq_name=$2
  if have dig; then
    if dq_out=$(dig +short +time=3 +tries=1 "$dq_type" "$dq_name" "@$ANLYON_DNS_RESOLVER" 2>/dev/null); then :
    else dq_out=$(dig +short +time=3 +tries=1 "$dq_type" "$dq_name" 2>/dev/null || true); fi
    printf '%s\n' "$dq_out" | sed 's/\.$//'
    return
  fi
  case "$dq_type" in
    A) have getent && getent ahostsv4 "$dq_name" 2>/dev/null | awk '{ print $1 }' | grep -v '^127\.' | sort -u ;;
    AAAA) have getent && getent ahostsv6 "$dq_name" 2>/dev/null | awk '{ print $1 }' | grep -v '^::1$' | grep ':' | sort -u ;;
    NS) have nslookup && nslookup -type=NS "$dq_name" 2>/dev/null | awk '/nameserver =/ { print $NF }' | sed 's/\.$//' ;;
  esac
  return 0
}

dns_a() { dns_query A "$1" | grep -E '^[0-9]+(\.[0-9]+){3}$' || true; }
dns_aaaa() { dns_query AAAA "$1" | grep ':' || true; }

dns_decide() {
  dd_a=$1; dd_ip=$2; dd_aaaa=${3:-}; dd_ip6=${4:-}
  [ -n "$dd_a" ] || { echo missing; return; }
  dd_self=0; dd_other=0; dd_all_cf=1
  for dd_r in $dd_a; do
    if [ -n "$dd_ip" ] && [ "$dd_r" = "$dd_ip" ]; then dd_self=1
    else dd_other=1; ipv4_in_cloudflare "$dd_r" || dd_all_cf=0; fi
  done
  if [ "$dd_self" -eq 1 ] && [ "$dd_other" -eq 0 ]; then
    if [ -n "$dd_aaaa" ]; then
      dd_aaaa_ok=0
      for dd_r in $dd_aaaa; do [ -n "$dd_ip6" ] && [ "$dd_r" = "$dd_ip6" ] && dd_aaaa_ok=1; done
      [ "$dd_aaaa_ok" -eq 1 ] || { echo aaaa; return; }
    fi
    echo ok
  elif [ "$dd_self" -eq 1 ]; then echo extra
  elif [ "$dd_all_cf" -eq 1 ]; then echo proxied
  elif [ -z "$dd_ip" ]; then echo unknown
  else echo mismatch
  fi
}

dns_zone() {
  DNS_ZONE=""; DNS_NS=""
  dz=$1
  while :; do
    case "$dz" in *.*) ;; *) break ;; esac
    dz_ns=$(dns_query NS "$dz" | grep -E '^[A-Za-z0-9.-]+$' || true)
    if [ -n "$dz_ns" ]; then DNS_ZONE=$dz; DNS_NS=$dz_ns; return 0; fi
    dz=${dz#*.}
  done
  DNS_ZONE=$(printf '%s' "$1" | awk -F. '{ if (NF >= 2) print $(NF-1) "." $NF; else print $0 }')
  return 0
}

dns_provider() {
  case "$(lower "$1")" in
    *ns.cloudflare.com*) echo cloudflare ;;
    *vercel-dns.com*) echo vercel ;;
    *registrar-servers.com*) echo namecheap ;;
    *domaincontrol.com*) echo godaddy ;;
    *porkbun.com*) echo porkbun ;;
    *squarespacedns.com*|*googledomains.com*) echo squarespace ;;
    *awsdns*) echo route53 ;;
    *digitalocean.com*) echo digitalocean ;;
    *dns-parking.com*|*hostinger*) echo hostinger ;;
    *gandi.net*) echo gandi ;;
    *) echo other ;;
  esac
}

provider_label() {
  case "$1" in
    cloudflare) echo Cloudflare ;; vercel) echo Vercel ;; namecheap) echo Namecheap ;;
    godaddy) echo GoDaddy ;; porkbun) echo Porkbun ;; squarespace) echo "Squarespace (formerly Google Domains)" ;;
    route53) echo "AWS Route 53" ;; digitalocean) echo DigitalOcean ;; hostinger) echo Hostinger ;;
    gandi) echo Gandi ;; *) echo "your DNS provider" ;;
  esac
}

provider_link() {
  case "$1" in
    cloudflare) echo "$LINK_DNS_CLOUDFLARE" ;; vercel) echo "$LINK_DNS_VERCEL" ;;
    namecheap) echo "$LINK_DNS_NAMECHEAP" ;; godaddy) echo "$LINK_DNS_GODADDY" ;;
    porkbun) echo "$LINK_DNS_PORKBUN" ;; squarespace) echo "$LINK_DNS_SQUARESPACE" ;;
    route53) echo "$LINK_DNS_ROUTE53" ;; digitalocean) echo "$LINK_DNS_DIGITALOCEAN" ;;
    hostinger) echo "$LINK_DNS_HOSTINGER" ;; gandi) echo "$LINK_DNS_GANDI" ;;
    *) echo "" ;;
  esac
}

dns_record_name() {
  if [ "$1" = "$2" ] || [ -z "$2" ]; then echo "@"; else printf '%s\n' "${1%."$2"}"; fi
}

dns_evaluate() {
  DNS_A=$(dns_a "$HOST")
  DNS_AAAA=$(dns_aaaa "$HOST")
  DNS_STATUS=$(dns_decide "$DNS_A" "$PUBLIC_IP4" "$DNS_AAAA" "$PUBLIC_IP6")
}

dns_record_box() {
  db_name=$1
  db_nw=${#db_name}; [ "$db_nw" -ge 4 ] || db_nw=4
  db_vw=${#PUBLIC_IP4}; [ "$db_vw" -ge 5 ] || db_vw=5
  [ "${#PUBLIC_IP6}" -le "$db_vw" ] || db_vw=${#PUBLIC_IP6}
  db_rows=$(printf '%-6s %-*s  %-*s  %s\n' Type "$db_nw" Name "$db_vw" Value TTL
    printf '%-6s %-*s  %-*s  %s\n' A "$db_nw" "$db_name" "$db_vw" "$PUBLIC_IP4" Auto
    [ -z "$PUBLIC_IP6" ] || printf '%-6s %-*s  %-*s  %s\n' AAAA "$db_nw" "$db_name" "$db_vw" "$PUBLIC_IP6" Auto)
  db_w=$(printf '%s\n' "$db_rows" | awk '{ if (length($0) > w) w = length($0) } END { print w + 2 }')
  if [ "$UI_UTF8" -eq 1 ]; then db_h='─'; db_v='│'; db_tl='┌'; db_tr='┐'; db_bl='└'; db_br='┘'
  else db_h='-'; db_v='|'; db_tl='+'; db_tr='+'; db_bl='+'; db_br='+'; fi
  db_line=""; db_i=0
  while [ "$db_i" -lt "$db_w" ]; do db_line="$db_line$db_h"; db_i=$((db_i + 1)); done
  printf '  %s%s%s%s%s\n' "$C_DIM" "$db_tl" "$db_line" "$db_tr" "$C_OFF"
  db_first=1
  printf '%s\n' "$db_rows" | while IFS= read -r db_row; do
    if [ "$db_first" -eq 1 ]; then db_cell="$C_DIM$(printf '%-*s' $((db_w - 2)) "$db_row")$C_OFF"; db_first=0
    else db_cell="$C_BOLD$(printf '%-*s' $((db_w - 2)) "$db_row")$C_OFF"; fi
    printf '  %s%s%s %s %s%s%s\n' "$C_DIM" "$db_v" "$C_OFF" "$db_cell" "$C_DIM" "$db_v" "$C_OFF"
  done
  printf '  %s%s%s%s%s\n' "$C_DIM" "$db_bl" "$db_line" "$db_br" "$C_OFF"
}

dns_instructions() {
  dns_zone "$HOST"
  DNS_PROVIDER=$(dns_provider "$DNS_NS")
  di_name=$(dns_record_name "$HOST" "$DNS_ZONE")
  di_label=$(provider_label "$DNS_PROVIDER")
  heading "Point $HOST at this server"
  case "$DNS_STATUS" in
    missing) note "$HOST has no address record yet." ;;
    proxied) note "$HOST answers with Cloudflare's addresses: its record is proxied (orange cloud)." ;;
    extra) note "$HOST points at this server and also at $(dns_join "$DNS_A")." ;;
    aaaa) note "$HOST has an IPv6 (AAAA) record for another server: $(dns_join "$DNS_AAAA")." ;;
    *) note "$HOST points at $(dns_join "$DNS_A"); this server is $PUBLIC_IP4." ;;
  esac
  note "Create or change this record at $di_label${DNS_ZONE:+, in the zone $DNS_ZONE}:"
  say ""
  dns_record_box "$di_name"
  say ""
  [ -z "$PUBLIC_IP6" ] || dim "The AAAA record is optional, for IPv6."
  [ "$DNS_STATUS" = extra ] && note "Remove the other A records for $di_name, so only this server answers."
  [ "$DNS_STATUS" = aaaa ] && note "Remove the AAAA record for $di_name${PUBLIC_IP6:+, or set it to $PUBLIC_IP6}: certificate checks try IPv6 first."
  if [ "$DNS_PROVIDER" = cloudflare ]; then
    note "Cloudflare: set Proxy status to \"DNS only\" (grey cloud), not Proxied (orange cloud)."
    if [ "$DNS_STATUS" = proxied ]; then
      note "Behind the proxy, this server cannot get its own certificate the way the installer sets it up:"
      note "click the orange cloud next to the record so it turns grey (DNS only), then save."
    fi
    note "Proxy status: $LINK_CLOUDFLARE_PROXY"
  fi
  di_link=$(provider_link "$DNS_PROVIDER")
  if [ -n "$di_link" ]; then
    note "How to add a record at $di_label: $di_link"
  else
    note "In your DNS provider's panel, open the DNS records (or zone editor) for ${DNS_ZONE:-the domain},"
    note "add an A record with the name and value above, and save. The nameservers are: $(dns_join "${DNS_NS:-unknown}")."
  fi
  dim "Changes usually show within minutes; some providers take longer."
}

dns_wait() {
  dw_end=$(( $(now) + ANLYON_DNS_WAIT ))
  dw_i=0
  if [ "$UI_FANCY" -ne 1 ]; then
    note "Waiting for DNS, checking every ${ANLYON_DNS_INTERVAL}s. Enter: check now. s: use the IP instead. q: quit."
  fi
  while :; do
    dns_evaluate
    if [ "$DNS_STATUS" = ok ]; then
      printf '%s' "$C_CLR" >&2
      ok_line "$HOST now points at this server."
      return 0
    fi
    if [ "$(now)" -ge "$dw_end" ]; then
      printf '%s' "$C_CLR" >&2
      warn "$HOST still does not point here after $(fmt_elapsed "$ANLYON_DNS_WAIT")."
      return 1
    fi
    dw_t=0
    while [ "$dw_t" -lt "$ANLYON_DNS_INTERVAL" ]; do
      if [ "$UI_FANCY" -eq 1 ]; then
        spin_frame "$dw_i"; dw_i=$((dw_i + 1))
        dw_left=$(( dw_end - $(now) )); [ "$dw_left" -ge 0 ] || dw_left=0
        printf '%s  %s%s%s Waiting for DNS  %s%d:%02d left  %s  Enter checks now  %s  s uses the IP  %s  q quits%s ' \
          "$C_CLR" "$C_DIM" "$FRAME" "$C_OFF" "$C_DIM" $((dw_left / 60)) $((dw_left % 60)) \
          "$SYM_DOT" "$SYM_DOT" "$SYM_DOT" "$C_OFF" >&2
      fi
      read_key
      case "$KEY" in
        enter) break ;;
        s|S) printf '%s' "$C_CLR" >&2; return 2 ;;
        q|Q) printf '%s' "$C_CLR" >&2; return 3 ;;
      esac
      dw_t=$((dw_t + 1))
      [ "$(now)" -lt "$dw_end" ] || break
    done
  done
}

use_ip_instead() {
  [ -n "$PUBLIC_IP4" ] || die "No public IP address to fall back to; pass --public-ip."
  dn_old=$HOST
  address_for "$PUBLIC_IP4"
  say "Continuing on $PUBLIC_URL over plain HTTP."
  note "To move to $dn_old later: point it here, then in $ANLYON_DIR/.env set"
  note "ANLYON_PUBLIC_URL=https://$dn_old, SITE_ADDRESS=$dn_old, ANLYON_PORT=80, ANLYON_HTTPS_PORT=443,"
  note "and run: cd $ANLYON_DIR && docker compose up -d"
  for ui_p in $HTTP_PORT $HTTPS_PORT; do
    ui_rc=0; port_in_use "$ui_p" || ui_rc=$?
    [ "$ui_rc" -ne 0 ] || die "Port $ui_p is in use; the IP address install needs $HTTP_PORT and $HTTPS_PORT."
  done
}

dns_guide() {
  dns_instructions
  if [ "$HAVE_TTY" -ne 1 ] || [ "$ASSUME_YES" -eq 1 ]; then
    if [ "$ALLOW_IP_FALLBACK" -eq 1 ]; then use_ip_instead; return 0; fi
    die "DNS for $HOST is not ready. Create the record above and re-run, or pass --allow-ip-fallback."
  fi
  if [ "$DNS_PROVIDER" = cloudflare ]; then cloudflare_offer || true; fi
  dg_rc=0; dns_wait || dg_rc=$?
  case "$dg_rc" in
    0) return 0 ;;
    2) use_ip_instead ;;
    3) say "Nothing was changed. Re-run the installer once $HOST points at $PUBLIC_IP4."; exit 0 ;;
    *)
      if ask "Continue on ${PUBLIC_IP4:-the IP address} over plain HTTP instead?" n; then use_ip_instead
      else say "Nothing was changed. Re-run the installer once $HOST points at $PUBLIC_IP4."; exit 0; fi ;;
  esac
}

cf_api() {
  cf_tok=$1; cf_method=$2; cf_path=$3; cf_body=${4:-}
  if [ -n "$cf_body" ]; then
    printf 'header = "Authorization: Bearer %s"\n' "$cf_tok" |
      curl --config - -sS --max-time 15 -X "$cf_method" -H 'Content-Type: application/json' --data "$cf_body" "$ANLYON_CF_API$cf_path"
  else
    printf 'header = "Authorization: Bearer %s"\n' "$cf_tok" |
      curl --config - -sS --max-time 15 -X "$cf_method" "$ANLYON_CF_API$cf_path"
  fi
}
json_ok() { printf '%s' "$1" | tr -d '\n ' | grep -q '"success":true'; }
json_ids() { printf '%s' "$1" | tr -d '\n' | grep -o '"id" *: *"[0-9a-f]\{32\}"' | sed 's/.*"\([0-9a-f]\{32\}\)"/\1/'; }
json_message() { printf '%s' "$1" | tr -d '\n' | grep -o '"message" *: *"[^"]*"' | head -n 1 | sed 's/.*: *"\(.*\)"/\1/'; }

cloudflare_upsert_a() {
  cu_tok=$1; cu_zone=$2; cu_name=$3; cu_ip=$4
  cu_json=$(cf_api "$cu_tok" GET "/zones?name=$cu_zone" || true)
  if ! json_ok "$cu_json"; then warn "Cloudflare refused the token: $(json_message "$cu_json")"; return 1; fi
  cu_zone_id=$(json_ids "$cu_json" | head -n 1)
  [ -n "$cu_zone_id" ] || { warn "The token cannot see the zone $cu_zone."; return 1; }
  cu_json=$(cf_api "$cu_tok" GET "/zones/$cu_zone_id/dns_records?type=A&name=$cu_name" || true)
  if ! json_ok "$cu_json"; then warn "Could not read the zone's records: $(json_message "$cu_json")"; return 1; fi
  cu_ids=$(json_ids "$cu_json")
  cu_body=$(printf '{"type":"A","name":"%s","content":"%s","ttl":1,"proxied":false,"comment":"Anlyon self-hosted"}' "$cu_name" "$cu_ip")
  cu_first=$(printf '%s\n' "$cu_ids" | head -n 1)
  if [ -n "$cu_first" ]; then
    cu_json=$(cf_api "$cu_tok" PUT "/zones/$cu_zone_id/dns_records/$cu_first" "$cu_body" || true)
  else
    cu_json=$(cf_api "$cu_tok" POST "/zones/$cu_zone_id/dns_records" "$cu_body" || true)
  fi
  if ! json_ok "$cu_json"; then warn "Cloudflare did not save the record: $(json_message "$cu_json")"; return 1; fi
  ok_line "Saved: A $cu_name -> $cu_ip, DNS only."
  if [ "$(printf '%s\n' "$cu_ids" | grep -c .)" -gt 1 ]; then
    warn "$cu_name has other A records too; delete them in the Cloudflare dashboard."
  fi
  return 0
}

cloudflare_offer() {
  say ""
  dim "Anlyon can create the record for you. The token is used for this one change and never stored."
  ask "Create the record with a Cloudflare API token?" n || return 1
  dim "Create a token at dash.cloudflare.com (My Profile, API Tokens) from the \"Edit zone DNS\" template,"
  dim "limited to the zone $DNS_ZONE: $LINK_CLOUDFLARE_TOKEN"
  printf '%s?%s Paste the token (hidden): ' "$C_BOLD" "$C_OFF" >&2
  co_saved=""
  if [ -t 3 ]; then co_saved=$(stty -g <&3 2>/dev/null || true); stty -echo <&3 2>/dev/null || true; fi
  co_token=""
  IFS= read -r co_token <&3 || co_token=""
  [ -n "$co_saved" ] && stty "$co_saved" <&3 2>/dev/null
  printf '\n' >&2
  co_token=$(printf '%s' "$co_token" | tr -d ' \r')
  [ -n "$co_token" ] || { co_token=""; return 1; }
  co_rc=0
  cloudflare_upsert_a "$co_token" "$DNS_ZONE" "$HOST" "$PUBLIC_IP4" || co_rc=$?
  co_token=""
  return "$co_rc"
}

apt_install() { DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"; }

install_tools() {
  apt-get update -qq
  # shellcheck disable=SC2086
  apt_install ca-certificates $TOOLS_MISSING
}

change_tools() {
  pf_has_fix tools || return 0
  ask "Install$TOOLS_MISSING with apt-get?" y || die "Needed:$TOOLS_MISSING. Nothing else was changed."
  step "Installing$TOOLS_MISSING|Installed$TOOLS_MISSING" apt install_tools
}

install_docker_apt() {
  apt-get update -qq
  apt_install ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$OS_ID/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/$OS_ID
Suites: $OS_CODENAME
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  apt-get update -qq
  apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
}

install_docker_script() {
  ids_tmp=$(mktemp)
  curl -fsSL "$LINK_DOCKER_SCRIPT" -o "$ids_tmp"
  sh "$ids_tmp"
  rm -f "$ids_tmp"
}

change_docker() {
  if pf_has_fix docker-start; then
    ask "Start the Docker engine now and at boot (systemctl enable --now docker)?" y || die "Docker must be running."
    step "Starting Docker|Docker started" - systemctl enable --now docker
    return 0
  fi
  pf_has_fix docker || return 0
  [ "$NO_DOCKER_INSTALL" -eq 0 ] || die "Docker Engine ${MIN_ENGINE%.0}+ with Compose $MIN_COMPOSE+ is needed, and --no-docker-install was given."
  cd_method=$DOCKER_METHOD
  case "$OS_ID" in ubuntu|debian) ;; *) cd_method=script ;; esac
  if have dpkg && dpkg -s docker.io >/dev/null 2>&1; then
    die "Docker came from the distribution's docker.io package, which conflicts with Docker's own. Remove it first (apt-get remove docker.io docker-compose docker-compose-v2 docker-buildx podman-docker) and re-run; nothing was changed."
  fi
  if [ "$cd_method" = apt ]; then
    dim "From Docker's own apt repository (download.docker.com), as its documentation describes."
    ask "Install Docker Engine and the Compose plugin?" n || die "Docker is needed; nothing else was changed."
    step "Installing Docker Engine|Installed Docker Engine" apt install_docker_apt
  else
    dim "With Docker's convenience script ($LINK_DOCKER_SCRIPT)."
    ask "Download and run it?" n || die "Docker is needed; nothing else was changed."
    step "Installing Docker Engine|Installed Docker Engine" apt install_docker_script
  fi
  systemctl enable --now docker >/dev/null 2>&1 || true
  docker compose version >/dev/null 2>&1 || die "Docker was installed, but 'docker compose' does not work."
}

add_swap() {
  fallocate -l "${SWAP_ADD_GB}G" "$ANLYON_SWAPFILE" 2>/dev/null ||
    dd if=/dev/zero of="$ANLYON_SWAPFILE" bs=1M count=$((SWAP_ADD_GB * 1024)) status=none
  chmod 600 "$ANLYON_SWAPFILE"
  mkswap "$ANLYON_SWAPFILE" >/dev/null
  swapon "$ANLYON_SWAPFILE"
  grep -q "^$ANLYON_SWAPFILE " "$ANLYON_FSTAB" 2>/dev/null || printf '%s none swap sw 0 0\n' "$ANLYON_SWAPFILE" >> "$ANLYON_FSTAB"
}

change_swap() {
  pf_has_fix swap || return 0
  [ "$NO_SWAP" -eq 0 ] || { warn "Below 4 GB of memory and no swap added (--no-swap): builds may run out of memory."; return 0; }
  if [ -e "$ANLYON_SWAPFILE" ]; then warn "$ANLYON_SWAPFILE already exists; not adding swap."; return 0; fi
  dim "Below 4 GB of memory, building the images needs swap. It stays after a reboot (a line in $ANLYON_FSTAB)."
  ask "Add a ${SWAP_ADD_GB} GB swap file at $ANLYON_SWAPFILE?" n || return 0
  step "Adding a ${SWAP_ADD_GB} GB swap file|Added a ${SWAP_ADD_GB} GB swap file at $ANLYON_SWAPFILE" - add_swap
}

allow_ports() {
  ufw allow "$HTTP_PORT/tcp" comment 'Anlyon'
  ufw allow "$HTTPS_PORT/tcp" comment 'Anlyon'
}

change_firewall() {
  [ "$NO_FIREWALL" -eq 0 ] || return 0
  have ufw || return 0
  ufw status 2>/dev/null | head -n 1 | grep -q 'Status: active' || return 0
  dim "ufw is on. Only these two ports change; SSH and every other rule stay as they are."
  ask "Allow TCP $HTTP_PORT and $HTTPS_PORT in ufw?" n || return 0
  step "Allowing TCP $HTTP_PORT and $HTTPS_PORT in ufw|Allowed TCP $HTTP_PORT and $HTTPS_PORT in ufw" - allow_ports
}

change_dir() {
  if [ -d "$ANLYON_DIR" ]; then return 0; fi
  ask "Create $ANLYON_DIR for the install?" y || die "Nothing was changed."
  mkdir -p "$ANLYON_DIR"
  chmod 750 "$ANLYON_DIR"
  log_settle
  ok_line "Created $ANLYON_DIR"
}

change_docker_group() {
  cg_user=${SUDO_USER:-}
  { [ -n "$cg_user" ] && [ "$cg_user" != root ]; } || return 0
  id -nG "$cg_user" 2>/dev/null | tr ' ' '\n' | grep -qx docker && return 0
  if [ "$ASSUME_YES" -eq 1 ] && [ "$ADD_DOCKER_GROUP" -ne 1 ]; then return 0; fi
  dim "The docker group lets $cg_user run docker without sudo. That is the same as root on this server:"
  dim "anyone in the group can mount the whole disk in a container."
  if [ "$ADD_DOCKER_GROUP" -eq 1 ] || ask "Add $cg_user to the docker group anyway?" n; then
    usermod -aG docker "$cg_user"
    ok_line "Added $cg_user to the docker group (from $cg_user's next login)"
  fi
}

change_cli() {
  [ "$NO_CLI" -eq 0 ] || return 0
  cc_target="$ANLYON_BIN_DIR/anlyon-selfhost"
  dim "anlyon-selfhost runs this install: status, logs, upgrade, backup, restore, uninstall."
  ask "Install it as $cc_target?" y || return 0
  mkdir -p "$ANLYON_BIN_DIR"
  cp "$ANLYON_DIR/bootstrap.sh" "$cc_target.tmp"
  chmod 755 "$cc_target.tmp"
  mv -f "$cc_target.tmp" "$cc_target"
  ok_line "Installed $cc_target"
}

stage_source() {
  SRC_ROOT=""; SRC_SHA=""
  if [ -n "$FROM_DIR" ]; then
    if [ -f "$FROM_DIR/deploy/self-host/docker-compose.yml" ]; then
      SRC_ROOT=$FROM_DIR; STAGE="$FROM_DIR/deploy/self-host"
    elif [ -f "$FROM_DIR/docker-compose.yml" ] && [ -f "$FROM_DIR/Caddyfile" ]; then
      STAGE=$FROM_DIR
      [ "$IMAGES" = ghcr ] || die "--from-dir $FROM_DIR is only the install files; building the images needs the repository's root."
    else
      die "--from-dir $FROM_DIR has no deploy/self-host/docker-compose.yml."
    fi
    if [ -n "$SRC_ROOT" ]; then
      SRC_SHA=$(git -C "$SRC_ROOT" rev-parse --short=12 HEAD 2>/dev/null || true)
    fi
  elif [ "$IMAGES" = build ] || [ -n "$SOURCE" ]; then
    step "Fetching $REF from $GIT_URL|Fetched $REF from $GIT_URL" - git_checkout "$GIT_URL" "$REF" "$ANLYON_DIR/src"
    SRC_ROOT="$ANLYON_DIR/src"; STAGE="$SRC_ROOT/deploy/self-host"
    SRC_SHA=$(git -C "$SRC_ROOT" rev-parse --short=12 HEAD)
  else
    STAGE="$ANLYON_DIR/.staging"
    step "Downloading the install files|Downloaded the install files ($REPO@$REF)" - download_files "$STAGE"
  fi
  for ss_f in $INSTALL_FILES; do
    [ -f "$STAGE/$ss_f" ] || die "$STAGE has no $ss_f; that ref is older than this installer."
  done
  [ -n "$SRC_SHA" ] || SRC_SHA=$(date -u +%Y%m%d%H%M%S)
}

download_files() {
  rm -rf "$1"; mkdir -p "$1"
  for df_f in $INSTALL_FILES; do
    say "Downloading $df_f ($REPO@$REF)"
    http_get "$ANLYON_RAW_BASE/$REPO/$REF/deploy/self-host/$df_f" -o "$1/$df_f" ||
      die "Could not download $df_f from $REPO at $REF. A private repository needs GITHUB_TOKEN."
  done
}

git_checkout() {
  gc_url=$1; gc_ref=$2; gc_dir=$3
  if [ ! -d "$gc_dir/.git" ]; then
    rm -rf "$gc_dir"
    git init -q "$gc_dir"
    git -C "$gc_dir" remote add origin "$gc_url"
  else
    git -C "$gc_dir" remote set-url origin "$gc_url"
  fi
  case "$gc_url" in
    https://github.com/*)
      if [ -n "${GITHUB_TOKEN:-}" ]; then
        gc_auth=$(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 | tr -d '\n')
        GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.https://github.com/.extraheader \
          GIT_CONFIG_VALUE_0="Authorization: Basic $gc_auth" \
          git -C "$gc_dir" fetch -q --depth 1 origin "$gc_ref" ||
          die "Could not fetch $gc_ref from $gc_url."
        gc_auth=""
        git -C "$gc_dir" checkout -q --detach FETCH_HEAD
        return 0
      fi ;;
  esac
  git -C "$gc_dir" fetch -q --depth 1 origin "$gc_ref" ||
    die "Could not fetch $gc_ref from $gc_url. A private repository needs GITHUB_TOKEN."
  git -C "$gc_dir" checkout -q --detach FETCH_HEAD
}

install_files() {
  for if_f in $INSTALL_FILES; do
    cp "$STAGE/$if_f" "$ANLYON_DIR/$if_f.tmp"
    case "$if_f" in *.sh) chmod 755 "$ANLYON_DIR/$if_f.tmp" ;; *) chmod 644 "$ANLYON_DIR/$if_f.tmp" ;; esac
    mv -f "$ANLYON_DIR/$if_f.tmp" "$ANLYON_DIR/$if_f"
  done
  rm -rf "$ANLYON_DIR/.staging"
  ok_line "Copied the install files to $ANLYON_DIR"
}

target_images() {
  if [ "$IMAGES" = ghcr ]; then
    SERVER_IMAGE="$ANLYON_REGISTRY/anlyon-server:$VERSION"
    DASHBOARD_IMAGE="$ANLYON_REGISTRY/anlyon-dashboard:$VERSION"
  else
    SERVER_IMAGE="anlyon-server:src-$SRC_SHA"
    DASHBOARD_IMAGE="anlyon-dashboard:src-$SRC_SHA"
  fi
}

write_override() {
  wo_file="$ANLYON_DIR/$OVERRIDE_NAME"
  {
    printf '# Written by anlyon-selfhost; replaced on every upgrade. Do not edit.\n'
    printf '# Images: %s. Change them with: anlyon-selfhost upgrade\n' "$IMAGES"
    printf 'services:\n'
    printf '  server:\n    image: %s\n' "$SERVER_IMAGE"
    if [ "$IMAGES" = build ]; then
      printf '    build:\n      context: %s\n      args:\n        BUILD_SHA: "%s"\n' "$SRC_ROOT" "$SRC_SHA"
    fi
    printf '  dashboard:\n    image: %s\n' "$DASHBOARD_IMAGE"
    if [ "$IMAGES" = build ]; then
      printf '    build:\n      context: %s\n' "$SRC_ROOT"
    fi
  } > "$wo_file.tmp"
  mv -f "$wo_file.tmp" "$wo_file"
}

write_state() {
  ws_file=$(state_file)
  ws_installed=$(state_get INSTALLED_AT 2>/dev/null || true)
  [ -n "$ws_installed" ] || ws_installed=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  {
    printf '# anlyon-selfhost state. Read by anlyon-selfhost; no secrets here.\n'
    printf 'IMAGES=%s\nVERSION=%s\nREPO=%s\nREF=%s\nSOURCE=%s\nFROM_DIR=%s\nSRC_ROOT=%s\nSRC_SHA=%s\n' \
      "$IMAGES" "$VERSION" "$REPO" "$REF" "$SOURCE" "$FROM_DIR" "$SRC_ROOT" "$SRC_SHA"
    printf 'SERVER_IMAGE=%s\nDASHBOARD_IMAGE=%s\n' "$SERVER_IMAGE" "$DASHBOARD_IMAGE"
    printf 'PREVIOUS_SERVER_IMAGE=%s\nPREVIOUS_DASHBOARD_IMAGE=%s\n' "${PREVIOUS_SERVER_IMAGE:-}" "${PREVIOUS_DASHBOARD_IMAGE:-}"
    printf 'INSTALLED_AT=%s\nUPDATED_AT=%s\n' "$ws_installed" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    ws_completed=$(state_get COMPLETED_AT 2>/dev/null || true)
    [ -z "$ws_completed" ] || printf 'COMPLETED_AT=%s\n' "$ws_completed"
  } > "$ws_file.tmp"
  chmod 600 "$ws_file.tmp"
  mv -f "$ws_file.tmp" "$ws_file"
}

write_env_file() {
  ANLYON_UI=plain sh "$ANLYON_DIR/install.sh" --domain "$DOMAIN" --edition "$EDITION" --yes --write-only --allow-http
  chmod 600 "$ANLYON_DIR/.env"
}

write_env() {
  if [ -e "$ANLYON_DIR/.env" ]; then
    ok_line "Kept $ANLYON_DIR/.env (it holds this install's root key)"
    return 0
  fi
  step "Writing .env with new secrets|Wrote $ANLYON_DIR/.env with new secrets (owner-only)" - write_env_file
}

get_images() {
  if [ "$IMAGES" = ghcr ]; then
    step "Pulling images|Pulled $VERSION images" pull compose pull --quiet
    if ! docker image inspect "$SERVER_IMAGE" >/dev/null 2>&1 || ! docker image inspect "$DASHBOARD_IMAGE" >/dev/null 2>&1; then
      die "Could not pull the images for $VERSION. Check that the release exists, or use --images build."
    fi
  else
    dim "The first build takes several minutes; a small server takes longer."
    step "Building images|Built the images (src-$SRC_SHA)" build compose build server dashboard
  fi
}

compose_up() { step "Starting containers|Containers started" up compose up -d --no-build --remove-orphans; }

server_ready() {
  compose exec -T server wget -q -O /dev/null --header='X-Forwarded-Proto: https' http://127.0.0.1:4000/health/ready >/dev/null 2>&1
}

ready_loop() {
  rl_end=$(( $(now) + $1 ))
  while :; do
    if server_ready; then return 0; fi
    [ "$(now)" -lt "$rl_end" ] || return 1
    sleep "$ANLYON_POLL"
  done
}

wait_ready() {
  step "Waiting for the server|Server ready|Server not ready after $(fmt_elapsed "$1")" \
    "a first start runs the migrations" ready_loop "$1"
}

show_output() { tee -a "${LOG_FILE:-/dev/null}" | sed "s/^/    $C_DIM$SYM_BAR$C_OFF /"; }

explain_not_ready() {
  warn "The server did not report ready. The last 50 lines of its log:"
  { compose ps; compose logs --no-color --tail 50 server; } 2>&1 | show_output || true
  say ""
  note "Common causes: the database is still starting (wait, then: anlyon-selfhost status),"
  note "too little memory during migrations, or a value in $ANLYON_DIR/.env."
  note "Full logs: anlyon-selfhost logs server"
}

cert_loop() {
  cl_end=$(( $(now) + ANLYON_CERT_WAIT ))
  while :; do
    if curl -fsS -o /dev/null --max-time 10 --resolve "$HOST:$HTTPS_PORT:127.0.0.1" "$PUBLIC_URL/health" 2>/dev/null; then
      return 0
    fi
    [ "$(now)" -lt "$cl_end" ] || return 1
    sleep "$ANLYON_POLL"
  done
}

check_certificate() {
  [ "$IS_HOSTNAME" -eq 1 ] || return 0
  STEP_SOFT=1
  if step "Getting the HTTPS certificate|HTTPS works for $HOST|No HTTPS certificate for $HOST yet" \
    "asking Let's Encrypt" cert_loop; then STEP_SOFT=0; return 0; fi
  STEP_SOFT=0
  dim "Recent proxy log:"
  compose logs --no-color --tail 20 caddy 2>&1 | show_output || true
  firewall_reminder
  return 1
}

firewall_reminder() {
  say ""
  note "Let's Encrypt must reach this server on TCP $HTTP_PORT and $HTTPS_PORT from the internet."
  note "Besides this server's own firewall, most providers put one in front of it:"
  note "  Hetzner Cloud          $LINK_FW_HETZNER"
  note "  DigitalOcean           $LINK_FW_DIGITALOCEAN"
  note "  AWS (security groups)  $LINK_FW_AWS"
  note "  Elsewhere, look for \"firewall\" or \"security group\" in the provider's panel and allow"
  note "  TCP $HTTP_PORT and $HTTPS_PORT inbound."
  dim "Caddy keeps retrying; once the ports are open the certificate arrives without a restart."
}

print_finish() {
  fi_url=$(env_get ANLYON_PUBLIC_URL "$ANLYON_DIR/.env")
  fi_token=$(env_get ANLYON_SETUP_TOKEN "$ANLYON_DIR/.env")
  if [ -x "$ANLYON_BIN_DIR/anlyon-selfhost" ]; then fi_cmd="anlyon-selfhost"
  else fi_cmd="sh $ANLYON_DIR/bootstrap.sh"; fi
  log_settle
  printf '\n%s%s%s %sAnlyon is ready.%s\n\n' "$C_OK" "$SYM_OK" "$C_OFF" "$C_BOLD" "$C_OFF"
  note "Open this URL to create the first owner. It works once."
  say ""
  say "    $C_BOLD$fi_url/setup#token=$fi_token$C_OFF"
  say ""
  note "Root key  ANLYON_ROOT_KEY in $ANLYON_DIR/.env, readable by root only. Copy it to a"
  note "          password manager, somewhere other than this server. Without it, stored secrets"
  note "          and connected accounts cannot be read, and nobody can recover them. To see it:"
  note "          sudo grep ANLYON_ROOT_KEY $ANLYON_DIR/.env"
  note "Next      $fi_cmd status    ${C_DIM}(also logs, upgrade, backup, restore, uninstall)$C_OFF"
  note "Telemetry ${C_DIM}Once setup is done: a random install id, the version and edition, and daily counts$C_OFF"
  note "          ${C_DIM}(workspaces, members, actions, calls, approvals). No names, no content.$C_OFF"
  note "          ${C_DIM}Off in the console, or with ANLYON_TELEMETRY=off in $ANLYON_DIR/.env$C_OFF"
  [ -z "$LOG_FILE" ] || note "Log       $C_DIM$LOG_FILE$C_OFF"
}

confirm_plain_http() {
  is_ipv4 "$HOST" || return 0
  case "$HOST" in 127.*|10.*|192.168.*|169.254.*) return 0 ;; 172.*)
    cph_second=${HOST#172.}; cph_second=${cph_second%%.*}
    if [ "$cph_second" -ge 16 ] && [ "$cph_second" -le 31 ]; then return 0; fi ;;
  esac
  [ "$ALLOW_HTTP" -eq 1 ] && return 0
  if [ "$ASSUME_YES" -eq 1 ] || [ "$HAVE_TTY" -ne 1 ]; then
    die "$PUBLIC_URL would serve a public address over plain HTTP: sign-ins, API keys and the setup token would cross the internet unencrypted. Use --domain <host name>, or pass --allow-http to accept that."
  fi
  ask "Serve $HOST over plain HTTP? Sign-ins, API keys and the setup token will cross the internet unencrypted" n ||
    die "Stopped. Use --domain <host name> for a certificate, or --allow-http to accept plain HTTP."
}

choose_domain() {
  if [ -z "$DOMAIN" ]; then
    detect_public_ip
    if [ "$HAVE_TTY" -eq 1 ] && [ "$ASSUME_YES" -ne 1 ]; then
      prompt "Domain for this install, such as anlyon.example.com  ${C_DIM}Enter: localhost over plain HTTP, this machine only$C_OFF  "
      DOMAIN=$REPLY
    fi
    if [ -z "$DOMAIN" ]; then
      [ "$ASSUME_YES" -eq 1 ] && [ "$HAVE_TTY" -ne 1 ] && die "Pass --domain <host name> (or --domain localhost for this machine only)."
      DOMAIN=localhost
    fi
  fi
  address_for "$DOMAIN"
  confirm_plain_http
  if [ "$IS_HOSTNAME" -eq 1 ] && [ -z "${PUBLIC_IP4+set}" ]; then detect_public_ip; fi
  : "${PUBLIC_IP4:=}"; : "${PUBLIC_IP6:=}"
}

cmd_preflight() {
  resolve_source
  ui_header "Checks this server only; nothing is changed."
  choose_domain
  run_preflight
  say ""
  if [ "$PF_FATAL" -gt 0 ] || [ "$PF_FAILS" -gt 0 ]; then
    result_line fail "$PF_FAILS check(s) failed$( [ "$PF_FATAL" -gt 0 ] && printf ', %s cannot be worked around' "$PF_FATAL")."
    return 1
  fi
  ok_line "Ready to install at $PUBLIC_URL."
}

cmd_install() {
  if is_installed; then
    say "Anlyon is already installed at $ANLYON_DIR. The installer never replaces an install or its .env."
    if [ "$UPGRADE" -eq 1 ]; then cmd_upgrade; return; fi
    if [ "$ASSUME_YES" -ne 1 ] && [ "$HAVE_TTY" -eq 1 ] && ask "Upgrade it instead?" n; then cmd_upgrade; return; fi
    say "Nothing was changed. To upgrade: anlyon-selfhost upgrade (or re-run with --upgrade)."
    return 0
  fi
  if is_partial; then
    resolve_source
    ui_header
    say ""
    warn_line "A previous install at $ANLYON_DIR did not finish (no healthy start was recorded)."
    dim "Resuming keeps its .env and root key, builds or pulls the images, and starts it again."
    ask "Resume that install?" y || die "Nothing was changed. Re-run to resume, or remove $ANLYON_DIR to start over."
    choose_domain
    run_preflight || true
    heading "Changes to this server" "each one is asked first"
    change_tools
    change_docker
    change_swap
    heading "Resume"
    stage_source
    install_files
    write_env
    target_images
    PREVIOUS_SERVER_IMAGE=""; PREVIOUS_DASHBOARD_IMAGE=""
    write_override
    write_state
    change_cli
    get_images
    compose_up
    if ! wait_ready "$READY_TIMEOUT"; then explain_not_ready; exit 1; fi
    mark_complete
    check_certificate || true
    offer_backup_schedule
    print_finish
    return 0
  fi
  resolve_source
  ui_header
  choose_domain
  run_preflight
  if [ "$PF_FATAL" -gt 0 ]; then die "This server cannot run Anlyon (see above). Nothing was changed."; fi
  if [ "$PF_FAILS" -gt 0 ]; then
    if [ "$IGNORE_PREFLIGHT" -eq 1 ]; then warn "Continuing past $PF_FAILS failed check(s) (--ignore-preflight)."
    elif [ "$ASSUME_YES" -eq 1 ] || [ "$HAVE_TTY" -ne 1 ]; then die "$PF_FAILS check(s) failed. Fix them, or pass --ignore-preflight. Nothing was changed."
    elif ! ask "$PF_FAILS check(s) failed. Continue anyway?" n; then die "Nothing was changed."; fi
  fi
  if pf_has_fix dns; then dns_guide; fi

  heading "Changes to this server" "each one is asked first"
  change_tools
  change_docker
  change_swap
  change_firewall
  change_dir
  change_docker_group

  heading "Install"
  dim "Writes the install files and a .env with new secrets (owner-only) to $ANLYON_DIR,"
  if [ "$IMAGES" = build ]; then dim "builds the images from $REPO@$REF${FROM_DIR:+ ($FROM_DIR)} and starts five containers."
  else dim "pulls the $VERSION images from $ANLYON_REGISTRY and starts five containers."; fi
  ask "Install Anlyon and start it?" y || die "Stopped before installing. The changes above stay; re-run to continue."
  stage_source
  install_files
  write_env
  target_images
  PREVIOUS_SERVER_IMAGE=""; PREVIOUS_DASHBOARD_IMAGE=""
  write_override
  write_state
  change_cli
  get_images
  compose_up
  if ! wait_ready "$READY_TIMEOUT"; then explain_not_ready; exit 1; fi
  mark_complete
  check_certificate || true
  offer_backup_schedule
  print_finish
}

require_installed() {
  if [ ! -f "$ANLYON_DIR/docker-compose.yml" ] || [ ! -f "$ANLYON_DIR/.env" ]; then
    die "No install at $ANLYON_DIR (pass --dir, or install first)."
  fi
}

snapshot_for_rollback() {
  rb="$ANLYON_DIR/.rollback"
  rm -rf "$rb"; mkdir -p "$rb"; chmod 700 "$rb"
  for sr_f in docker-compose.yml Caddyfile "$OVERRIDE_NAME" "$STATE_NAME"; do
    [ -f "$ANLYON_DIR/$sr_f" ] && cp -p "$ANLYON_DIR/$sr_f" "$rb/$sr_f"
  done
  return 0
}

rollback() {
  rb="$ANLYON_DIR/.rollback"
  for rb_f in docker-compose.yml Caddyfile "$OVERRIDE_NAME" "$STATE_NAME"; do
    [ -f "$rb/$rb_f" ] && cp -p "$rb/$rb_f" "$ANLYON_DIR/$rb_f"
  done
  return 0
}

cmd_upgrade() {
  require_installed
  if [ -z "$FROM_DIR" ] && [ -z "$VERSION" ] && [ -z "$REF" ] && [ -z "$SOURCE" ] && [ -z "$REPO" ]; then
    FROM_DIR=$(state_get FROM_DIR)
  fi
  [ -n "$IMAGES" ] || IMAGES=$(state_get IMAGES)
  [ -n "$REPO" ] || REPO=$(state_get REPO)
  [ -n "$SOURCE" ] || SOURCE=$(state_get SOURCE)
  if [ -z "$REF" ] && [ -z "$VERSION" ]; then REF=$(state_get REF); fi
  resolve_source

  PREVIOUS_SERVER_IMAGE=$(state_get SERVER_IMAGE || true)
  PREVIOUS_DASHBOARD_IMAGE=$(state_get DASHBOARD_IMAGE || true)
  ui_header "Upgrade backs up first, and goes back to the running version if the new one does not start."
  heading "Upgrade"
  note "From  ${PREVIOUS_SERVER_IMAGE:-unknown}"
  if [ "$IMAGES" = ghcr ]; then note "To    $VERSION ($ANLYON_REGISTRY)"
  else note "To    $REPO@$REF${FROM_DIR:+ ($FROM_DIR)}, built here"; fi
  ask "Back up, then upgrade?" y || { say "Nothing was changed."; return 0; }

  heading "Backup first"
  do_backup
  UPGRADE_BACKUP=$BACKUP_FILE

  snapshot_for_rollback
  stage_source
  install_files
  target_images
  write_override
  write_state
  if [ "$IMAGES" = build ]; then
    dim "Building from $SRC_ROOT ($SRC_SHA)."
    if ! step "Building images|Built the images (src-$SRC_SHA)" build compose build server dashboard; then
      rollback; die "The build failed; nothing is running differently. Backup: $UPGRADE_BACKUP"
    fi
  else
    if ! step "Pulling images|Pulled $VERSION images" pull compose pull --quiet || ! docker image inspect "$SERVER_IMAGE" >/dev/null 2>&1; then
      rollback; die "Could not pull $VERSION; nothing is running differently. Backup: $UPGRADE_BACKUP"
    fi
  fi
  compose_up
  if wait_ready "$READY_TIMEOUT"; then
    rm -rf "$ANLYON_DIR/.rollback"
    if [ -f "$ANLYON_BIN_DIR/anlyon-selfhost" ]; then cp "$ANLYON_DIR/bootstrap.sh" "$ANLYON_BIN_DIR/anlyon-selfhost"; fi
    printf '\n'
    ok_line "${C_BOLD}Upgraded to $SERVER_IMAGE.$C_OFF"
    note "  Backup taken first  $UPGRADE_BACKUP"
    note "  Log                 $C_DIM$LOG_FILE$C_OFF"
    return 0
  fi

  explain_not_ready
  warn "Going back to the previous images: $PREVIOUS_SERVER_IMAGE"
  rollback
  compose_up
  if wait_ready "$READY_TIMEOUT"; then
    ok_line "The previous version is running again."
  else
    explain_not_ready
    warn "The previous version did not come up either."
  fi
  say ""
  note "If the new version changed the database before it failed, restore the backup taken first:"
  note "  anlyon-selfhost restore $UPGRADE_BACKUP"
  [ -z "$LOG_FILE" ] || dim "Log: $LOG_FILE"
  exit 1
}

BACKUP_KEY_VARS="ANLYON_ROOT_KEY BETTER_AUTH_SECRET API_KEY_SECRET DELIVERY_SECRET_MASTER_KEY CONNECTIONS_ENCRYPTION_KEY INTEGRATION_ENCRYPTION_KEY SECRET_RETIRED_MASTER_KEYS"
BACKUP_KEY_RE="^[[:space:]]*(export[[:space:]]+)?[\"']?($(printf '%s' "$BACKUP_KEY_VARS" | tr ' ' '|'))[\"']?[[:space:]]*="

backup_keys_dir() { printf '%s/backup-keys' "$ANLYON_DIR"; }
backup_keys_file() { kf_name=$(basename "$1" .tar.gz); printf '%s/%s.keys' "$(backup_keys_dir)" "$kf_name"; }

key_lines() { grep -E "$BACKUP_KEY_RE" "$1" 2>/dev/null | sed -e 's/^[[:space:]]*//' -e 's/^export[[:space:]]*//' | sort || true; }

keys_fingerprint() {
  kp_lines=$(key_lines "$1")
  [ -n "$kp_lines" ] || return 0
  if command -v sha256sum >/dev/null 2>&1; then printf '%s\n' "$kp_lines" | sha256sum | cut -c1-16
  elif command -v openssl >/dev/null 2>&1; then printf '%s\n' "$kp_lines" | openssl dgst -sha256 | sed 's/^.*= *//' | cut -c1-16
  else printf '%s\n' "$kp_lines" | cksum | cut -d' ' -f1; fi
  kp_lines=""
}

do_backup() {
  require_installed
  bk_dir="$ANLYON_DIR/backups"
  bk_kdir=$(backup_keys_dir)
  umask 077
  mkdir -p "$bk_dir" "$bk_kdir"; chmod 700 "$bk_dir" "$bk_kdir"
  bk_stamp=$(date -u +%Y%m%d-%H%M%S)
  BACKUP_FILE="$bk_dir/anlyon-$bk_stamp.tar.gz"
  [ ! -e "$BACKUP_FILE" ] || BACKUP_FILE="$bk_dir/anlyon-$bk_stamp-$$.tar.gz"
  BACKUP_KEYS=$(backup_keys_file "$BACKUP_FILE")
  bk_tmp=$(mktemp -d "$bk_dir/.tmp.XXXXXX")
  compose up -d postgres >/dev/null 2>&1 || true
  if ! step "Dumping the database|Dumped the database" - dump_db "$bk_tmp/database.dump"; then
    rm -rf "${bk_tmp:?}"; die "pg_dump failed; no backup was written."
  fi
  [ "$(head -c 5 "$bk_tmp/database.dump")" = PGDMP ] || { rm -rf "${bk_tmp:?}"; die "pg_dump wrote no dump; no backup was written."; }
  if ! step "Copying the server's files (anlyon_data)|Copied the server's files" - dump_data "$bk_tmp/data.tar" ||
     ! tar -tf "$bk_tmp/data.tar" >/dev/null 2>&1; then
    rm -rf "${bk_tmp:?}"; die "Could not copy the anlyon_data volume; no backup was written."
  fi
  grep -Ev "$BACKUP_KEY_RE" "$ANLYON_DIR/.env" > "$bk_tmp/env" || true
  {
    printf 'format=2\n'
    printf 'created=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'server_image=%s\n' "$(state_get SERVER_IMAGE || true)"
    printf 'ref=%s\nversion=%s\n' "$(state_get REF || true)" "$(state_get VERSION || true)"
    printf 'keys=%s\nkeys_sha256=%s\n' "$(basename "$BACKUP_KEYS")" "$(keys_fingerprint "$ANLYON_DIR/.env")"
  } > "$bk_tmp/meta"
  tar -C "$bk_tmp" -czf "$BACKUP_FILE.tmp" database.dump data.tar env meta
  chmod 600 "$BACKUP_FILE.tmp"
  {
    printf '# Anlyon backup keys for %s, written %s.\n' "$(basename "$BACKUP_FILE")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '# Keep this apart from the archive: whoever has both can read the stored secrets and\n'
    printf '# connected accounts in it. To restore under these keys, put these lines in .env first.\n'
    key_lines "$ANLYON_DIR/.env"
  } > "$BACKUP_KEYS.tmp"
  chmod 600 "$BACKUP_KEYS.tmp"
  mv -f "$BACKUP_KEYS.tmp" "$BACKUP_KEYS"
  mv -f "$BACKUP_FILE.tmp" "$BACKUP_FILE"
  rm -rf "${bk_tmp:?}"
  ok_line "Backup: $BACKUP_FILE"
  dim "The database, the server's files and the settings, without the keys. Owner-only."
  ok_line "Keys:   $BACKUP_KEYS"
  dim "The root key, in its own file (owner-only, 0600), never in the archive. Copy the archive off"
  dim "this server, and the keys somewhere else, such as a password manager: without the root key,"
  dim "the backup's stored secrets and connected accounts cannot be read."
  prune_backups
}

# shellcheck disable=SC2016
dump_db() { compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$1"; }

dump_data() { compose run --rm --no-deps -T server tar -C /app/data -cf - . > "$1"; }

# shellcheck disable=SC2016
restore_db() {
  compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner --single-transaction' < "$1"
}

restore_data() {
  compose run --rm --no-deps -T server sh -c 'find /app/data -mindepth 1 -delete && tar -C /app/data -xf -' < "$1"
}

prune_backups() {
  pb_dir="$ANLYON_DIR/backups"
  pb_count=$(find "$pb_dir" -maxdepth 1 -name 'anlyon-*.tar.gz' | wc -l | tr -d ' ')
  [ "$pb_count" -gt "$KEEP" ] || return 0
  find "$pb_dir" -maxdepth 1 -name 'anlyon-*.tar.gz' | sort | head -n $((pb_count - KEEP)) | while IFS= read -r pb_f; do
    pb_keys=$(backup_keys_file "$pb_f")
    rm -f "${pb_f:?}" "${pb_keys:?}"; dim "Removed old backup $(basename "$pb_f") and its keys (keeping $KEEP)"
  done
}

cmd_backup() {
  if [ -n "$BACKUP_SCHEDULE" ]; then schedule_backups "$BACKUP_SCHEDULE"; return; fi
  do_backup
}

cmd_restore() {
  require_installed
  rs_file=$POS1
  [ -f "$rs_file" ] || die "No such backup: $rs_file"
  rs_tmp=$(mktemp -d)
  trap 'rm -rf "${rs_tmp:?}"' EXIT
  tar -C "$rs_tmp" -xzf "$rs_file" database.dump env meta 2>/dev/null || die "$rs_file is not an anlyon-selfhost backup."
  tar -C "$rs_tmp" -xzf "$rs_file" data.tar 2>/dev/null || rm -f "${rs_tmp:?}/data.tar"
  heading "Restore"
  note "Backup  $rs_file"
  sed -e '/^keys_sha256=/d' -e 's/^/          /' "$rs_tmp/meta"
  rs_old_keys=$(env_get keys_sha256 "$rs_tmp/meta")
  [ -n "$rs_old_keys" ] || rs_old_keys=$(keys_fingerprint "$rs_tmp/env")
  if [ "$rs_old_keys" != "$(keys_fingerprint "$ANLYON_DIR/.env")" ]; then
    rs_keys=$(env_get keys "$rs_tmp/meta")
    warn "The backup was made under a different root key than this install's .env."
    note "Restored, its stored secrets and connected accounts could not be read."
    if [ -n "$rs_keys" ]; then
      note "Its keys are in $rs_keys (in $(backup_keys_dir) if it was made here). Put its"
      note "ANLYON_ROOT_KEY in $ANLYON_DIR/.env first, or pass --force to restore anyway."
    else
      rs_keep="$ANLYON_DIR/backups/restore-$(date -u +%Y%m%d-%H%M%S).env"
      (umask 077; cp "$rs_tmp/env" "$rs_keep")
      note "Its .env is at $rs_keep (owner-only). Put its ANLYON_ROOT_KEY in $ANLYON_DIR/.env first,"
      note "or pass --force to restore anyway."
    fi
    [ "$FORCE" -eq 1 ] || exit 1
  fi
  rs_old_keys=""
  say ""
  note "This replaces everything in this install's database with the backup. Accounts, actions,"
  note "approvals and receipts made since the backup are lost."
  if [ -f "$rs_tmp/data.tar" ]; then
    note "The server's files (anlyon_data) are replaced by the backup's too."
  else
    note "This backup has no copy of the server's files (anlyon_data); they are left as they are."
  fi
  if [ "$ASSUME_YES" -ne 1 ]; then confirm_word restore || die "Not confirmed; nothing was changed."; fi
  heading "Backup of the current state first"
  do_backup
  heading "Restore"
  step "Stopping the server and the console|Stopped the server and the console" - compose stop server dashboard
  if ! step "Restoring the database|Restored the database" - restore_db "$rs_tmp/database.dump"; then
    compose start server dashboard >/dev/null 2>&1 || true
    die "pg_restore failed; the database is as it was. The backup of it is $BACKUP_FILE."
  fi
  if [ -f "$rs_tmp/data.tar" ] &&
     ! step "Restoring the server's files|Restored the server's files" - restore_data "$rs_tmp/data.tar"; then
    compose start server dashboard >/dev/null 2>&1 || true
    die "Restoring the server's files failed after the database was restored. The backup taken first is $BACKUP_FILE."
  fi
  step "Starting the server and the console|Started the server and the console" - compose start server dashboard
  if wait_ready "$READY_TIMEOUT"; then
    printf '\n'
    ok_line "${C_BOLD}Restored from $rs_file.$C_OFF"
    dim "Log: $LOG_FILE"
  else explain_not_ready; exit 1; fi
}

BACKUP_UNIT=anlyon-backup

backup_scheduler() {
  if [ -d "$ANLYON_SYSTEMD_RUN" ] && [ -d "$ANLYON_SYSTEMD_DIR" ] && command -v systemctl >/dev/null 2>&1; then echo systemd
  elif [ -d "$ANLYON_CRON_DIR" ]; then echo cron
  fi
}

backup_timer() { printf '%s/%s.timer' "${ANLYON_SYSTEMD_DIR:?}" "$BACKUP_UNIT"; }
backup_service() { printf '%s/%s.service' "${ANLYON_SYSTEMD_DIR:?}" "$BACKUP_UNIT"; }
backup_cron() { printf '%s/%s' "${ANLYON_CRON_DIR:?}" "$BACKUP_UNIT"; }

backup_schedule_in_force() {
  for bs_file in "$(backup_timer)" "$(backup_cron)"; do
    [ -f "$bs_file" ] || continue
    bs_line=$(sed -n 's/^# anlyon-backup-schedule: //p' "$bs_file" | head -n 1)
    [ -n "$bs_line" ] || continue
    case "$bs_file" in *.timer) printf '%s systemd' "$bs_line" ;; *) printf '%s cron' "$bs_line" ;; esac
    return 0
  done
}

remove_backup_schedule() {
  rbs_removed=0
  rbs_timer=$(backup_timer); rbs_service=$(backup_service); rbs_cron=$(backup_cron)
  if [ -f "$rbs_timer" ] || [ -f "$rbs_service" ]; then
    systemctl disable --now "$BACKUP_UNIT.timer" >/dev/null 2>&1 || true
    rm -f "${rbs_timer:?}" "${rbs_service:?}"
    systemctl daemon-reload >/dev/null 2>&1 || true
    rbs_removed=1
  fi
  if [ -f "$rbs_cron" ]; then rm -f "${rbs_cron:?}"; rbs_removed=1; fi
  [ "$rbs_removed" -eq 1 ]
}

schedule_backups() {
  require_installed
  sb_kind=$1
  if [ "$sb_kind" = off ]; then
    if remove_backup_schedule; then ok_line "Scheduled backups are off. Backups already taken are kept."
    else say "No scheduled backups were set up; nothing was changed."; fi
    return 0
  fi
  case "$ANLYON_DIR" in *[!A-Za-z0-9_./-]*) die "Scheduled backups need an install directory without spaces or special characters ($ANLYON_DIR)." ;; esac
  sb_scheduler=$(backup_scheduler)
  [ -n "$sb_scheduler" ] || die "Neither systemd nor cron (/etc/cron.d) is available here; nothing was changed. Run anlyon-selfhost backup from your own scheduler."
  sb_hour=${BACKUP_AT%%:*}; sb_min=${BACKUP_AT#*:}
  sb_hour=${sb_hour#0}; sb_min=${sb_min#0}
  [ -n "$sb_hour" ] || sb_hour=0
  [ -n "$sb_min" ] || sb_min=0
  sb_job="backup --yes --keep $KEEP --dir $ANLYON_DIR"
  sb_marker="# anlyon-backup-schedule: $sb_kind $BACKUP_AT $KEEP"
  remove_backup_schedule || true
  umask 022
  if [ "$sb_scheduler" = systemd ]; then
    if [ "$sb_kind" = weekly ]; then sb_cal="Sun *-*-* $BACKUP_AT:00"; else sb_cal="*-*-* $BACKUP_AT:00"; fi
    {
      printf '# Written by anlyon-selfhost backup --schedule; remove with --schedule off.\n'
      printf '[Unit]\nDescription=Anlyon backup: database, files and keys (%s)\nAfter=docker.service\nWants=docker.service\n\n' "$ANLYON_DIR"
      printf '[Service]\nType=oneshot\nEnvironment=ANLYON_UI=plain\nExecStart=/bin/sh %s/bootstrap.sh %s\n' "$ANLYON_DIR" "$sb_job"
    } > "$(backup_service)"
    {
      printf '%s\n' "$sb_marker"
      printf '# Written by anlyon-selfhost backup --schedule; remove with --schedule off.\n'
      printf '[Unit]\nDescription=Anlyon backup, %s at %s, keeping %s\n\n' "$sb_kind" "$BACKUP_AT" "$KEEP"
      printf '[Timer]\nOnCalendar=%s\nPersistent=true\n\n' "$sb_cal"
      printf '[Install]\nWantedBy=timers.target\n'
    } > "$(backup_timer)"
    chmod 644 "$(backup_service)" "$(backup_timer)"
    systemctl daemon-reload
    systemctl enable --now "$BACKUP_UNIT.timer" >/dev/null
    sb_where="systemd timer $BACKUP_UNIT.timer (journalctl -u $BACKUP_UNIT)"
  else
    if [ "$sb_kind" = weekly ]; then sb_dow=0; else sb_dow='*'; fi
    ( umask 077; mkdir -p "$ANLYON_DIR/backups" ) && chmod 700 "$ANLYON_DIR/backups"
    {
      printf '%s\n' "$sb_marker"
      printf '# Written by anlyon-selfhost backup --schedule; remove with --schedule off.\n'
      printf 'SHELL=/bin/sh\nPATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n'
      printf '%s %s * * %s root ANLYON_UI=plain /bin/sh %s/bootstrap.sh %s >> %s/backups/schedule.log 2>&1\n' \
        "$sb_min" "$sb_hour" "$sb_dow" "$ANLYON_DIR" "$sb_job" "$ANLYON_DIR"
    } > "$(backup_cron)"
    chmod 644 "$(backup_cron)"
    sb_where="$(backup_cron) (log: $ANLYON_DIR/backups/schedule.log)"
  fi
  umask 077
  ok_line "Backups scheduled: $sb_kind at $BACKUP_AT (server time), keeping the last $KEEP"
  dim "$sb_where. Each run writes an archive to $ANLYON_DIR/backups and its keys to"
  dim "$(backup_keys_dir); copy both off this server, to different places."
}

offer_backup_schedule() {
  [ -z "$(backup_schedule_in_force)" ] || return 0
  if [ -n "$BACKUP_SCHEDULE" ]; then
    [ "$BACKUP_SCHEDULE" = off ] || schedule_backups "$BACKUP_SCHEDULE"
    return 0
  fi
  if [ "$ASSUME_YES" -eq 1 ] || [ "$HAVE_TTY" -ne 1 ] || [ -z "$(backup_scheduler)" ]; then
    dim "Scheduled backups are off. To turn them on: anlyon-selfhost backup --schedule daily"
    return 0
  fi
  if ask "Back up every day at $BACKUP_AT (server time), keeping the last $KEEP?" y; then
    schedule_backups daily
  else
    dim "Scheduled backups are off. To turn them on: anlyon-selfhost backup --schedule daily"
  fi
}

cmd_status() {
  require_installed
  say "Anlyon at $ANLYON_DIR"
  note "Address:  $(env_get ANLYON_PUBLIC_URL "$ANLYON_DIR/.env")"
  note "Edition:  $(env_get EDITION "$ANLYON_DIR/.env")"
  note "Images:   $(state_get IMAGES || true): $(state_get SERVER_IMAGE || true), $(state_get DASHBOARD_IMAGE || true)"
  note "Source:   $(state_get REPO || true)@$(state_get REF || true)"
  if server_ready; then note "Ready:    yes"; else note "Ready:    no (anlyon-selfhost logs server)"; fi
  st_dir="$ANLYON_DIR/backups"
  if [ -d "$st_dir" ]; then
    st_last=$(find "$st_dir" -maxdepth 1 -name 'anlyon-*.tar.gz' | sort | tail -n 1)
    note "Backups:  $(find "$st_dir" -maxdepth 1 -name 'anlyon-*.tar.gz' | wc -l | tr -d ' '), latest ${st_last:-none}"
    if [ -n "$st_last" ] && [ -f "$(backup_keys_file "$st_last")" ]; then note "Keys:     $(backup_keys_file "$st_last")"; fi
  else
    note "Backups:  none (anlyon-selfhost backup)"
  fi
  st_schedule=$(backup_schedule_in_force)
  if [ -n "$st_schedule" ]; then
    # shellcheck disable=SC2086
    set -- $st_schedule
    note "Schedule: $1 at $2, keeping $3 ($4)"
  else
    note "Schedule: none (anlyon-selfhost backup --schedule daily)"
  fi
  say ""
  compose ps
}

cmd_logs() {
  require_installed
  case "$POS1" in ""|server|dashboard|caddy|postgres|redis) ;; *) usage_error "logs takes server, dashboard, caddy, postgres or redis." ;; esac
  if [ "$FOLLOW" -eq 1 ]; then
    # shellcheck disable=SC2086
    compose logs --tail "$TAIL" -f $POS1
  else
    # shellcheck disable=SC2086
    compose logs --tail "$TAIL" $POS1
  fi
}

cmd_uninstall() {
  require_installed
  case "$ANLYON_DIR" in /|"") die "Refusing to uninstall from '$ANLYON_DIR'." ;; esac
  if [ "$PURGE" -eq 1 ]; then
    heading "Uninstall" "and delete the data"
    note "This deletes Anlyon from this server for good: the containers, the database and its volumes,"
    note "the images, and $ANLYON_DIR, including .env (the root key), every backup and backup key in"
    note "it, and the scheduled backups."
    note "Copy anything you want to keep off this server first."
    confirm_word purge || die "Not confirmed; nothing was changed."
    LOG_NAME=uninstall.log
    LOG_FILE=$(umask 077; mktemp "${TMPDIR:-/tmp}/anlyon-uninstall.XXXXXX")
    LOG_STAY_TMP=1
    step "Removing the containers, volumes and images|Removed the containers, volumes and images" - \
      compose down --volumes --rmi all --remove-orphans || true
    remove_backup_schedule || true
    rm -rf "$ANLYON_DIR"
    rm -f "$ANLYON_BIN_DIR/anlyon-selfhost" "$LOG_FILE"
    ok_line "Removed. Docker, swap and firewall rules were left as they were."
    return 0
  fi
  heading "Uninstall"
  note "This stops and removes the Anlyon containers, and the scheduled backups (which would start"
  note "the database again). The database, $ANLYON_DIR/.env, the backups and their keys stay."
  ask "Uninstall?" n || { say "Nothing was changed."; return 0; }
  step "Stopping and removing the containers|Stopped and removed the containers" - compose down --remove-orphans
  if remove_backup_schedule; then ok_line "Removed the scheduled backups"; fi
  ok_line "Everything else is kept. Start it again with: cd $ANLYON_DIR && docker compose up -d"
  dim "To delete the data too: anlyon-selfhost uninstall --purge"
}

main() {
  parse_args "$@"
  ui_init
  case "$CMD" in
    help) usage; return 0 ;;
    version) say "anlyon-selfhost: $(state_get SERVER_IMAGE 2>/dev/null) from $(state_get REPO 2>/dev/null)@$(state_get REF 2>/dev/null)"; return 0 ;;
  esac
  require_root "$@"
  [ "$ASSUME_YES" -eq 1 ] || open_tty
  case "$CMD" in
    install) cmd_install ;;
    preflight) cmd_preflight ;;
    status) cmd_status ;;
    logs) cmd_logs ;;
    upgrade) cmd_upgrade ;;
    backup) cmd_backup ;;
    restore) cmd_restore ;;
    uninstall) cmd_uninstall ;;
  esac
}

if [ "${ANLYON_BOOTSTRAP_LIB:-0}" != 1 ]; then
  main "$@" < /dev/null
fi
