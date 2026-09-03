#!/usr/bin/env bash
# Diagnostica host Linux pre-test reale
# (equivalente di tools/direct-host/Test-BaiaDirectHost.ps1).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-common.sh
source "$SCRIPT_DIR/lib-common.sh"

INSTALL_INFO="/etc/baia-connector/install-info.json"
NODE_SERVICE="baia-node.service"

usage() {
    cat <<EOF
Uso: $0 [--public-endpoint https://nome-ddns.example:443]
EOF
}

PUBLIC_ENDPOINT=""
while [ $# -gt 0 ]; do
    case "$1" in
        --public-endpoint) PUBLIC_ENDPOINT="${2:-}"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) die "argomento non riconosciuto: $1 (usa --help)" ;;
    esac
done

[ -f "$INSTALL_INFO" ] || die "Baia Direct Connector non risulta installato con install-connector.sh."

BIND_IP="$(json_get "$INSTALL_INFO" bindIp)"
CONNECTOR_PORT="$(json_get "$INSTALL_INFO" connectorPort)"
SERVICE_NAME="$(json_get "$INSTALL_INFO" serviceName)"
FIREWALL_METHOD="$(json_get "$INSTALL_INFO" firewallMethod)"
FINGERPRINT="$(json_get "$INSTALL_INFO" fingerprint)"

echo "== Baia Direct: diagnostica host Linux pre-test reale =="
failed=0

report() {
    local label="$1" ok="$2"
    if [ "$ok" -eq 0 ]; then
        printf '%-38s: PASS\n' "$label"
    else
        printf '%-38s: FAIL\n' "$label"
        failed=1
    fi
}

if tcp_check 127.0.0.1 3000; then report "Node 127.0.0.1:3000" 0; else report "Node 127.0.0.1:3000" 1; fi

if tcp_check "$BIND_IP" "$CONNECTOR_PORT"; then
    report "Connector LAN ${BIND_IP}:${CONNECTOR_PORT}" 0
else
    report "Connector LAN ${BIND_IP}:${CONNECTOR_PORT}" 1
fi

if systemctl is-active --quiet "${SERVICE_NAME}.service"; then
    report "Servizio ${SERVICE_NAME}" 0
else
    report "Servizio ${SERVICE_NAME}" 1
fi

if systemctl list-unit-files "$NODE_SERVICE" >/dev/null 2>&1 \
    && systemctl is-active --quiet "$NODE_SERVICE" 2>/dev/null; then
    report "Servizio baia-node" 0
else
    printf '%-38s: SKIP (Node non gestito da systemd)\n' "Servizio baia-node"
fi

# Node non deve essere raggiungibile dalla LAN: se risponde sull'IP LAN è una regressione grave.
if tcp_check "$BIND_IP" 3000 1; then
    printf '%-38s: FAIL (Node esposto in LAN!)\n' "Node NON esposto su ${BIND_IP}:3000"
    failed=1
else
    printf '%-38s: PASS\n' "Node NON esposto su ${BIND_IP}:3000"
fi

case "$FIREWALL_METHOD" in
    ufw)
        if ufw status 2>/dev/null | grep -q "${BIND_IP} ${CONNECTOR_PORT}\|${CONNECTOR_PORT}/tcp"; then
            report "Firewall ufw" 0
        else
            report "Firewall ufw" 1
        fi
        ;;
    firewalld)
        if firewall-cmd --list-rich-rules 2>/dev/null | grep -q "$BIND_IP"; then
            report "Firewall firewalld" 0
        else
            report "Firewall firewalld" 1
        fi
        ;;
    *)
        printf '%-38s: SKIP (verifica manuale)\n' "Firewall"
        ;;
esac

printf '%-38s: %s\n' "Fingerprint server" "$FINGERPRINT"

if [ -n "$PUBLIC_ENDPOINT" ]; then
    if [[ ! "$PUBLIC_ENDPOINT" =~ ^https://[A-Za-z0-9._-]+:443$ ]]; then
        die "--public-endpoint deve essere una origine https://host:443 senza path."
    fi
    host_only="${PUBLIC_ENDPOINT#https://}"
    host_only="${host_only%:443}"
    if addresses="$(getent ahostsv4 "$host_only" 2>/dev/null | awk '{print $1}' | sort -u | paste -sd, -)" \
        && [ -n "$addresses" ]; then
        printf '%-38s: PASS (%s)\n' "DNS $host_only" "$addresses"
    else
        printf '%-38s: FAIL\n' "DNS $host_only"
        failed=1
    fi
else
    printf '%-38s: SKIP (non fornito)\n' "DDNS/public endpoint"
fi

printf '%-38s: NON TESTATA QUI (serve rete esterna)\n' "Reachability WAN TCP 443"

if [ "$failed" -ne 0 ]; then
    echo "DIAGNOSTICA BAIA DIRECT: FAIL" >&2
    exit 1
fi
echo "DIAGNOSTICA BAIA DIRECT LOCALE: PASS"
