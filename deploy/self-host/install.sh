#!/bin/sh
set -eu

here=$(cd "$(dirname "$0")" && pwd)
env_file="$here/.env"
domain=""
edition="community"
up=0
force=0
yes=0
write_only=0
allow_http=0

usage() {
  cat <<'HELP'
Anlyon, self-hosted: write .env with fresh secrets and print the setup URL.

  ./install.sh                         # asks for the public domain
  ./install.sh --domain anlyon.example.com --yes --up

The same as `npx @anlyonhq/cli self-host init`, for a server without Node.
Needs a POSIX shell and either openssl or /dev/urandom. Never prints the root
key or the database password; the setup URL it prints works once.

  --domain <host>  anlyon.example.com (HTTPS), or localhost[:port] / an IP (HTTP)
  --edition <e>    community (default), team or enterprise
  --up             start with `docker compose up -d --build` afterwards
  --force          replace an existing .env (a new root key: secrets stored
                   under the old one become unreadable)
  --yes            do not prompt: localhost unless --domain is given
  --allow-http     serve an IP address over plain HTTP, reachable from the
                   network (sign-ins, API keys and the setup token unencrypted)
  --write-only     write .env and stop: no offer to start, no setup URL
                   (bootstrap.sh starts the install and prints the URL itself)
HELP
  exit 2
}

case "${ANLYON_UI:-auto}" in
  fancy) ui_colour=1 ;;
  plain) ui_colour=0 ;;
  *) ui_colour=0; if [ -t 1 ] && [ -z "${NO_COLOR+set}" ] && [ "${TERM:-dumb}" != dumb ]; then ui_colour=1; fi ;;
esac
if [ "$ui_colour" -eq 1 ]; then
  c_dim=$(printf '\033[2m'); c_bold=$(printf '\033[1m'); c_ok=$(printf '\033[32m'); c_off=$(printf '\033[0m')
else
  c_dim=""; c_bold=""; c_ok=""; c_off=""
fi
case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
  *[Uu][Tt][Ff]-8*|*[Uu][Tt][Ff]8*) sym_ok='✓' ;;
  *) sym_ok='ok' ;;
esac
done_line() { printf '  %s%s%s %s\n' "$c_ok" "$sym_ok" "$c_off" "$*"; }
dim_line() { printf '  %s%s%s\n' "$c_dim" "$*" "$c_off"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) [ $# -ge 2 ] || usage; domain=$2; shift 2 ;;
    --domain=*) domain=${1#--domain=}; shift ;;
    --edition) [ $# -ge 2 ] || usage; edition=$2; shift 2 ;;
    --edition=*) edition=${1#--edition=}; shift ;;
    --up) up=1; shift ;;
    --force) force=1; shift ;;
    --yes|-y) yes=1; shift ;;
    --write-only) write_only=1; shift ;;
    --allow-http) allow_http=1; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1" >&2; usage ;;
  esac
done

case "$edition" in
  community|team|enterprise) ;;
  *) echo "--edition must be community, team or enterprise." >&2; exit 2 ;;
esac

if [ -e "$env_file" ] && [ "$force" -ne 1 ]; then
  echo "$env_file already exists. Nothing was changed." >&2
  echo "It holds this install's root key. Pass --force only to start over: a new root key makes secrets stored under the old one unreadable." >&2
  exit 2
fi

if [ -z "$domain" ] && [ "$yes" -ne 1 ] && [ -t 0 ]; then
  printf '%s?%s Domain for this install, such as anlyon.example.com  %sEnter: localhost:8080%s  ' "$c_bold" "$c_off" "$c_dim" "$c_off" >&2
  read -r domain || domain=""
fi
[ -n "$domain" ] || domain="localhost"

domain=$(printf '%s' "$domain" | tr '[:upper:]' '[:lower:]' | sed -e 's#^https\{0,1\}://##' -e 's#/*$##')
if [ "$(printf '%s' "$domain" | wc -l | tr -d ' ')" != "0" ] || [ -n "$(printf '%s' "$domain" | tr -d 'a-z0-9.:_-')" ]; then
  echo "--domain must be a host name such as anlyon.example.com or localhost:8080." >&2; exit 2
