#!/usr/bin/env bash
set -euo pipefail

# WireGuard VPN server bootstrap for Ubuntu 22.04+.
# Crypto note:
# WireGuard's protocol suite is fixed and modern: ChaCha20-Poly1305 provides
# authenticated encryption so cafe/airport/hotel Wi-Fi observers cannot read or
# tamper with tunneled packets; Curve25519 gives fast ECDH key exchange;
# BLAKE2s is used for hashing; HKDF safely derives per-session keys. WireGuard
# also rotates session keys automatically, normally every two minutes.

WG_IFACE="${WG_IFACE:-wg0}"
WG_PORT="${WG_PORT:-51820}"
WG_DIR="${WG_DIR:-/etc/wireguard}"
WG_IPV4_CIDR="${WG_IPV4_CIDR:-10.44.0.1/24}"
WG_IPV6_CIDR="${WG_IPV6_CIDR:-fd42:44:44::1/64}"
SSH_PORT="${SSH_PORT:-22}"
ENDPOINT_HOST="${ENDPOINT_HOST:-}"
CLIENT_KEEPALIVE="${CLIENT_KEEPALIVE:-25}"

die() {
    echo "ERROR: $*" >&2
    exit 1
}

need_root() {
    [[ "${EUID}" -eq 0 ]] || die "Run this script as root: sudo ./setup-server.sh"
}

validate_port() {
    local port="$1"
    [[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1 && port <= 65535 )) || die "Invalid UDP port: $port"
}

validate_cidr() {
    local cidr="$1"
    python3 - "$cidr" <<'PY'
import ipaddress
import sys
try:
    ipaddress.ip_interface(sys.argv[1])
except ValueError as exc:
    raise SystemExit(f"Invalid CIDR {sys.argv[1]!r}: {exc}")
PY
}

default_iface() {
    ip route show default 0.0.0.0/0 | awk '{print $5; exit}'
}

detect_endpoint() {
    local detected=""
    detected="$(curl -fsS4 --max-time 5 https://ifconfig.me 2>/dev/null || true)"
    if [[ -z "$detected" ]]; then
        detected="$(curl -fsS4 --max-time 5 https://api.ipify.org 2>/dev/null || true)"
    fi
    printf '%s' "$detected"
}

install_packages() {
    if command -v wg >/dev/null && command -v wg-quick >/dev/null && command -v qrencode >/dev/null && command -v ufw >/dev/null; then
        echo "WireGuard, qrencode, and UFW are already installed."
        return
    fi
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y wireguard wireguard-tools qrencode ufw curl python3
}

write_sysctl() {
    cat >/etc/sysctl.d/99-wireguard-forwarding.conf <<EOF
net.ipv4.ip_forward=1
net.ipv6.conf.all.forwarding=1
EOF
    sysctl --system >/dev/null
}

ensure_keys() {
    umask 077
    mkdir -p "$WG_DIR"
    if [[ ! -s "$WG_DIR/server_private.key" || ! -s "$WG_DIR/server_public.key" ]]; then
        wg genkey | tee "$WG_DIR/server_private.key" | wg pubkey >"$WG_DIR/server_public.key"
    fi
    chmod 600 "$WG_DIR/server_private.key"
    chmod 644 "$WG_DIR/server_public.key"
}

write_config() {
    local private_key
    private_key="$(<"$WG_DIR/server_private.key")"

    if [[ -f "$WG_DIR/$WG_IFACE.conf" ]]; then
        cp "$WG_DIR/$WG_IFACE.conf" "$WG_DIR/$WG_IFACE.conf.bak.$(date +%Y%m%d%H%M%S)"
    fi

    cat >"$WG_DIR/$WG_IFACE.conf" <<EOF
# Managed by setup-server.sh. Peer blocks added by generate-client.sh are kept
# below this interface block on re-runs.
[Interface]
Address = $WG_IPV4_CIDR, $WG_IPV6_CIDR
ListenPort = $WG_PORT
PrivateKey = $private_key

# NAT full-tunnel clients out through the server's default interface.
PostUp = iptables -A FORWARD -i %i -j ACCEPT; iptables -A FORWARD -o %i -j ACCEPT; iptables -t nat -A POSTROUTING -o $PUBLIC_IFACE -j MASQUERADE; ip6tables -A FORWARD -i %i -j ACCEPT; ip6tables -A FORWARD -o %i -j ACCEPT; ip6tables -t nat -A POSTROUTING -o $PUBLIC_IFACE -j MASQUERADE
PostDown = iptables -D FORWARD -i %i -j ACCEPT; iptables -D FORWARD -o %i -j ACCEPT; iptables -t nat -D POSTROUTING -o $PUBLIC_IFACE -j MASQUERADE; ip6tables -D FORWARD -i %i -j ACCEPT; ip6tables -D FORWARD -o %i -j ACCEPT; ip6tables -t nat -D POSTROUTING -o $PUBLIC_IFACE -j MASQUERADE
SaveConfig = false

EOF

    if [[ -f "$WG_DIR/$WG_IFACE.peers" ]]; then
        cat "$WG_DIR/$WG_IFACE.peers" >>"$WG_DIR/$WG_IFACE.conf"
    fi
    chmod 600 "$WG_DIR/$WG_IFACE.conf"
}

configure_firewall() {
    ufw --force reset
    ufw default deny incoming
    ufw default allow outgoing
    ufw allow "${SSH_PORT}/tcp"
    ufw allow "${WG_PORT}/udp"
    ufw --force enable
}

start_wireguard() {
    systemctl enable "wg-quick@$WG_IFACE"
    systemctl restart "wg-quick@$WG_IFACE"
}

need_root
validate_port "$WG_PORT"
validate_port "$SSH_PORT"

PUBLIC_IFACE="${PUBLIC_IFACE:-$(default_iface)}"
[[ -n "$PUBLIC_IFACE" ]] || die "Could not detect the default internet interface. Set PUBLIC_IFACE=eth0 and re-run."

install_packages
validate_cidr "$WG_IPV4_CIDR"
validate_cidr "$WG_IPV6_CIDR"
write_sysctl
ensure_keys
write_config
configure_firewall
start_wireguard

SERVER_PUBLIC_KEY="$(<"$WG_DIR/server_public.key")"
if [[ -z "$ENDPOINT_HOST" ]]; then
    ENDPOINT_HOST="$(detect_endpoint)"
fi

echo
echo "WireGuard server is ready."
echo "Interface: $WG_IFACE"
echo "Server public key: $SERVER_PUBLIC_KEY"
echo "Endpoint: ${ENDPOINT_HOST:-YOUR_SERVER_PUBLIC_IP}:$WG_PORT"
echo "Client NAT keepalive recommendation: PersistentKeepalive = $CLIENT_KEEPALIVE"
echo
echo "Next: sudo ./generate-client.sh alice ${ENDPOINT_HOST:-YOUR_SERVER_PUBLIC_IP}:$WG_PORT"
