#!/usr/bin/env bash
set -euo pipefail

# Generate one WireGuard client profile without key reuse.
# Use these profiles for public/untrusted Wi-Fi. The profile is a full tunnel:
# AllowedIPs = 0.0.0.0/0, ::/0, so all client traffic routes through the VPN.

WG_IFACE="${WG_IFACE:-wg0}"
WG_DIR="${WG_DIR:-/etc/wireguard}"
CLIENT_DIR="${CLIENT_DIR:-$WG_DIR/clients}"
CLIENT_DNS="${CLIENT_DNS:-1.1.1.1, 9.9.9.9}"
CLIENT_KEEPALIVE="${CLIENT_KEEPALIVE:-25}"
CLIENT_IPV4_PREFIX="${CLIENT_IPV4_PREFIX:-10.44.0}"
CLIENT_IPV6_PREFIX="${CLIENT_IPV6_PREFIX:-fd42:44:44::}"

die() {
    echo "ERROR: $*" >&2
    exit 1
}

need_root() {
    [[ "${EUID}" -eq 0 ]] || die "Run this script as root: sudo ./generate-client.sh <client-name> <endpoint-host-or-ip:port>"
}

clean_name() {
    local name="$1"
    [[ "$name" =~ ^[A-Za-z0-9._-]{1,32}$ ]] || die "Client name must be 1-32 chars: letters, numbers, dot, underscore, or hyphen."
    printf '%s' "$name"
}

validate_endpoint() {
    local endpoint="$1"
    [[ "$endpoint" =~ .+:[0-9]{1,5}$ ]] || die "Endpoint must look like vpn.example.com:51820 or 203.0.113.10:51820"
    local port="${endpoint##*:}"
    (( port >= 1 && port <= 65535 )) || die "Endpoint port is out of range: $port"
}

validate_client_prefixes() {
    [[ "$CLIENT_IPV4_PREFIX" =~ ^([0-9]{1,3}\.){2}[0-9]{1,3}$ ]] || die "CLIENT_IPV4_PREFIX must look like 10.44.0"
    python3 - "$CLIENT_IPV4_PREFIX" "$CLIENT_IPV6_PREFIX" <<'PY'
import ipaddress
import sys
try:
    ipaddress.ip_address(sys.argv[1] + ".2")
    ipaddress.ip_address(sys.argv[2] + "2")
except ValueError as exc:
    raise SystemExit(f"Invalid client address prefix: {exc}")
PY
}

next_client_index() {
    local used
    used="$(grep -hE 'AllowedIPs = '"$CLIENT_IPV4_PREFIX"'\.[0-9]+/32' "$WG_DIR/$WG_IFACE.conf" "$WG_DIR/$WG_IFACE.peers" 2>/dev/null | sed -E 's/.*\.([0-9]+)\/32.*/\1/' | sort -n || true)"
    for i in $(seq 2 254); do
        if ! grep -qx "$i" <<<"$used"; then
            echo "$i"
            return
        fi
    done
    die "No available client IPv4 addresses in ${CLIENT_IPV4_PREFIX}.0/24"
}

append_peer() {
    local client_name="$1"
    local public_key="$2"
    local ipv4="$3"
    local ipv6="$4"
    local peer_block
    peer_block="$(cat <<EOF

# Client: $client_name
[Peer]
PublicKey = $public_key
AllowedIPs = $ipv4/32, $ipv6/128
PersistentKeepalive = $CLIENT_KEEPALIVE
EOF
)"
    printf '%s\n' "$peer_block" >>"$WG_DIR/$WG_IFACE.peers"
    printf '%s\n' "$peer_block" >>"$WG_DIR/$WG_IFACE.conf"
    if systemctl is-active --quiet "wg-quick@$WG_IFACE"; then
        wg set "$WG_IFACE" peer "$public_key" allowed-ips "$ipv4/32,$ipv6/128" persistent-keepalive "$CLIENT_KEEPALIVE"
    fi
}

write_client_config() {
    local client_name="$1"
    local private_key="$2"
    local server_public_key="$3"
    local endpoint="$4"
    local ipv4="$5"
    local ipv6="$6"
    local conf="$CLIENT_DIR/$client_name.conf"

    cat >"$conf" <<EOF
# WireGuard profile for $client_name.
# Enable on public/untrusted Wi-Fi networks. On trusted home/work networks,
# leave it off unless you intentionally want all traffic to exit via this VPN.
[Interface]
PrivateKey = $private_key
Address = $ipv4/32, $ipv6/128
DNS = $CLIENT_DNS

[Peer]
PublicKey = $server_public_key
Endpoint = $endpoint
AllowedIPs = 0.0.0.0/0, ::/0
PersistentKeepalive = $CLIENT_KEEPALIVE
EOF
    chmod 600 "$conf"
    qrencode -t png -o "$CLIENT_DIR/$client_name.png" <"$conf"
    qrencode -t ansiutf8 <"$conf" >"$CLIENT_DIR/$client_name.qr.txt"
}

need_root
command -v wg >/dev/null || die "WireGuard tools are missing. Run setup-server.sh first."
command -v qrencode >/dev/null || die "qrencode is missing. Run setup-server.sh first."
command -v python3 >/dev/null || die "python3 is missing. Run setup-server.sh first."
[[ -f "$WG_DIR/server_public.key" ]] || die "Server public key missing at $WG_DIR/server_public.key"
[[ -f "$WG_DIR/$WG_IFACE.conf" ]] || die "WireGuard config missing at $WG_DIR/$WG_IFACE.conf"

CLIENT_NAME="$(clean_name "${1:-}")"
ENDPOINT="${2:-}"
[[ -n "$CLIENT_NAME" && -n "$ENDPOINT" ]] || die "Usage: sudo ./generate-client.sh <client-name> <endpoint-host-or-ip:port>"
validate_endpoint "$ENDPOINT"
validate_client_prefixes

mkdir -p "$CLIENT_DIR"
chmod 700 "$CLIENT_DIR"
[[ ! -e "$CLIENT_DIR/$CLIENT_NAME.conf" ]] || die "Client already exists: $CLIENT_DIR/$CLIENT_NAME.conf"

umask 077
CLIENT_PRIVATE_KEY="$(wg genkey)"
CLIENT_PUBLIC_KEY="$(printf '%s' "$CLIENT_PRIVATE_KEY" | wg pubkey)"
SERVER_PUBLIC_KEY="$(<"$WG_DIR/server_public.key")"
CLIENT_INDEX="$(next_client_index)"
CLIENT_IPV4="${CLIENT_IPV4_PREFIX}.${CLIENT_INDEX}"
CLIENT_IPV6="${CLIENT_IPV6_PREFIX}${CLIENT_INDEX}"

append_peer "$CLIENT_NAME" "$CLIENT_PUBLIC_KEY" "$CLIENT_IPV4" "$CLIENT_IPV6"
write_client_config "$CLIENT_NAME" "$CLIENT_PRIVATE_KEY" "$SERVER_PUBLIC_KEY" "$ENDPOINT" "$CLIENT_IPV4" "$CLIENT_IPV6"

echo
echo "Client generated: $CLIENT_NAME"
echo "Config file: $CLIENT_DIR/$CLIENT_NAME.conf"
echo "QR PNG: $CLIENT_DIR/$CLIENT_NAME.png"
echo "QR terminal text: $CLIENT_DIR/$CLIENT_NAME.qr.txt"
echo
echo "Import the .conf or scan the QR code with the WireGuard app."
