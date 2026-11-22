#!/bin/sh
name=${0##*/}
log() { printf '%s %s\n' "$name" "$*" >> "${SHIM_LOG:-/dev/null}"; }
count() {
  c_file="${SHIM_STATE:-/tmp}/$1.count"
  c_n=$(cat "$c_file" 2>/dev/null || echo 0)
  echo $((c_n + 1)) > "$c_file"
  echo "$c_n"
}

case "$name" in
  uname)
    case "${1:-}" in
      -s) echo "${SHIM_UNAME_S:-Linux}" ;;
      -m) echo "${SHIM_UNAME_M:-x86_64}" ;;
      *) echo "${SHIM_UNAME_S:-Linux}" ;;
    esac ;;

  id)
    case "${1:-}" in
      -u) echo "${SHIM_UID:-0}" ;;
      -un) echo root ;;
      -nG) echo "${SHIM_GROUPS:-$2}" ;;
      *) echo "uid=${SHIM_UID:-0}(root)" ;;
    esac ;;

  nproc) echo "${SHIM_NPROC:-4}" ;;

  free)
    printf '               total        used        free      shared  buff/cache   available\n'
    printf 'Mem:           %s         100        100           1         100        100\n' "${SHIM_MEM_MB:-8000}"
    printf 'Swap:          %s           0          0\n' "${SHIM_SWAP_MB:-0}" ;;

  df)
    printf 'Filesystem     1024-blocks    Used Available Capacity Mounted on\n'
    printf '/dev/sda1        209715200 1000000 %s      1%% /\n' "${SHIM_DISK_KB:-104857600}" ;;

  ss|netstat)
    [ "$name" = netstat ] && printf 'Active Internet connections\nProto Recv-Q Send-Q Local Address Foreign Address State\n'
    for p in ${SHIM_LISTEN:-22}; do
      if [ "$name" = ss ]; then printf 'LISTEN 0 4096 0.0.0.0:%s 0.0.0.0:*\n' "$p"
      else printf 'tcp 0 0 0.0.0.0:%s 0.0.0.0:* LISTEN\n' "$p"; fi
    done ;;

  timedatectl) echo "${SHIM_NTP:-yes}" ;;

  hostname) [ "${1:-}" = -I ] && echo "${SHIM_LOCAL_IPS:-10.0.0.5}" ;;

  dig)
    type=""; qname=""
    for a in "$@"; do
      case "$a" in
        +*|@*) ;;
        A|AAAA|NS) type=$a ;;
        *) qname=$a ;;
      esac
    done
    file=${SHIM_DNS:-/dev/null}
    if [ "$type" = A ] && [ -n "${SHIM_DNS_SWITCH_AFTER:-}" ]; then
      n=$(count dig-a)
      [ "$n" -ge "$SHIM_DNS_SWITCH_AFTER" ] && file=$SHIM_DNS_LATER
    fi
    awk -v t="$type" -v n="$qname" '$1 == t && $2 == n { print $3 (t == "NS" ? "." : "") }' "$file" ;;

  getent)
    awk -v n="$2" '$1 == n { print $2 "  STREAM " n }' "${SHIM_HOSTS:-/dev/null}" ;;

  curl)
    method=GET; out=""; url=""; data=""; config=0
    while [ $# -gt 0 ]; do
      case "$1" in
        -X) method=$2; shift 2 ;;
        -o) out=$2; shift 2 ;;
        --data) data=$2; shift 2 ;;
        --config) config=1; shift 2 ;;
        -H|--max-time|--resolve) shift 2 ;;
        -*) shift ;;
        *) url=$1; shift ;;
      esac
    done
    auth=no
    if [ "$config" -eq 1 ]; then
      grep -q 'Authorization: Bearer ' && auth=yes
    fi
    log "$method $url auth=$auth data=$data"
    resp=$(awk -v m="$method" -v u="$url" '($1 == m || $1 == "*") && index(u, $2) { print $3; exit }' "${SHIM_HTTP:-/dev/null}")
    [ -n "$resp" ] || exit 22
    if [ -n "$out" ]; then cp "$resp" "$out"; else cat "$resp"; fi ;;

  docker)
    log "$*"
    case "$*" in
      "version --format"*) [ -n "${SHIM_DOCKER_VERSION-27.3.1}" ] || exit 1; echo "${SHIM_DOCKER_VERSION-27.3.1}" ;;
      "compose version --short") [ -n "${SHIM_COMPOSE_VERSION-2.29.7}" ] || exit 1; echo "${SHIM_COMPOSE_VERSION-2.29.7}" ;;
      "compose version") echo "Docker Compose version v${SHIM_COMPOSE_VERSION-2.29.7}" ;;
      "buildx version") [ "${SHIM_NO_BUILDX:-0}" = 1 ] && exit 1; echo "github.com/docker/buildx v0.17.1" ;;
      "compose exec -T server"*)
        if [ -n "${SHIM_BAD_IMAGE:-}" ] && grep -q "image: .*$SHIM_BAD_IMAGE" docker-compose.override.yml 2>/dev/null; then exit 1; fi
        exit "${SHIM_READY_RC:-0}" ;;
      "compose build"*)
        if [ -n "${SHIM_BUILD_FAIL:-}" ]; then
          printf '#9 [server deps 3/7] RUN pnpm install --frozen-lockfile\n' >&2
          printf 'ERR_PNPM_FETCH_404 a package was not found\n' >&2
          exit 1
        fi ;;
      "compose exec -T postgres"*pg_dump*) printf 'PGDMP fake dump\n' ;;
      "compose exec -T postgres"*pg_restore*) cat > /dev/null ;;
      "compose run --rm --no-deps -T server tar -C /app/data -cf - .")
        [ "${SHIM_DATA_FAIL:-0}" = 1 ] && exit 1
        d_dir="${SHIM_STATE:-/tmp}/volume"
        mkdir -p "$d_dir/storage"
        printf 'archived log\n' > "$d_dir/storage/archive.txt"
        tar -C "$d_dir" -cf - . ;;
      "compose run --rm --no-deps -T server sh -c"*) cat > "${SHIM_STATE:-/tmp}/restored-data.tar" ;;
      "image inspect"*) exit "${SHIM_IMAGE_RC:-0}" ;;
    esac ;;

  ufw)
    log "$*"
    [ "${1:-}" = status ] && echo "Status: ${SHIM_UFW:-inactive}" ;;

  fallocate)
    log "$*"
    for last in "$@"; do :; done
    : > "$last" ;;

  *) log "$*" ;;
esac
exit 0