fi
case "$domain" in
  */*|*@*|*" "*|"") echo "--domain must be a host name such as anlyon.example.com or localhost:8080." >&2; exit 2 ;;
esac
host=${domain%:*}
port=""
[ "$host" != "$domain" ] && port=${domain##*:}
if [ -n "$port" ]; then
  case "$port" in *[!0-9]*|"") echo "The port in --domain must be a number." >&2; exit 2 ;; esac
  if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
    echo "The port in --domain must be 1-65535." >&2; exit 2
  fi
fi

bind_address=0.0.0.0
if [ "$host" = "localhost" ] || printf '%s' "$host" | grep -Eq '^[0-9]+(\.[0-9]+){3}$'; then
  http_port=${port:-8080}
  https_port=8443
  public_url="http://$host:$http_port"
  site_address=":80"
  if [ "$host" = "localhost" ]; then
    bind_address=127.0.0.1
  elif [ "$allow_http" -ne 1 ]; then
    echo "$public_url would be served over plain HTTP, reachable from the network: sign-ins, the setup token and API keys would cross it unencrypted. Use a host name (--domain anlyon.example.com) for a certificate, or pass --allow-http to accept that. Nothing was written." >&2
    exit 2
  else
    echo "Warning: $public_url is served over plain HTTP, reachable from the network. Sign-ins, the setup token and API keys cross it unencrypted. Use a host name (--domain anlyon.example.com) for anything but a trial." >&2
  fi
else
  printf '%s' "$host" | grep -Eq '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$' || {
    echo "--domain must be a host name such as anlyon.example.com or localhost:8080." >&2; exit 2; }
  http_port=80
  https_port=${port:-443}
  if [ "$https_port" = "443" ]; then public_url="https://$host"; else public_url="https://$host:$https_port"; fi
  site_address=$host
fi

random_bytes() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand "$1"
  elif [ -r /dev/urandom ]; then
    head -c "$1" /dev/urandom
  else
    echo "Need openssl or /dev/urandom to generate secrets." >&2; exit 1
  fi
}
b64url() { base64 | tr -d '\n=' | tr '+/' '-_'; }
hex() { od -An -vtx1 | tr -d ' \n'; }

root_key=$(random_bytes 32 | b64url)
setup_token=$(random_bytes 32 | b64url)
postgres_password=$(random_bytes 24 | hex)

if [ ${#root_key} -ne 43 ] || [ ${#setup_token} -ne 43 ] || [ ${#postgres_password} -ne 48 ]; then
  echo "Secret generation failed; nothing was written." >&2; exit 1
fi

umask 077
tmp="$here/.env.$$.tmp"
trap 'rm -f "$tmp"' EXIT
cat > "$tmp" <<EOF
# Anlyon, self-hosted. Written by install.sh on $(date -u +%Y-%m-%d).
# Keep this file private: it holds the install's root key.
#
# This file is only what the server needs before it can reach its database.
# Everything else (email, file storage, sign-up, licence, telemetry, OAuth apps,
# Slack) is set in the console: Settings, Instance.

# community (free), team or enterprise (licensed; paste the key in the console).
# Any other value stops the server at start.
EDITION=$edition

# Where the install is served. The console and the API share this address.
ANLYON_PUBLIC_URL=$public_url
SITE_ADDRESS=$site_address
ANLYON_PORT=$http_port
ANLYON_HTTPS_PORT=$https_port
# The address the ports are published on: 127.0.0.1 for a localhost install, else every interface.
ANLYON_BIND=$bind_address

# The one secret. Every key the server needs (sessions, API keys, stored secrets,
# connected accounts) is derived from it. Copy it somewhere other than this
# server, such as a password manager: without it, stored secrets and connected
# accounts cannot be read, and nobody can recover them.
ANLYON_ROOT_KEY=$root_key

# Opens the setup page once, to create the first owner. Unused afterwards.
ANLYON_SETUP_TOKEN=$setup_token

# The bundled Postgres and Redis (docker-compose.yml).
POSTGRES_PASSWORD=$postgres_password
DATABASE_URL=postgresql://anlyon:$postgres_password@postgres:5432/anlyon
REDIS_URL=redis://redis:6379
EOF
chmod 600 "$tmp"
mv -f "$tmp" "$env_file"
trap - EXIT

done_line "Wrote $env_file (owner-only)"
dim_line "It holds the root key: copy ANLYON_ROOT_KEY to a password manager, off this server."
[ "$write_only" -eq 1 ] && exit 0

if [ "$up" -ne 1 ] && [ "$yes" -ne 1 ] && [ -t 0 ]; then
  printf '%s?%s Start it now with docker compose?  %s[Y/n]%s ' "$c_bold" "$c_off" "$c_dim" "$c_off" >&2
  read -r answer || answer="n"
  case "$answer" in ""|y|Y|yes|YES) up=1 ;; esac
fi

if [ "$up" -eq 1 ]; then
  dim_line "Starting: docker compose up -d --build. The first build takes a few minutes."
  (cd "$here" && docker compose up -d --build)
  done_line "Started"
else
  dim_line "Start it:  cd $here && docker compose up -d --build"
fi

echo
echo "  Then open this URL to create the first owner. It works once."
echo
echo "    $c_bold$public_url/setup#token=$setup_token$c_off"
echo
dim_line "Everything else (email, storage, sign-up, licence, telemetry, OAuth apps) is set in the console."
dim_line "Telemetry: once setup is done, this install sends a random install id, its version and edition,"
dim_line "and daily counts (workspaces, members, actions, calls, approvals) to telemetry.anlyon.com. No"
dim_line "names and no content. Turn it off in the console, or now with ANLYON_TELEMETRY=off in $env_file."
