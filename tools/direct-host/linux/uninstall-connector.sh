#!/usr/bin/env bash
# Disinstallazione del Baia Host Connector su host Linux
# (equivalente di tools/direct-host/Uninstall-BaiaDirectConnector.ps1).
# L'identita persistente viene preservata salvo --remove-identity.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-common.sh
source "$SCRIPT_DIR/lib-common.sh"

SERVICE_NAME="baia-connector"
SERVICE_USER="baia-connector"
ROOT_DIR="/opt/baia-connector"
DATA_DIR="/var/lib/baia-connector"
CONFIG_DIR="/etc/baia-connector"
INSTALL_INFO="$CONFIG_DIR/install-info.json"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
CONNECTOR_PORT=43127

usage() {
    cat <<EOF
Uso: sudo $0 [--remove-identity] [--remove-user]

  --remove-identity   Elimina anche ${DATA_DIR} (identita server e fingerprint: i client
                      accoppiati andranno ri-accoppiati). Default: preservata.
  --remove-user       Elimina l'utente di sistema ${SERVICE_USER}.
EOF
}

REMOVE_IDENTITY=0
REMOVE_USER=0

while [ $# -gt 0 ]; do
    case "$1" in
        --remove-identity) REMOVE_IDENTITY=1; shift ;;
        --remove-user) REMOVE_USER=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) die "argomento non riconosciuto: $1 (usa --help)" ;;
    esac
done

require_root

BIND_IP=""
FIREWALL_METHOD="none"
if [ -f "$INSTALL_INFO" ]; then
    BIND_IP="$(json_get "$INSTALL_INFO" bindIp)"
    FIREWALL_METHOD="$(json_get "$INSTALL_INFO" firewallMethod)"
fi

systemctl stop "${SERVICE_NAME}.service" 2>/dev/null || true
systemctl disable "${SERVICE_NAME}.service" 2>/dev/null || true
rm -f "$UNIT_PATH"
systemctl daemon-reload

if [ -n "$BIND_IP" ]; then
    case "$FIREWALL_METHOD" in
        ufw)
            ufw delete allow to "$BIND_IP" port "$CONNECTOR_PORT" proto tcp >/dev/null 2>&1 \
                && echo "Regola ufw rimossa." \
                || echo "Regola ufw non trovata o già rimossa."
            ;;
        firewalld)
            firewall-cmd --permanent --zone=public \
                --remove-rich-rule="rule family=ipv4 destination address=${BIND_IP} port protocol=tcp port=${CONNECTOR_PORT} accept" >/dev/null 2>&1 || true
            firewall-cmd --reload >/dev/null 2>&1 || true
            echo "Regola firewalld rimossa."
            ;;
        nft)
            echo "Regola nftables non gestita da questi script: rimuovila manualmente se l'avevi aggiunta."
            ;;
    esac
fi

rm -rf "$ROOT_DIR"
rm -f "$INSTALL_INFO"

if [ "$REMOVE_IDENTITY" -eq 1 ]; then
    rm -rf "$DATA_DIR"
    echo "Identita/configurazione Connector rimossa su richiesta."
else
    echo "Identita Connector preservata in: $DATA_DIR"
fi

if [ "$REMOVE_USER" -eq 1 ] && id "$SERVICE_USER" >/dev/null 2>&1; then
    userdel "$SERVICE_USER"
    echo "Utente di sistema $SERVICE_USER rimosso."
fi

echo "DISINSTALLAZIONE CONNECTOR DIRECT: PASS"
