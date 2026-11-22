#!/bin/sh
# shellcheck disable=SC1090,SC1091,SC2030,SC2031,SC2034,SC2153,SC2154,SC2015,SC2086,SC2059,SC2012,SC2329
set -u

here=$(cd "$(dirname "$0")" && pwd)
SCRIPT="$here/../bootstrap.sh"
REPO_ROOT=$(cd "$here/../../.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/anlyon-bootstrap-test.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

SHIMS="$WORK/shims"
mkdir -p "$SHIMS"
for c in uname id nproc free df ss timedatectl hostname dig getent curl docker ufw \
         apt-get systemctl usermod fallocate mkswap swapon dpkg; do
  cp "$here/shim.sh" "$SHIMS/$c"
  chmod +x "$SHIMS/$c"
done
PATH="$SHIMS:$PATH"
export PATH
export LANG=C.UTF-8 LC_ALL=C.UTF-8

PASS=0; FAIL=0; CURRENT=""
ok() { PASS=$((PASS + 1)); }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL [%s] %s\n' "$CURRENT" "$*"; }
eq() { if [ "$1" = "$2" ]; then ok; else bad "${3:-}: expected [$2], got [$1]"; fi; }
has() { if printf '%s' "$1" | grep -qF -- "$2"; then ok; else bad "${3:-}: missing [$2] in: $(printf '%s' "$1" | tail -n 5)"; fi; }
hasnt() { if printf '%s' "$1" | grep -qF -- "$2"; then bad "${3:-}: unexpected [$2]"; else ok; fi; }
t() { CURRENT=$1; }

sandbox() {
  SB="$WORK/sb.$1"
  rm -rf "$SB"; mkdir -p "$SB/state" "$SB/bin"
  export SHIM_LOG="$SB/calls.log" SHIM_STATE="$SB/state"
  : > "$SHIM_LOG"
  export ANLYON_DIR="$SB/opt/anlyon" ANLYON_BIN_DIR="$SB/bin" ANLYON_TTY="$SB/no-tty"
  export ANLYON_OS_RELEASE="$SB/os-release" ANLYON_POLL=0 ANLYON_CERT_WAIT=0
  export ANLYON_SWAPFILE="$SB/swapfile" ANLYON_FSTAB="$SB/fstab"
  export ANLYON_SYSTEMD_DIR="$SB/systemd" ANLYON_SYSTEMD_RUN="$SB/run-systemd" ANLYON_CRON_DIR="$SB/cron.d"
  printf 'ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n' > "$ANLYON_OS_RELEASE"
  unset SHIM_UNAME_S SHIM_UNAME_M SHIM_NPROC SHIM_MEM_MB SHIM_SWAP_MB SHIM_DISK_KB SHIM_LISTEN \
    SHIM_NTP SHIM_DOCKER_VERSION SHIM_COMPOSE_VERSION SHIM_NO_BUILDX SHIM_READY_RC SHIM_BAD_IMAGE \
    SHIM_DNS SHIM_DNS_LATER SHIM_DNS_SWITCH_AFTER SHIM_HTTP SHIM_UFW SHIM_HOSTS SHIM_LOCAL_IPS SUDO_USER \
    SHIM_BUILD_FAIL SHIM_DATA_FAIL ANLYON_UI NO_COLOR GITHUB_TOKEN ANLYON_REPO ANLYON_REF ANLYON_SOURCE 2>/dev/null || true
}

lib() { ANLYON_BOOTSTRAP_LIB=1; export ANLYON_BOOTSTRAP_LIB; . "$SCRIPT"; set +e; }

run() { OUT=$(ANLYON_BOOTSTRAP_LIB=0 sh "$SCRIPT" "$@" 2>&1); RC=$?; }

sandbox args
t "args: defaults"
out=$( lib; parse_args; resolve_source; echo "$CMD|$EDITION|$IMAGES|$REF|$REPO|$GIT_URL|$ASSUME_YES" )
eq "$out" "install|community|build|main|AnlyonHQ/anlyon|https://github.com/AnlyonHQ/anlyon.git|0"

t "args: --x=y, --version sets the ref, ghcr"
out=$( lib; parse_args install --domain=Anlyon.Example.com --version=v1.4.2 --images ghcr -y --edition team; resolve_source
       echo "$DOMAIN|$VERSION|$REF|$IMAGES|$ASSUME_YES|$EDITION" )
eq "$out" "Anlyon.Example.com|1.4.2|v1.4.2|ghcr|1|team"

t "args: environment picks the repository and ref"
out=$( lib; ANLYON_REPO=me/fork; ANLYON_REF=feat/x; parse_args; resolve_source; echo "$REPO|$REF|$GIT_URL" )
eq "$out" "me/fork|feat/x|https://github.com/me/fork.git"

t "args: a release-stamped copy installs its release unless told otherwise"
sed 's/^ANLYON_RELEASE_VERSION=""$/ANLYON_RELEASE_VERSION="2.0.1"/' "$SCRIPT" > "$WORK/stamped.sh"
grep -q '^ANLYON_RELEASE_VERSION="2.0.1"$' "$WORK/stamped.sh" && ok || bad "the stamp line the release workflow edits"
out=$( ANLYON_BOOTSTRAP_LIB=1; . "$WORK/stamped.sh"; set +e; parse_args; resolve_source; echo "$VERSION|$REF" )
eq "$out" "2.0.1|v2.0.1"
out=$( ANLYON_BOOTSTRAP_LIB=1; . "$WORK/stamped.sh"; set +e; parse_args --ref main; resolve_source; echo "$VERSION|$REF" )
eq "$out" "|main"
out=$( ANLYON_BOOTSTRAP_LIB=1; . "$WORK/stamped.sh"; set +e; parse_args --version 2.1.0; resolve_source; echo "$VERSION|$REF" )
eq "$out" "2.1.0|v2.1.0"

t "args: --source overrides the clone URL"
out=$( lib; parse_args --source https://example.com/a.git --ref dev; resolve_source; echo "$GIT_URL|$REF" )
eq "$out" "https://example.com/a.git|dev"

for bad_args in "--bogus" "--images docker" "--edition free" "--version latest" "--keep 0" "--timeout soon" \
                "--public-ip 999.1.1.1" "--repo justname" "status extra" "restore" "--domain" \
                "backup --schedule hourly" "backup --at 25:00" "backup --at 3:17" "--backup-schedule monthly"; do
  t "args: rejects $bad_args"
  # shellcheck disable=SC2086
  ( lib; parse_args $bad_args ) >/dev/null 2>&1
  eq "$?" 2 "$bad_args"
done

t "args: ghcr needs a version"
( lib; parse_args --images ghcr; resolve_source ) >/dev/null 2>&1
eq "$?" 2

t "args: backup schedule flags"
out=$( lib; parse_args backup --schedule weekly --at 04:05 --keep 3; echo "$CMD|$BACKUP_SCHEDULE|$BACKUP_AT|$KEEP" )
eq "$out" "backup|weekly|04:05|3"
out=$( lib; parse_args install --backup-schedule=daily; echo "$CMD|$BACKUP_SCHEDULE|$BACKUP_AT" )
eq "$out" "install|daily|03:17"

t "args: logs takes a service; restore takes a file"
out=$( lib; parse_args logs server -f --tail 50; echo "$CMD|$POS1|$FOLLOW|$TAIL" )
eq "$out" "logs|server|1|50"
out=$( lib; parse_args restore /tmp/b.tar.gz --force; echo "$CMD|$POS1|$FORCE" )
eq "$out" "restore|/tmp/b.tar.gz|1"

t "args: --from-dir must exist and becomes absolute"
( lib; parse_args --from-dir "$WORK/nope" ) >/dev/null 2>&1
eq "$?" 2
out=$( cd "$REPO_ROOT" && lib && parse_args --from-dir . && echo "$FROM_DIR" )
eq "$out" "$REPO_ROOT"

t "args: help as anlyon-selfhost"
run help
eq "$RC" 0; has "$OUT" "anlyon-selfhost <command>"; has "$OUT" "https://anlyon.com/install"

t "address: host name, IP, localhost, ports"
out=$( lib; address_for anlyon.example.com; echo "$IS_HOSTNAME|$HTTP_PORT|$HTTPS_PORT|$PUBLIC_URL" )
eq "$out" "1|80|443|https://anlyon.example.com"
out=$( lib; address_for https://Anlyon.Example.com:8443/; echo "$HOST|$HTTPS_PORT|$PUBLIC_URL" )
eq "$out" "anlyon.example.com|8443|https://anlyon.example.com:8443"
out=$( lib; address_for 203.0.113.10; echo "$IS_HOSTNAME|$HTTP_PORT|$HTTPS_PORT|$PUBLIC_URL" )
eq "$out" "0|8080|8443|http://203.0.113.10:8080"
out=$( lib; address_for localhost:9000; echo "$HTTP_PORT|$PUBLIC_URL" )
eq "$out" "9000|http://localhost:9000"
for bad_domain in "a b" "user@host" "host/path" "-bad-.com" "x.com:99999" "x.com:abc" "nodot"; do
  t "address: rejects $bad_domain"
  ( lib; address_for "$bad_domain" ) >/dev/null 2>&1
  eq "$?" 2 "$bad_domain"
done

t "version_ge"
( lib
  version_ge 27.3.1 24.0.0 && version_ge 24.0.0 24.0.0 && version_ge v2.29.7 2.24.0 && ! version_ge 20.10.24 24.0.0 &&
    ! version_ge 2.20.3 2.24.0 && version_ge 2.24.0-desktop.1 2.24.0 ) && ok || bad "comparisons"

t "ipv4 and Cloudflare ranges"
( lib
  is_ipv4 203.0.113.10 && ! is_ipv4 256.1.1.1 && ! is_ipv4 1.2.3 &&
    ipv4_in_cloudflare 104.16.0.1 && ipv4_in_cloudflare 104.23.255.255 && ipv4_in_cloudflare 104.24.0.0 &&
    ipv4_in_cloudflare 172.67.1.1 && ! ipv4_in_cloudflare 104.28.0.0 && ! ipv4_in_cloudflare 203.0.113.10 &&
    ipv4_in_cloudflare 131.0.75.255 && ! ipv4_in_cloudflare 131.0.76.0 ) && ok || bad "ranges"

pf() {
  ( lib; parse_args --domain localhost; resolve_source; address_for localhost; PUBLIC_IP4=""; PUBLIC_IP6=""
    run_preflight; echo "FATAL=$PF_FATAL FAILS=$PF_FAILS FIXES=$PF_FIXES" )
}

sandbox pf-good
t "preflight: a good server"
out=$(pf)
has "$out" "✓ OS           Ubuntu 24.04.1 LTS"
has "$out" "✓ Architecture x86_64"
has "$out" "✓ CPU          4 cores"
has "$out" "✓ Memory       8000 MB"
has "$out" "✓ Disk         100 GB free"
has "$out" "✓ Ports        8080 and 8443 are free"
has "$out" "✓ Docker       Engine 27.3.1, Compose 2.29.7"
has "$out" "✓ Clock        synchronised"
has "$out" "✓ Privileges   root"
has "$out" "✓ DNS          skipped: localhost is served over plain HTTP"
has "$out" "FATAL=0 FAILS=0 FIXES= "
hasnt "$out" "✗"

sandbox pf-bad
t "preflight: a server that falls short"
export SHIM_UNAME_M=armv7l SHIM_NPROC=1 SHIM_MEM_MB=1000 SHIM_DISK_KB=10485760 SHIM_LISTEN="22 8080" SHIM_NTP=no
printf 'ID=fedora\nVERSION_ID=40\nPRETTY_NAME="Fedora Linux 40"\n' > "$ANLYON_OS_RELEASE"
out=$(pf)
has "$out" "! OS           Fedora Linux 40: not tested"
has "$out" "✗ Architecture armv7l"
has "$out" "✗ CPU          1 core"
has "$out" "✗ Memory       1000 MB: at least 2 GB"
has "$out" "✗ Disk         10 GB free: 20 GB is needed"
has "$out" "✗ Ports        in use: 8080"
has "$out" "! Clock        not synchronised"
has "$out" "FATAL=0 FAILS=5"

sandbox pf-fatal
t "preflight: not Linux, not root"
export SHIM_UNAME_S=Darwin SHIM_UID=501
out=$(pf)
has "$out" "✗ System       Darwin: the installer runs on Linux servers"
has "$out" "✗ Privileges   not root"
has "$out" "FATAL=2"
unset SHIM_UID

sandbox pf-swap
t "preflight: 2 GB offers swap; 2 GB plus swap is enough"
export SHIM_MEM_MB=2000
out=$( lib; check_memory_only() { pf_reset; check_memory; echo "$PF_ROWS|$PF_FIXES|$SWAP_ADD_GB"; }; check_memory_only )
has "$out" "fix|Memory|2000 MB and 0 MB swap: below 4 GB; a 3 GB swap file"
has "$out" " swap |3"
export SHIM_SWAP_MB=2048
out=$( lib; pf_reset; check_memory; echo "$PF_ROWS" )
has "$out" "ok|Memory|2000 MB plus 2048 MB swap"

sandbox pf-ports
t "preflight: port 80 busy is not port 8080 busy"
export SHIM_LISTEN="22 8080 4430"
out=$( lib; parse_args; resolve_source; address_for anlyon.example.com; pf_reset; check_ports; echo "$PF_ROWS" )
has "$out" "ok|Ports|80 and 443 are free"
export SHIM_LISTEN="80"
out=$( lib; parse_args; resolve_source; address_for anlyon.example.com; pf_reset; check_ports; echo "$PF_ROWS" )
has "$out" "fail|Ports|in use: 80"

sandbox pf-docker
t "preflight: Docker missing, old, stopped, old Compose, no buildx"
dk() { ( lib; parse_args "$@"; resolve_source; pf_reset; check_docker; echo "$PF_ROWS|$PF_FIXES" ); }
out=$(export SHIM_DOCKER_VERSION=20.10.24; dk); has "$out" "Engine 20.10.24 is older than 24.0"; has "$out" " docker "
out=$(export SHIM_DOCKER_VERSION=""; dk); has "$out" "the engine is not running"; has "$out" " docker-start "
out=$(export SHIM_COMPOSE_VERSION=2.20.3; dk); has "$out" "Compose 2.20.3 is older than 2.24.0"
out=$(export SHIM_NO_BUILDX=1; dk); has "$out" "no buildx"
out=$(export SHIM_NO_BUILDX=1; dk --images ghcr --version 1.0.0); has "$out" "ok|Docker"
# shellcheck disable=SC2317
out=$( ( lib; have() { [ "$1" != docker ] && command -v "$1" >/dev/null 2>&1; }; parse_args; resolve_source; pf_reset; check_docker; echo "$PF_ROWS|$PF_FIXES" ) ); has "$out" "fix|Docker|not installed"

t "dns: the decision"
( lib; PASS=0; FAIL=0
  eq "$(dns_decide "" 203.0.113.10)" missing "no record"
  eq "$(dns_decide "203.0.113.10" 203.0.113.10)" ok "this server"
  eq "$(dns_decide "198.51.100.7" 203.0.113.10)" mismatch "another server"
  eq "$(dns_decide "203.0.113.10
198.51.100.7" 203.0.113.10)" extra "this and another"
  eq "$(dns_decide "104.16.1.1
104.16.2.2" 203.0.113.10)" proxied "Cloudflare proxy"
  eq "$(dns_decide "104.16.1.1" "")" proxied "proxied, own IP unknown"
  eq "$(dns_decide "198.51.100.7" "")" unknown "own IP unknown"
  eq "$(dns_decide "203.0.113.10" 203.0.113.10 "2001:db8::9" "")" aaaa "stale AAAA"
  eq "$(dns_decide "203.0.113.10" 203.0.113.10 "2001:db8::1" "2001:db8::1")" ok "matching AAAA"
  echo "$PASS $FAIL" > "$WORK/sub.counts" )
read -r sp sf < "$WORK/sub.counts"; PASS=$((PASS + sp)); FAIL=$((FAIL + sf))

t "dns: providers by nameserver"
( lib; PASS=0; FAIL=0
  for pair in "aria.ns.cloudflare.com cloudflare" "ns1.vercel-dns.com vercel" "dns1.registrar-servers.com namecheap" \
    "ns07.domaincontrol.com godaddy" "curitiba.ns.porkbun.com porkbun" "ns-cloud-a1.googledomains.com squarespace" \
    "dns1.squarespacedns.com squarespace" "ns-123.awsdns-15.com route53" "ns1.digitalocean.com digitalocean" \
    "ns1.dns-parking.com hostinger" "ns-191-a.gandi.net gandi" "ns1.example-dns.net other"; do
    set -- $pair
    eq "$(dns_provider "$1")" "$2" "$1"
  done
  eq "$(dns_provider "NS1.DIGITALOCEAN.COM
ns2.digitalocean.com")" digitalocean "case and several lines"
  echo "$PASS $FAIL" > "$WORK/sub.counts" )
read -r sp sf < "$WORK/sub.counts"; PASS=$((PASS + sp)); FAIL=$((FAIL + sf))

t "dns: record name"
out=$( lib; echo "$(dns_record_name anlyon.example.com example.com) $(dns_record_name example.com example.com) $(dns_record_name a.b.example.co.uk example.co.uk)" )
eq "$out" "anlyon @ a.b"

sandbox dns-zone
t "dns: zone from the nearest NS records"
printf 'NS example.com aria.ns.cloudflare.com\nNS example.com bob.ns.cloudflare.com\nA anlyon.example.com 203.0.113.10\n' > "$SB/dns"
export SHIM_DNS="$SB/dns"
out=$( lib; dns_zone anlyon.example.com; echo "$DNS_ZONE|$(dns_join "$DNS_NS")" )
eq "$out" "example.com|aria.ns.cloudflare.com, bob.ns.cloudflare.com"
out=$( lib; dns_a anlyon.example.com )
eq "$out" "203.0.113.10"

t "dns: without dig, getent ignores /etc/hosts loopback names"
printf 'anlyon.example.com 127.0.1.1\nanlyon.example.com 203.0.113.10\n' > "$SB/hosts"
# shellcheck disable=SC2317
out=$( SHIM_HOSTS="$SB/hosts"; export SHIM_HOSTS; lib; have() { [ "$1" != dig ] && command -v "$1" >/dev/null 2>&1; }; dns_a anlyon.example.com )
eq "$out" "203.0.113.10"

sandbox public-ip
t "public IP: two sources must agree"
printf '203.0.113.10\n' > "$SB/ip-a"; printf '203.0.113.10\n' > "$SB/ip-b"; printf '198.51.100.1\n' > "$SB/ip-c"
printf '2001:db8::1\n' > "$SB/ip6"
printf 'GET ifconfig.co %s\nGET api.ipify.org %s\nGET api6.ipify.org %s\n' "$SB/ip-a" "$SB/ip-b" "$SB/ip6" > "$SB/http"
export SHIM_HTTP="$SB/http"
out=$( lib; parse_args; detect_public_ip; echo "$PUBLIC_IP4|$PUBLIC_IP6" )
eq "$out" "203.0.113.10|2001:db8::1"
t "public IP: disagreement without a terminal leaves it unknown"
printf 'GET ifconfig.co %s\nGET api.ipify.org %s\n' "$SB/ip-a" "$SB/ip-c" > "$SB/http"
out=$( lib; parse_args; detect_public_ip; echo "[$PUBLIC_IP4]" )
eq "$out" "[]"
t "public IP: disagreement, then asked"
printf '203.0.113.77\n' > "$SB/tty"
out=$( ANLYON_TTY="$SB/tty"; lib; parse_args; open_tty; detect_public_ip 2>/dev/null; echo "$PUBLIC_IP4" )
eq "$out" "203.0.113.77"
t "public IP: one answer that this server holds"
printf 'GET ifconfig.co %s\n' "$SB/ip-a" > "$SB/http"
out=$( SHIM_LOCAL_IPS="10.0.0.5 203.0.113.10"; export SHIM_LOCAL_IPS; lib; parse_args; detect_public_ip; echo "$PUBLIC_IP4" )
eq "$out" "203.0.113.10"
t "public IP: --public-ip wins"
out=$( lib; parse_args --public-ip 192.0.2.1; detect_public_ip; echo "$PUBLIC_IP4" )
eq "$out" "192.0.2.1"

sandbox dns-guide
t "dns guide: what to create, at Cloudflare, DNS only"
printf 'NS example.com aria.ns.cloudflare.com\nA anlyon.example.com 104.16.5.5\n' > "$SB/dns"
export SHIM_DNS="$SB/dns"
out=$( lib; parse_args --domain anlyon.example.com; address_for anlyon.example.com
       PUBLIC_IP4=203.0.113.10; PUBLIC_IP6=""; dns_evaluate; echo "status=$DNS_STATUS"; dns_instructions )
has "$out" "status=proxied"
has "$out" "proxied (orange cloud)"
has "$out" "A      anlyon"
has "$out" "203.0.113.10"
has "$out" "\"DNS only\" (grey cloud)"
has "$out" "https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-dns-records/"
has "$out" "https://developers.cloudflare.com/dns/proxy-status/"
hasnt "$out" "AAAA"

t "dns guide: another provider, AAAA offered, generic otherwise"
printf 'NS example.com ns-1.awsdns-01.org\n' > "$SB/dns"
out=$( lib; address_for anlyon.example.com; PUBLIC_IP4=203.0.113.10; PUBLIC_IP6=2001:db8::1; dns_evaluate; dns_instructions )
has "$out" "has no address record yet"
has "$out" "at AWS Route 53, in the zone example.com"
has "$out" "AAAA   anlyon"
has "$out" "https://docs.aws.amazon.com/Route53/"
printf 'NS example.org ns1.example-dns.net\n' > "$SB/dns"
out=$( lib; address_for example.org; PUBLIC_IP4=203.0.113.10; PUBLIC_IP6=""; dns_evaluate; dns_instructions )
has "$out" "A      @"
has "$out" "your DNS provider"
has "$out" "The nameservers are: ns1.example-dns.net"

t "dns guide: --yes stops with the instructions"
printf 'NS example.com ns1.digitalocean.com\n' > "$SB/dns"
out=$( lib; parse_args --domain anlyon.example.com --yes; address_for anlyon.example.com; PUBLIC_IP4=203.0.113.10; PUBLIC_IP6=""
       dns_evaluate; dns_guide 2>&1; echo "rc=$?" )
has "$out" "DNS for anlyon.example.com is not ready"
has "$out" "https://docs.digitalocean.com/products/networking/dns/how-to/manage-records/"
hasnt "$out" "rc=0"

t "dns guide: --yes --allow-ip-fallback continues on the IP"
out=$( lib; parse_args --domain anlyon.example.com --yes --allow-ip-fallback; address_for anlyon.example.com
       PUBLIC_IP4=203.0.113.10; PUBLIC_IP6=""; dns_evaluate; dns_guide >/dev/null 2>&1; echo "$PUBLIC_URL|$IS_HOSTNAME" )
eq "$out" "http://203.0.113.10:8080|0"

t "dns wait: s skips, q quits, a timeout gives up"
wait_with() {
  printf "$1" > "$SB/tty"
  ( ANLYON_TTY="$SB/tty"; ANLYON_DNS_INTERVAL=3; ANLYON_DNS_WAIT=${2:-30}; lib; parse_args
    address_for anlyon.example.com; PUBLIC_IP4=203.0.113.10; PUBLIC_IP6=""; open_tty; dns_wait >/dev/null 2>&1; echo $? )
}
eq "$(wait_with 's\n')" 2 "skip"
eq "$(wait_with '\nq\n')" 3 "quit after a re-check"
eq "$(wait_with '' 0)" 1 "timeout"

t "dns wait: ready once the record appears"
printf 'A anlyon.example.com 203.0.113.10\n' > "$SB/dns-later"
out=$( SHIM_DNS_LATER="$SB/dns-later"; SHIM_DNS_SWITCH_AFTER=2; export SHIM_DNS_LATER SHIM_DNS_SWITCH_AFTER; rm -f "$SB/state/dig-a.count"
       printf '\n\n\n\n' > "$SB/tty"; ANLYON_TTY="$SB/tty"; ANLYON_DNS_INTERVAL=5; lib; parse_args
       address_for anlyon.example.com; PUBLIC_IP4=203.0.113.10; PUBLIC_IP6=""; open_tty; dns_wait 2>/dev/null; echo "rc=$?" )
has "$out" "now points at this server"
has "$out" "rc=0"

sandbox cloudflare
TOKEN=not-a-real-cloudflare-token-xxxxxxxx
ZONE_ID=0123456789abcdef0123456789abcdef
REC_ID=fedcba9876543210fedcba9876543210
printf '{"result":[{"id":"%s","name":"example.com","account":{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}],"success":true,"errors":[]}' "$ZONE_ID" > "$SB/zones.json"
printf '{"result":[],"success":true,"errors":[]}' > "$SB/none.json"
printf '{"result":[{"id":"%s","zone_id":"%s","name":"anlyon.example.com","type":"A","content":"104.16.5.5","proxied":true}],"success":true}' "$REC_ID" "$ZONE_ID" > "$SB/one.json"
printf '{"result":{"id":"%s"},"success":true,"errors":[]}' "$REC_ID" > "$SB/saved.json"
printf '{"success":false,"errors":[{"code":9109,"message":"Invalid access token"}]}' > "$SB/denied.json"

t "cloudflare: creates the record, DNS only, token only on stdin"
printf 'GET /zones?name=example.com %s\nGET /dns_records?type=A %s\nPOST /dns_records %s\n' "$SB/zones.json" "$SB/none.json" "$SB/saved.json" > "$SB/http"
export SHIM_HTTP="$SB/http"
out=$( lib; cloudflare_upsert_a "$TOKEN" example.com anlyon.example.com 203.0.113.10 2>&1; echo "rc=$?" )
has "$out" "rc=0"
has "$out" "Saved: A anlyon.example.com -> 203.0.113.10, DNS only."
calls=$(cat "$SHIM_LOG")
has "$calls" "POST https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records auth=yes"
has "$calls" '"proxied":false'
has "$calls" '"ttl":1'
hasnt "$calls" "$TOKEN" "token in a command line"
if grep -rqF "$TOKEN" "$SB" 2>/dev/null; then bad "token written to disk"; else ok; fi

t "cloudflare: updates an existing (proxied) record"
: > "$SHIM_LOG"
printf 'GET /zones?name=example.com %s\nGET /dns_records?type=A %s\nPUT /dns_records/%s %s\n' "$SB/zones.json" "$SB/one.json" "$REC_ID" "$SB/saved.json" > "$SB/http"
out=$( lib; cloudflare_upsert_a "$TOKEN" example.com anlyon.example.com 203.0.113.10 2>&1; echo "rc=$?" )
has "$out" "rc=0"
has "$(cat "$SHIM_LOG")" "PUT https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records/$REC_ID"

t "cloudflare: a refused token changes nothing"
: > "$SHIM_LOG"
printf 'GET /zones?name= %s\n' "$SB/denied.json" > "$SB/http"
out=$( lib; cloudflare_upsert_a "$TOKEN" example.com anlyon.example.com 203.0.113.10 2>&1; echo "rc=$?" )
has "$out" "Invalid access token"
has "$out" "rc=1"
hasnt "$(cat "$SHIM_LOG")" "POST"

t "cloudflare: asked on a terminal, token read hidden and forgotten"
printf 'GET /zones?name=example.com %s\nGET /dns_records?type=A %s\nPOST /dns_records %s\n' "$SB/zones.json" "$SB/none.json" "$SB/saved.json" > "$SB/http"
printf 'y\n%s\n' "$TOKEN" > "$SB/tty"
out=$( ANLYON_TTY="$SB/tty"; lib; parse_args; open_tty; HOST=anlyon.example.com; DNS_ZONE=example.com; PUBLIC_IP4=203.0.113.10
       cloudflare_offer 2>&1; echo "rc=$? left=[$co_token]" )
has "$out" "Edit zone DNS"
has "$out" "rc=0 left=[]"
hasnt "$out" "$TOKEN"

INSTALL_FLAGS="--yes --from-dir $REPO_ROOT --no-cli --timeout 2"

sandbox install
t "install: from a checkout, building here, on localhost"
run install $INSTALL_FLAGS --domain localhost
eq "$RC" 0 "exit status"
has "$OUT" "Preflight · nothing has changed yet"
has "$OUT" "Create $ANLYON_DIR for the install? yes (--yes)"
has "$OUT" "Anlyon is ready."
has "$OUT" "http://localhost:8080/setup#token="
has "$OUT" "sudo grep ANLYON_ROOT_KEY $ANLYON_DIR/.env"
[ -f "$ANLYON_DIR/.env" ] && ok || bad ".env written"
ROOT_KEY=$(sed -n 's/^ANLYON_ROOT_KEY=//p' "$ANLYON_DIR/.env")
eq "${#ROOT_KEY}" 43 "root key length"
hasnt "$OUT" "$ROOT_KEY" "root key printed"
if [ -z "${MSYSTEM:-}" ]; then
  eq "$(ls -l "$ANLYON_DIR/.env" | cut -c1-10)" "-rw-------" ".env mode"
fi
for f in docker-compose.yml Caddyfile .env.example install.sh bootstrap.sh docker-compose.override.yml anlyon-selfhost.state; do
  [ -f "$ANLYON_DIR/$f" ] && ok || bad "$f installed"
done
sha=$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD)
override=$(cat "$ANLYON_DIR/docker-compose.override.yml")
has "$override" "image: anlyon-server:src-$sha"
has "$override" "image: anlyon-dashboard:src-$sha"
has "$override" "context: $REPO_ROOT"
has "$(cat "$ANLYON_DIR/anlyon-selfhost.state")" "IMAGES=build"
calls=$(cat "$SHIM_LOG")
has "$calls" "docker compose build server dashboard"
has "$calls" "docker compose up -d --no-build --remove-orphans"
hasnt "$calls" "apt-get" "nothing installed"
hasnt "$calls" "ufw allow" "firewall untouched"
hasnt "$calls" "usermod" "docker group untouched under --yes"
ENV_SUM=$(cksum < "$ANLYON_DIR/.env")

t "install again: detected, nothing changed"
: > "$SHIM_LOG"
run install $INSTALL_FLAGS --domain localhost
eq "$RC" 0
has "$OUT" "already installed"
has "$OUT" "Nothing was changed"
eq "$(cksum < "$ANLYON_DIR/.env")" "$ENV_SUM" ".env untouched"
eq "$(cat "$SHIM_LOG")" "" "no docker calls"

t "install again with --upgrade: backup first, .env kept"
run install $INSTALL_FLAGS --upgrade
eq "$RC" 0
has "$OUT" "Backup first"
has "$OUT" "Upgraded to anlyon-server:src-$sha"
eq "$(cksum < "$ANLYON_DIR/.env")" "$ENV_SUM" ".env untouched by upgrade"
n=$(find "$ANLYON_DIR/backups" -name 'anlyon-*.tar.gz' | wc -l | tr -d ' ')
eq "$n" 1 "one backup"
b=$(find "$ANLYON_DIR/backups" -name 'anlyon-*.tar.gz' | head -n 1)
eq "$(tar -tzf "$b" | sort | tr '\n' ' ')" "data.tar database.dump env meta " "backup contents"
[ -d "$ANLYON_DIR/.rollback" ] && bad "rollback snapshot left behind" || ok

t "install.sh refuses to replace .env"
out=$(sh "$ANLYON_DIR/install.sh" --domain localhost --yes --write-only 2>&1); rc=$?
eq "$rc" 2; has "$out" "already exists. Nothing was changed."
eq "$(cksum < "$ANLYON_DIR/.env")" "$ENV_SUM" ".env untouched by install.sh"

t "install.sh: an IP address needs --allow-http, and says telemetry is on"
ip_dir="$SB/ip-install"; mkdir -p "$ip_dir"
cp "$here/../install.sh" "$here/../.env.example" "$ip_dir/"
out=$(sh "$ip_dir/install.sh" --domain 203.0.113.7 --yes --write-only 2>&1); rc=$?
eq "$rc" 2 "an IP without --allow-http is refused"
has "$out" "pass --allow-http" "the refusal names the flag"
if [ -e "$ip_dir/.env" ]; then bad "a refused install wrote .env"; else ok; fi
out=$(sh "$ip_dir/install.sh" --domain 203.0.113.7 --yes --allow-http 2>&1); rc=$?
eq "$rc" 0 "an IP with --allow-http installs"
has "$out" "served over plain HTTP" "and still warns"
has "$out" "ANLYON_TELEMETRY=off" "the installer says how to turn telemetry off"

t "an install that stopped part way is resumed, keeping its .env"
sandbox partial
mkdir -p "$ANLYON_DIR"; printf 'ANLYON_ROOT_KEY=keep-me\n' > "$ANLYON_DIR/.env"
run install $INSTALL_FLAGS --domain localhost
has "$OUT" "did not finish"
eq "$(cat "$ANLYON_DIR/.env")" "ANLYON_ROOT_KEY=keep-me"
grep -q '^COMPLETED_AT=' "$ANLYON_DIR/anlyon-selfhost.state"; eq "$?" 0 "resume records completion"
t "once completed, a re-run changes nothing"
run install $INSTALL_FLAGS --domain localhost
has "$OUT" "already installed"
eq "$(cat "$ANLYON_DIR/.env")" "ANLYON_ROOT_KEY=keep-me"

sandbox backups
t "backup: retention keeps the newest N, and their keys"
run install $INSTALL_FLAGS --domain localhost >/dev/null
for i in 1 2 3; do run backup --keep 2; done
eq "$RC" 0
n=$(find "$ANLYON_DIR/backups" -name 'anlyon-*.tar.gz' | wc -l | tr -d ' ')
eq "$n" 2 "two kept"
n=$(find "$ANLYON_DIR/backup-keys" -name 'anlyon-*.keys' | wc -l | tr -d ' ')
eq "$n" 2 "two keys files kept"
for kf in "$ANLYON_DIR"/backup-keys/*.keys; do
  [ -f "$ANLYON_DIR/backups/$(basename "$kf" .keys).tar.gz" ] && ok || bad "keys file without its archive: $kf"
done
has "$OUT" "Removed old backup"

t "backup: the root key is in its own owner-only file, never in the archive"
ROOT_KEY=$(sed -n 's/^ANLYON_ROOT_KEY=//p' "$ANLYON_DIR/.env")
eq "${#ROOT_KEY}" 43 "root key length"
run backup
eq "$RC" 0
b=$(printf '%s\n' "$OUT" | sed -n 's/^.*Backup: //p' | tail -n 1)
[ -f "$b" ] && ok || bad "the backup it named: $b"
k="$ANLYON_DIR/backup-keys/$(basename "$b" .tar.gz).keys"
[ -f "$k" ] && ok || bad "keys file written beside the archive's name"
has "$OUT" "Keys:   $k"
has "$OUT" "never in the archive"
hasnt "$OUT" "$ROOT_KEY" "root key printed"
eq "$(grep -c "^ANLYON_ROOT_KEY=$ROOT_KEY\$" "$k")" 1 "root key in the keys file"
if tar -xzOf "$b" | grep -qF "$ROOT_KEY"; then bad "root key inside the archive"; else ok; fi
mkdir -p "$SB/look"; tar -C "$SB/look" -xzf "$b"
hasnt "$(cat "$SB/look/env")" "ANLYON_ROOT_KEY" "archive env without the key"
has "$(cat "$SB/look/env")" "ANLYON_PUBLIC_URL=" "archive env keeps the settings"
has "$(cat "$SB/look/meta")" "keys=$(basename "$k")"
has "$(cat "$SB/look/meta")" "keys_sha256="
if [ -z "${MSYSTEM:-}" ]; then
  eq "$(ls -l "$k" | cut -c1-10)" "-rw-------" "keys file mode"
  eq "$(ls -ld "$ANLYON_DIR/backup-keys" | cut -c1-10)" "drwx------" "keys directory mode"
  eq "$(ls -l "$b" | cut -c1-10)" "-rw-------" "archive mode"
fi

t "backup: retired master keys, and key lines written with spaces or quotes, stay out of the archive"
cp "$ANLYON_DIR/.env" "$SB/env.before"
printf 'SECRET_RETIRED_MASTER_KEYS=retired-key-xxxxxxxxxxxxxxxxxxxxxxxx\n"CONNECTIONS_ENCRYPTION_KEY" = quoted-key-xxxxxxxxxxxxxxxxxxxx\n' >> "$ANLYON_DIR/.env"
run backup
eq "$RC" 0
b2=$(printf '%s\n' "$OUT" | sed -n 's/^.*Backup: //p' | tail -n 1)
k2="$ANLYON_DIR/backup-keys/$(basename "$b2" .tar.gz).keys"
if tar -xzOf "$b2" | grep -qE "retired-key-|quoted-key-"; then bad "a key inside the archive"; else ok; fi
has "$(cat "$k2")" "SECRET_RETIRED_MASTER_KEYS=retired-key-xxxxxxxxxxxxxxxxxxxxxxxx"
has "$(cat "$k2")" "quoted-key-xxxxxxxxxxxxxxxxxxxx"
mv "$SB/env.before" "$ANLYON_DIR/.env"
rm -f "$b2" "$k2"

t "backup: includes the anlyon_data volume"
has "$(cat "$SHIM_LOG")" "docker compose run --rm --no-deps -T server tar -C /app/data -cf - ."
has "$(tar -tf "$SB/look/data.tar")" "storage/archive.txt"
grep -q 'anlyon_data:/app/data' "$here/../docker-compose.yml" && ok || bad "the volume the backup reads is the server's /app/data"

t "backup: a failed copy of the files writes nothing"
before=$(find "$ANLYON_DIR/backups" "$ANLYON_DIR/backup-keys" -type f | wc -l | tr -d ' ')
export SHIM_DATA_FAIL=1; run backup; unset SHIM_DATA_FAIL
eq "$RC" 1
has "$OUT" "Could not copy the anlyon_data volume; no backup was written."
eq "$(find "$ANLYON_DIR/backups" "$ANLYON_DIR/backup-keys" -type f | wc -l | tr -d ' ')" "$before" "no files left behind"

t "restore: refuses a backup made under another root key, and names its keys file"
mkdir -p "$SB/other"; tar -C "$SB/other" -xzf "$b"
sed 's/^keys_sha256=.*/keys_sha256=another-install/' "$SB/other/meta" > "$SB/other/meta2"; mv "$SB/other/meta2" "$SB/other/meta"
tar -C "$SB/other" -czf "$SB/foreign.tar.gz" database.dump data.tar env meta
: > "$SHIM_LOG"
run restore "$SB/foreign.tar.gz" --yes
eq "$RC" 1
has "$OUT" "different root key"
has "$OUT" "Its keys are in $(basename "$k")"
hasnt "$(cat "$SHIM_LOG")" "pg_restore"
hasnt "$OUT" "$ROOT_KEY" "key printed"

t "restore: a backup from before the keys left the archive is still checked"
mkdir -p "$SB/old"; cp "$SB/look/database.dump" "$SB/old/"
cp "$ANLYON_DIR/.env" "$SB/old/env"
printf 'created=2026-10-01T00:00:00Z\nserver_image=x\nref=main\nversion=\n' > "$SB/old/meta"
tar -C "$SB/old" -czf "$SB/old-same.tar.gz" database.dump env meta
sed 's/^ANLYON_ROOT_KEY=.*/ANLYON_ROOT_KEY=a-different-key/' "$SB/old/env" > "$SB/old/env2"; mv "$SB/old/env2" "$SB/old/env"
tar -C "$SB/old" -czf "$SB/old-foreign.tar.gz" database.dump env meta
: > "$SHIM_LOG"
run restore "$SB/old-foreign.tar.gz" --yes
eq "$RC" 1
has "$OUT" "different root key"
hasnt "$OUT" "a-different-key" "key printed"
hasnt "$(cat "$SHIM_LOG")" "pg_restore"
: > "$SHIM_LOG"
run restore "$SB/old-same.tar.gz" --yes
eq "$RC" 0
has "$OUT" "This backup has no copy of the server's files (anlyon_data); they are left as they are."
has "$(cat "$SHIM_LOG")" "pg_restore"
hasnt "$(cat "$SHIM_LOG")" "server sh -c" "no files restored from a backup without them"

t "restore: same key, confirmed by typing, database and files"
printf 'restore\n' > "$SB/tty"
: > "$SHIM_LOG"; rm -f "$SHIM_STATE/restored-data.tar"
export ANLYON_TTY="$SB/tty"; run restore "$b"
eq "$RC" 0
has "$OUT" "Restored from"
has "$OUT" "The server's files (anlyon_data) are replaced by the backup's too."
has "$(cat "$SHIM_LOG")" "pg_restore"
has "$(cat "$SHIM_LOG")" "docker compose run --rm --no-deps -T server sh -c find /app/data -mindepth 1 -delete && tar -C /app/data -xf -"
cmp -s "$SHIM_STATE/restored-data.tar" "$SB/look/data.tar" && ok || bad "the backup's data.tar is what was restored"

t "restore: a wrong word changes nothing"
printf 'yes\n' > "$SB/tty"
: > "$SHIM_LOG"
export ANLYON_TTY="$SB/tty"; run restore "$b"
eq "$RC" 1
hasnt "$(cat "$SHIM_LOG")" "pg_restore"
export ANLYON_TTY="$SB/no-tty"

t "schedule: neither systemd nor cron here, nothing changes"
run backup --schedule daily
eq "$RC" 1
has "$OUT" "Neither systemd nor cron"

t "schedule: a systemd timer, daily, with retention"
mkdir -p "$ANLYON_SYSTEMD_RUN" "$ANLYON_SYSTEMD_DIR"
: > "$SHIM_LOG"
run backup --schedule daily --at 02:45 --keep 5
eq "$RC" 0
has "$OUT" "Backups scheduled: daily at 02:45 (server time), keeping the last 5"
timer=$(cat "$ANLYON_SYSTEMD_DIR/anlyon-backup.timer")
service=$(cat "$ANLYON_SYSTEMD_DIR/anlyon-backup.service")
has "$timer" "OnCalendar=*-*-* 02:45:00"
has "$timer" "Persistent=true"
has "$service" "ExecStart=/bin/sh $ANLYON_DIR/bootstrap.sh backup --yes --keep 5 --dir $ANLYON_DIR"
has "$service" "Type=oneshot"
calls=$(cat "$SHIM_LOG")
has "$calls" "systemctl daemon-reload"
has "$calls" "systemctl enable --now anlyon-backup.timer"
run status
has "$OUT" "Schedule: daily at 02:45, keeping 5 (systemd)"
has "$OUT" "Keys:     $ANLYON_DIR/backup-keys/"

t "schedule: weekly replaces daily; off removes it"
run backup --schedule weekly --at 23:05
has "$(cat "$ANLYON_SYSTEMD_DIR/anlyon-backup.timer")" "OnCalendar=Sun *-*-* 23:05:00"
: > "$SHIM_LOG"
run backup --schedule off
eq "$RC" 0
has "$OUT" "Scheduled backups are off"
[ -e "$ANLYON_SYSTEMD_DIR/anlyon-backup.timer" ] && bad "timer left" || ok
[ -e "$ANLYON_SYSTEMD_DIR/anlyon-backup.service" ] && bad "service left" || ok
has "$(cat "$SHIM_LOG")" "systemctl disable --now anlyon-backup.timer"
run status
has "$OUT" "Schedule: none"
run backup --schedule off
has "$OUT" "No scheduled backups were set up"

t "schedule: a cron entry where systemd does not run, and the job it runs works"
rmdir "$ANLYON_SYSTEMD_RUN"; mkdir -p "$ANLYON_CRON_DIR"
mv "$ANLYON_DIR/backups" "$ANLYON_DIR/backups.kept"
run backup --schedule weekly --at 04:05
eq "$RC" 0
[ -d "$ANLYON_DIR/backups" ] && ok || bad "backups/ made for the scheduled job's log"
rmdir "$ANLYON_DIR/backups"; mv "$ANLYON_DIR/backups.kept" "$ANLYON_DIR/backups"
run backup --schedule weekly --at 04:05
eq "$RC" 0
cron=$(cat "$ANLYON_CRON_DIR/anlyon-backup")
has "$cron" "5 4 * * 0 root ANLYON_UI=plain /bin/sh $ANLYON_DIR/bootstrap.sh backup --yes --keep 7 --dir $ANLYON_DIR >> $ANLYON_DIR/backups/schedule.log 2>&1"
if [ -z "${MSYSTEM:-}" ]; then eq "$(ls -l "$ANLYON_CRON_DIR/anlyon-backup" | cut -c1-10)" "-rw-r--r--" "cron.d entry mode"; fi
run status
has "$OUT" "Schedule: weekly at 04:05, keeping 7 (cron)"
job=$(sed -n 's/^5 4 \* \* 0 root //p' "$ANLYON_CRON_DIR/anlyon-backup")
before=$(find "$ANLYON_DIR/backups" -name 'anlyon-*.tar.gz' | wc -l | tr -d ' ')
sh -c "$job"; eq "$?" 0 "the scheduled job"
after=$(find "$ANLYON_DIR/backups" -name 'anlyon-*.tar.gz' | wc -l | tr -d ' ')
eq "$after" "$((before + 1))" "the scheduled job wrote a backup"
has "$(cat "$ANLYON_DIR/backups/schedule.log")" "Keys:"
hasnt "$(cat "$ANLYON_DIR/backups/schedule.log")" "$ROOT_KEY" "root key in the schedule log"

t "schedule: offered after an install at a terminal"
printf 'y\n' > "$SB/tty"
out=$( ANLYON_TTY="$SB/tty"; lib; parse_args; ui_init; open_tty; remove_backup_schedule; offer_backup_schedule 2>&1 )
has "$out" "Back up every day at 03:17 (server time), keeping the last 7?"
has "$(cat "$ANLYON_CRON_DIR/anlyon-backup")" "17 3 * * * root"
t "schedule: not offered again once one is set up"
out=$( ANLYON_TTY="$SB/tty"; lib; parse_args; ui_init; open_tty; offer_backup_schedule 2>&1 )
hasnt "$out" "Back up every day"

t "uninstall: removes the schedule, keeps the backups and keys"
run uninstall --yes
eq "$RC" 0
has "$OUT" "Removed the scheduled backups"
[ -e "$ANLYON_CRON_DIR/anlyon-backup" ] && bad "cron entry left" || ok
[ -f "$k" ] && ok || bad "keys kept"
[ -f "$b" ] && ok || bad "backups kept"

sandbox schedule-install
t "install --yes: no schedule unless asked for"
mkdir -p "$ANLYON_CRON_DIR"
run install $INSTALL_FLAGS --domain localhost
eq "$RC" 0
has "$OUT" "Scheduled backups are off. To turn them on: anlyon-selfhost backup --schedule daily"
[ -e "$ANLYON_CRON_DIR/anlyon-backup" ] && bad "scheduled without being asked" || ok
sandbox schedule-install-on
t "install --yes --backup-schedule daily: scheduled"
mkdir -p "$ANLYON_CRON_DIR"
run install $INSTALL_FLAGS --domain localhost --backup-schedule daily --keep 14
eq "$RC" 0
has "$OUT" "Backups scheduled: daily at 03:17 (server time), keeping the last 14"
has "$(cat "$ANLYON_CRON_DIR/anlyon-backup")" "17 3 * * * root ANLYON_UI=plain /bin/sh $ANLYON_DIR/bootstrap.sh backup --yes --keep 14 --dir $ANLYON_DIR"

sandbox upgrade
t "upgrade: a release that does not come up goes back to the previous images"
run install --yes --from-dir "$REPO_ROOT" --no-cli --timeout 1 --images ghcr --version 1.0.0 --domain localhost
eq "$RC" 0 "install 1.0.0"
has "$(cat "$ANLYON_DIR/docker-compose.override.yml")" "ghcr.io/anlyonhq/anlyon-server:1.0.0"
hasnt "$(cat "$ANLYON_DIR/docker-compose.override.yml")" "build:"
export SHIM_BAD_IMAGE=1.1.0; run upgrade --yes --version 1.1.0 --from-dir "$REPO_ROOT" --timeout 1; unset SHIM_BAD_IMAGE
eq "$RC" 1
has "$OUT" "Going back to the previous images"
has "$OUT" "The previous version is running again"
has "$OUT" "anlyon-selfhost restore $ANLYON_DIR/backups/anlyon-"
has "$(cat "$ANLYON_DIR/docker-compose.override.yml")" "anlyon-server:1.0.0"
has "$(cat "$ANLYON_DIR/anlyon-selfhost.state")" "VERSION=1.0.0"
t "upgrade: a good release"
run upgrade --yes --version 1.1.0 --from-dir "$REPO_ROOT" --timeout 1
eq "$RC" 0
has "$(cat "$ANLYON_DIR/anlyon-selfhost.state")" "PREVIOUS_SERVER_IMAGE=ghcr.io/anlyonhq/anlyon-server:1.0.0"

sandbox notready
t "install: a server that never gets ready shows its last 50 log lines"
export SHIM_READY_RC=1
run install $INSTALL_FLAGS --domain localhost --timeout 1
eq "$RC" 1
has "$OUT" "The server did not report ready. The last 50 lines of its log:"
has "$(cat "$SHIM_LOG")" "docker compose logs --no-color --tail 50 server"
hasnt "$OUT" "Anlyon is ready."
t "status and logs"
unset SHIM_READY_RC
run status
eq "$RC" 0
has "$OUT" "Address:  http://localhost:8080"
has "$OUT" "Ready:    yes"
has "$OUT" "Backups:  none"
: > "$SHIM_LOG"
run logs caddy -f --tail 20
has "$(cat "$SHIM_LOG")" "docker compose logs --tail 20 -f caddy"
run logs nginx
eq "$RC" 2

sandbox uninstall
run install $INSTALL_FLAGS --domain localhost >/dev/null
t "uninstall: keeps the data"
: > "$SHIM_LOG"
run uninstall --yes
eq "$RC" 0
has "$(cat "$SHIM_LOG")" "docker compose down --remove-orphans"
[ -f "$ANLYON_DIR/.env" ] && ok || bad ".env kept"
t "uninstall --purge: needs the word"
printf 'no\n' > "$SB/tty"
export ANLYON_TTY="$SB/tty"; run uninstall --purge
eq "$RC" 1
[ -f "$ANLYON_DIR/.env" ] && ok || bad "kept without the word"
printf 'purge\n' > "$SB/tty"
export ANLYON_TTY="$SB/tty"; run uninstall --purge
eq "$RC" 0
[ -e "$ANLYON_DIR" ] && bad "directory removed" || ok
has "$(cat "$SHIM_LOG")" "docker compose down --volumes --rmi all"

sandbox interactive
t "install: every change asked; declining Docker stops before anything else"
export SHIM_DOCKER_VERSION=""
printf 'n\n' > "$SB/tty"
export ANLYON_TTY="$SB/tty"; run install --from-dir "$REPO_ROOT" --no-cli --domain localhost
eq "$RC" 1
has "$OUT" "Start the Docker engine now and at boot"
[ -e "$ANLYON_DIR" ] && bad "directory created after a no" || ok
hasnt "$(cat "$SHIM_LOG")" "systemctl"

t "install: no terminal and no --yes stops at the first question"
export ANLYON_TTY="$SB/none"; run install --from-dir "$REPO_ROOT" --no-cli --domain localhost
eq "$RC" 1
has "$OUT" "No terminal to ask on"

sandbox ufw
t "install: ufw on: only the two ports, after asking"
export SHIM_UFW=active
run install $INSTALL_FLAGS --domain localhost
calls=$(cat "$SHIM_LOG")
has "$calls" "ufw allow 8080/tcp comment Anlyon"
has "$calls" "ufw allow 8443/tcp comment Anlyon"
hasnt "$calls" "ufw enable"
hasnt "$calls" "ssh"

sandbox raw
t "install: published images, files from a private repository with GITHUB_TOKEN"
: > "$SB/http"
for f in docker-compose.yml Caddyfile .env.example install.sh bootstrap.sh; do
  printf 'GET raw.githubusercontent.com/me/private/v1.2.0/deploy/self-host/%s %s\n' "$f" "$here/../$f" >> "$SB/http"
done
export SHIM_HTTP="$SB/http" GITHUB_TOKEN=not-a-real-github-token-xxxxxxxx
run install --yes --no-cli --timeout 1 --images ghcr --version 1.2.0 --repo me/private --domain localhost
eq "$RC" 0
calls=$(cat "$SHIM_LOG")
has "$calls" "GET https://raw.githubusercontent.com/me/private/v1.2.0/deploy/self-host/docker-compose.yml auth=yes"
has "$calls" "docker compose pull --quiet"
hasnt "$calls" "compose build"
hasnt "$calls" "$GITHUB_TOKEN" "token on a command line"
if grep -rqF "$GITHUB_TOKEN" "$SB" --exclude=calls.log 2>/dev/null; then bad "token written to disk"; else ok; fi
has "$(cat "$ANLYON_DIR/docker-compose.override.yml")" "ghcr.io/anlyonhq/anlyon-dashboard:1.2.0"
[ -e "$ANLYON_DIR/.staging" ] && bad "staging left behind" || ok
unset GITHUB_TOKEN

sandbox git
t "install: --source clones a ref and builds from it"
G="$SB/repo"; mkdir -p "$G/deploy/self-host"
cp "$here/../docker-compose.yml" "$here/../Caddyfile" "$here/../.env.example" "$here/../install.sh" "$here/../bootstrap.sh" "$G/deploy/self-host/"
git -C "$G" init -q -b release 2>/dev/null || { git -C "$G" init -q && git -C "$G" checkout -q -b release; }
git -C "$G" add -A && git -C "$G" -c user.email=t@example.com -c user.name=t commit -qm one
gsha=$(git -C "$G" rev-parse --short=12 HEAD)
run install --yes --no-cli --timeout 1 --source "file://$G" --ref release --domain localhost
eq "$RC" 0
eq "$(git -C "$ANLYON_DIR/src" rev-parse --short=12 HEAD)" "$gsha" "checked-out commit"
has "$(cat "$ANLYON_DIR/docker-compose.override.yml")" "context: $ANLYON_DIR/src"
has "$(cat "$ANLYON_DIR/anlyon-selfhost.state")" "SOURCE=file://$G"

sandbox swap
t "install: 2 GB of memory: swap only after a yes, and --no-swap declines it"
export SHIM_MEM_MB=2000
run install $INSTALL_FLAGS --domain localhost --no-swap
has "$OUT" "no swap added (--no-swap)"
hasnt "$(cat "$SHIM_LOG")" "mkswap"
sandbox swap2
export SHIM_MEM_MB=2000
run install $INSTALL_FLAGS --domain localhost
eq "$RC" 0
has "$(cat "$SHIM_LOG")" "fallocate -l 3G $ANLYON_SWAPFILE"
has "$(cat "$SHIM_LOG")" "swapon $ANLYON_SWAPFILE"
eq "$(cat "$ANLYON_FSTAB")" "$ANLYON_SWAPFILE none swap sw 0 0" "fstab line"

sandbox domain
t "install: a domain not pointed here stops a --yes run before any change"
printf 'NS example.com aria.ns.cloudflare.com\n' > "$SB/dns"
export SHIM_DNS="$SB/dns"
run install $INSTALL_FLAGS --domain anlyon.example.com --public-ip 203.0.113.10
eq "$RC" 1
has "$OUT" "DNS for anlyon.example.com is not ready"
[ -e "$ANLYON_DIR" ] && bad "directory created" || ok

t "install: a domain pointed here installs with HTTPS"
printf 'NS example.com aria.ns.cloudflare.com\nA anlyon.example.com 203.0.113.10\n' > "$SB/dns"
run install $INSTALL_FLAGS --domain anlyon.example.com --public-ip 203.0.113.10
has "$OUT" "✓ DNS          anlyon.example.com -> 203.0.113.10 (this server)"
has "$OUT" "https://anlyon.example.com/setup#token="
has "$(cat "$ANLYON_DIR/.env")" "SITE_ADDRESS=anlyon.example.com"
has "$OUT" "https://docs.hetzner.com/cloud/firewalls/getting-started/creating-a-firewall/"

ESC=$(printf '\033'); CR=$(printf '\r')
no_ansi() {
  hasnt "$1" "$ESC" "$2: colour codes"
  hasnt "$1" "$CR" "$2: carriage returns"
  for frame in '⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏'; do hasnt "$1" "$frame" "$2: spinner frame"; done
}

t "rendering: when the output is fancy"
ui_mode() {
  # shellcheck disable=SC2317
  ( lib; for a in "$@"; do export "${a?}"; done; parse_args; ui_is_tty() { return 0; }; ui_init; echo "$UI_FANCY" )
}
eq "$(TERM=xterm-256color ui_mode)" 1 "a terminal"
eq "$(TERM=xterm-256color ui_mode NO_COLOR=1)" 0 "NO_COLOR"
eq "$(TERM=xterm-256color ui_mode NO_COLOR=)" 0 "NO_COLOR, empty"
eq "$(ui_mode TERM=dumb)" 0 "TERM=dumb"
# shellcheck disable=SC2317
eq "$( ( lib; TERM=xterm; export TERM; parse_args --yes; ui_is_tty() { return 0; }; ui_init; echo "$UI_FANCY" ) )" 0 "--yes"
eq "$( ( lib; TERM=xterm; export TERM; parse_args; ui_init; echo "$UI_FANCY" ) )" 0 "not a terminal"
eq "$(TERM=dumb ui_mode ANLYON_UI=fancy)" 1 "ANLYON_UI=fancy"
eq "$(TERM=xterm ui_mode ANLYON_UI=plain)" 0 "ANLYON_UI=plain"

sandbox render-plain
t "rendering: a whole install off a terminal is plain lines"
run install $INSTALL_FLAGS --domain localhost
eq "$RC" 0
no_ansi "$OUT" "default"
has "$OUT" "  · Building images"
has "$OUT" "  ✓ Built the images (src-"
has "$OUT" "  ✓ Server ready"
sandbox render-nocolor
OUT=$(NO_COLOR=1 TERM=dumb ANLYON_BOOTSTRAP_LIB=0 sh "$SCRIPT" install $INSTALL_FLAGS --domain localhost 2>&1); RC=$?
eq "$RC" 0 "NO_COLOR and TERM=dumb"
no_ansi "$OUT" "NO_COLOR and TERM=dumb"
has "$OUT" "Anlyon is ready."

t "rendering: ASCII without a UTF-8 locale"
sandbox render-ascii
OUT=$(LANG=C LC_ALL=C ANLYON_BOOTSTRAP_LIB=0 sh "$SCRIPT" install $INSTALL_FLAGS --domain localhost 2>&1); RC=$?
eq "$RC" 0
has "$OUT" "  ok OS           Ubuntu"
hasnt "$OUT" "✓"

t "rendering: logs land in <dir>/logs, owner-only, without the secrets"
sandbox render-logs
run install $INSTALL_FLAGS --domain localhost
eq "$RC" 0
logs=$(find "$ANLYON_DIR/logs" -name 'install-*.log' 2>/dev/null)
eq "$(printf '%s\n' "$logs" | grep -c .)" 1 "one install log"
has "$OUT" "Log       $ANLYON_DIR/logs/install-"
has "$(cat "$logs")" "--- Building images"
if [ -z "${MSYSTEM:-}" ]; then
  eq "$(ls -ld "$ANLYON_DIR/logs" | cut -c1-10)" "drwx------" "logs directory mode"
  eq "$(ls -l "$logs" | cut -c1-10)" "-rw-------" "log mode"
fi
ROOT_KEY=$(sed -n 's/^ANLYON_ROOT_KEY=//p' "$ANLYON_DIR/.env")
SETUP_TOKEN=$(sed -n 's/^ANLYON_SETUP_TOKEN=//p' "$ANLYON_DIR/.env")
hasnt "$(cat "$logs")" "$ROOT_KEY" "root key in the log"
hasnt "$(cat "$logs")" "$SETUP_TOKEN" "setup token in the log"
hasnt "$OUT" "$ROOT_KEY" "root key printed"

sandbox render-fancy
t "rendering: ANLYON_UI=fancy draws colour and a redrawn step line"
OUT=$(ANLYON_UI=fancy ANLYON_BOOTSTRAP_LIB=0 sh "$SCRIPT" install $INSTALL_FLAGS --domain localhost 2>&1); RC=$?
eq "$RC" 0
has "$OUT" "${ESC}[32m✓${ESC}[0m"
has "$OUT" "$CR${ESC}[K"
has "$OUT" "${ESC}[1mAnlyon is ready.${ESC}[0m"

sandbox render-fail
t "rendering: a failing step shows the end of its log and where the whole log is"
export SHIM_BUILD_FAIL=1
run install $INSTALL_FLAGS --domain localhost
eq "$RC" 1
has "$OUT" "✗ Building images"
has "$OUT" "│ ERR_PNPM_FETCH_404 a package was not found"
has "$OUT" "Full log: $ANLYON_DIR/logs/install-"
hasnt "$OUT" "Anlyon is ready."
has "$(cat "$ANLYON_DIR"/logs/install-*.log)" "ERR_PNPM_FETCH_404"
unset SHIM_BUILD_FAIL

t "rendering: a long step's phase comes from its log"
( lib; PASS=0; FAIL=0; CMD=install; LOG_FILE="$WORK/phase.log"
  printf '%s Building images\n#5 [server internal] load build definition from Dockerfile\n' '---' > "$LOG_FILE"
  eq "$(phase_of build 0)" "server · resolving base images" "build, start"
  printf '#9 [dashboard deps 3/7] RUN pnpm install --frozen-lockfile\n' >> "$LOG_FILE"
  eq "$(phase_of build 0)" "dashboard · installing dependencies" "build, dependencies"
  printf '#14 exporting to image\n#14 naming to docker.io/library/anlyon-dashboard:src-1\n' >> "$LOG_FILE"
  eq "$(phase_of build 0)" "dashboard · exporting image" "build, export"
  printf 'Get:1 http://archive.ubuntu.com noble InRelease\n' > "$LOG_FILE"
  eq "$(phase_of apt 0)" "downloading packages" "apt, download"
  printf 'Unpacking docker-ce (5:27.3.1-1)\n' >> "$LOG_FILE"
  eq "$(phase_of apt 0)" "unpacking packages" "apt, unpack"
  printf 'Setting up docker-ce (5:27.3.1-1)\n' >> "$LOG_FILE"
  eq "$(phase_of apt 0)" "configuring packages" "apt, configure"
  printf '%s Starting containers\n' '---' > "$LOG_FILE"
  eq "$(phase_of up 0)" "" "the step header is not a phase"
  eq "$(fmt_elapsed 9) $(fmt_elapsed 75) $(fmt_elapsed 3600)" "9s 1:15 60:00" "elapsed"
  echo "$PASS $FAIL" > "$WORK/sub.counts" )
read -r sp sf < "$WORK/sub.counts"; PASS=$((PASS + sp)); FAIL=$((FAIL + sf))

sandbox render-dns
t "rendering: the DNS record is a box, ASCII without UTF-8"
printf 'NS example.com ns1.digitalocean.com\n' > "$SB/dns"
export SHIM_DNS="$SB/dns"
out=$( lib; address_for anlyon.example.com; PUBLIC_IP4=203.0.113.10; PUBLIC_IP6=""; dns_evaluate; dns_instructions )
has "$out" "┌──"
has "$out" "│ Type   Name    Value         TTL  │"
has "$out" "│ A      anlyon  203.0.113.10  Auto │"
has "$out" "└──"
no_ansi "$out" "dns box"
out=$( LANG=C LC_ALL=C; export LANG LC_ALL; lib; address_for anlyon.example.com; PUBLIC_IP4=203.0.113.10; PUBLIC_IP6=""; dns_evaluate; dns_instructions )
has "$out" "+---"
has "$out" "| A      anlyon  203.0.113.10  Auto |"

t "compose: every service restarts unless stopped"
services=$(awk '/^services:/{s=1;next} /^[a-z]/{s=0} s && /^  [a-z]+:$/{n++} END{print n}' "$here/../docker-compose.yml")
restarts=$(grep -c 'restart: unless-stopped' "$here/../docker-compose.yml")
eq "$restarts" "$services" "restart lines"

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
