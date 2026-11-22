#!/bin/sh
set -eu

api_url="${ANLYON_API_URL:-}"
edition="${ANLYON_EDITION:-community}"

case "$edition" in
  community|team|enterprise) ;;
  *) echo "ANLYON_EDITION must be community, team or enterprise, not \"$edition\"." >&2; exit 1 ;;
esac

if [ -n "$api_url" ]; then
  case "$api_url" in
    http://*|https://*) ;;
    *) echo "ANLYON_API_URL must start with http:// or https:// (got \"$api_url\"). Leave it empty when the API and the console share an origin." >&2; exit 1 ;;
  esac
  case "$api_url" in
    *[\"\'\\\<\>\ \;]*) echo "ANLYON_API_URL contains characters a URL never has." >&2; exit 1 ;;
  esac
fi

cat > /srv/config.js <<EOF
// Written by the container at start from ANLYON_API_URL and ANLYON_EDITION.
window.__ANLYON_CONFIG__ = { apiBaseUrl: "${api_url%/}", edition: "${edition}" };
EOF

if [ -n "$api_url" ]; then
  origin=$(printf '%s' "$api_url" | sed -E 's#^(https?://[^/]+).*$#\1#')
  if ! grep -q "connect-src 'self' $origin[ ;]" /srv/index.html; then
    sed -i "s#connect-src 'self'#connect-src 'self' $origin#" /srv/index.html
  fi
fi

connect_extra=""
if [ -n "$api_url" ]; then
  connect_extra=$(printf '%s' "$api_url" | sed -E 's#^(https?://[^/]+).*$#\1#')
fi
sed -i "s#__CONNECT_EXTRA__#$connect_extra#" /etc/caddy/Caddyfile
sed -i "s#'self'  wss:#'self' wss:#" /etc/caddy/Caddyfile

exec "$@"
