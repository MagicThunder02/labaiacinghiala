#!/usr/bin/env bash
# Installazione ristretta del Baia Host Connector su host Linux (equivalente di
# tools/direct-host/Install-BaiaDirectConnector.ps1 per Windows).
#
# Obiettivo di sicurezza: il Connector gira come utente di sistema dedicato senza
# privilegi, con directory binario read-only e directory dati riservata a lui solo.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-common.sh
source "$SCRIPT_DIR/lib-common.sh"

SERVICE_NAME="baia-connector"
SERVICE_USER="baia-connector"
BIN_DIR="/opt/baia-connector/bin"
DATA_DIR="/var/lib/baia-connector"
CONFIG_DIR="/etc/baia-connector"
INSTALLED_EXE="$BIN_DIR/baia-host-connector"
INSTALL_INFO="$CONFIG_DIR/install-info.json"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
CONNECTOR_PORT=43127
IDENTITY_FILENAME="server-identity-ed25519-v1.pk8"
FIREWALL_COMMENT="Baia Direct Connector"

usage() {
    cat <<EOF
Uso: sudo $0 --exe <percorso-binario-release> --bind-ip <IPv4-LAN-privato> [opzioni]

Opzioni:
  --exe PATH               Binario baia-host-connector compilato in release
                            (es. host-connector/target/release/baia-host-connector)
  --bind-ip IP              IPv4 LAN privato del host su cui esporre il Connector (es. 192.168.1.50)
  --migrate-identity PATH   Copia un file identita esistente (*.pk8) nella nuova data dir,
                            solo se la data dir non ne ha già uno.
  -h, --help                Mostra questo messaggio.
EOF
}

CONNECTOR_EXE=""
BIND_IP=""
MIGRATE_IDENTITY=""

while [ $# -gt 0 ]; do
    case "$1" in
        --exe) CONNECTOR_EXE="${2:-}"; shift 2 ;;
        --bind-ip) BIND_IP="${2:-}"; shift 2 ;;
        --migrate-identity) MIGRATE_IDENTITY="${2:-}"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) die "argomento non riconosciuto: $1 (usa --help)" ;;
    esac
done

[ -n "$CONNECTOR_EXE" ] || { usage; die "--exe è obbligatorio."; }
[ -n "$BIND_IP" ] || { usage; die "--bind-ip è obbligatorio."; }

require_root
BIND_IP="$(validate_private_ipv4_or_die "$BIND_IP")"

[ -f "$CONNECTOR_EXE" ] || die "Eseguibile Host Connector non trovato: $CONNECTOR_EXE"
CONNECTOR_EXE="$(readlink -f "$CONNECTOR_EXE")"

echo "== Baia Direct: installazione Connector ristretto (Linux) =="
echo "Bind LAN: ${BIND_IP}:${CONNECTOR_PORT}"

systemctl stop "${SERVICE_NAME}.service" 2>/dev/null || true
systemctl disable "${SERVICE_NAME}.service" 2>/dev/null || true

ensure_system_user "$SERVICE_USER"

mkdir -p "$BIN_DIR" "$DATA_DIR" "$CONFIG_DIR"

# Directory binario: root-owned, il servizio la legge/esegue ma non può scriverci.
chown -R root:root /opt/baia-connector
chmod 755 /opt/baia-connector "$BIN_DIR"

# Directory dati (identita persistente): scrivibile solo dal servizio.
chown "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"
chmod 700 "$DATA_DIR"

# Directory config (fingerprint/bindIp, nessun segreto): leggibile da tutti.
chown root:root "$CONFIG_DIR"
chmod 755 "$CONFIG_DIR"

cp -f "$CONNECTOR_EXE" "$INSTALLED_EXE"
chown root:root "$INSTALLED_EXE"
chmod 755 "$INSTALLED_EXE"

TARGET_IDENTITY="$DATA_DIR/$IDENTITY_FILENAME"
if [ -n "$MIGRATE_IDENTITY" ] && [ ! -f "$TARGET_IDENTITY" ]; then
    [ -f "$MIGRATE_IDENTITY" ] || die "File identita da migrare non trovato: $MIGRATE_IDENTITY"
    cp "$MIGRATE_IDENTITY" "$TARGET_IDENTITY"
    chown "$SERVICE_USER:$SERVICE_USER" "$TARGET_IDENTITY"
    chmod 600 "$TARGET_IDENTITY"
    echo "Identita Connector esistente migrata in $DATA_DIR."
fi

echo "Inizializzazione/verifica identita persistente..."
FINGERPRINT_OUTPUT="$(runuser -u "$SERVICE_USER" -- env BAIA_CONNECTOR_DATA_DIR="$DATA_DIR" "$INSTALLED_EXE" --print-fingerprint)" \
    || die "Impossibile inizializzare/verificare l'identita del Connector installato."
FINGERPRINT="$(echo "$FINGERPRINT_OUTPUT" | tail -n1 | tr -d '\r')"
[[ "$FINGERPRINT" =~ ^SHA256:[A-Za-z0-9_-]+$ ]] || die "Fingerprint Connector inattesa: $FINGERPRINT_OUTPUT"

# Ripristina permessi stretti sulla data dir dopo la scrittura dell'identita.
chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"
chmod 700 "$DATA_DIR"
find "$DATA_DIR" -maxdepth 1 -type f -exec chmod 600 {} \;

FIREWALL_METHOD="$(detect_firewall)"
case "$FIREWALL_METHOD" in
    ufw)
        ufw allow to "$BIND_IP" port "$CONNECTOR_PORT" proto tcp comment "$FIREWALL_COMMENT" >/dev/null
        echo "Regola ufw aggiunta: TCP ${BIND_IP}:${CONNECTOR_PORT}."
        if ufw status 2>/dev/null | head -n1 | grep -qi inactive; then
            echo "NOTA: ufw è inattivo, la regola non è ancora applicata (sudo ufw enable)."
        fi
        ;;
    firewalld)
        firewall-cmd --permanent --zone=public \
            --add-rich-rule="rule family=ipv4 destination address=${BIND_IP} port protocol=tcp port=${CONNECTOR_PORT} accept" >/dev/null
        firewall-cmd --reload >/dev/null
        echo "Regola firewalld aggiunta: TCP ${BIND_IP}:${CONNECTOR_PORT}."
        ;;
    nft)
        echo "nftables rilevato ma non modificato automaticamente (rischio di conflitto con regole esistenti)."
        echo "Aggiungi manualmente una regola equivalente a:"
        echo "  nft add rule inet filter input ip daddr ${BIND_IP} tcp dport ${CONNECTOR_PORT} accept"
        ;;
    none)
        echo "Nessun firewall gestito rilevato (ufw/firewalld/nft)."
        echo "Verifica manualmente che la porta ${CONNECTOR_PORT} sia raggiungibile solo su ${BIND_IP}."
        ;;
esac

cat > "$UNIT_PATH" <<EOF
[Unit]
Description=Baia Host Connector (Direct Internet TLS v1)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=600
StartLimitBurst=10

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
ExecStart=${INSTALLED_EXE}
Environment=BAIA_CONNECTOR_BIND_IP=${BIND_IP}
Environment=BAIA_CONNECTOR_DATA_DIR=${DATA_DIR}
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${DATA_DIR}
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictRealtime=true
LockPersonality=true
MemoryDenyWriteExecute=true
CapabilityBoundingSet=
AmbientCapabilities=
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
UMask=0077

[Install]
WantedBy=multi-user.target
EOF

cat > "$INSTALL_INFO" <<EOF
{
  "version": 1,
  "mode": "direct-internet-tls-v1",
  "bindIp": "${BIND_IP}",
  "connectorPort": ${CONNECTOR_PORT},
  "publicPort": 443,
  "fingerprint": "${FINGERPRINT}",
  "installedExe": "${INSTALLED_EXE}",
  "dataDir": "${DATA_DIR}",
  "serviceName": "${SERVICE_NAME}",
  "firewallMethod": "${FIREWALL_METHOD}"
}
EOF
chmod 644 "$INSTALL_INFO"

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}.service" >/dev/null

sleep 2
if ! systemctl is-active --quiet "${SERVICE_NAME}.service"; then
    journalctl -u "${SERVICE_NAME}.service" --no-pager -n 50 || true
    die "Il servizio Connector non è rimasto in esecuzione. Vedi i log sopra."
fi

echo ""
echo "INSTALLAZIONE CONNECTOR DIRECT: PASS"
echo "Fingerprint server: ${FINGERPRINT}"
echo "Regola router da creare SOLO quando iniziano i test reali: TCP WAN 443 -> ${BIND_IP}:${CONNECTOR_PORT}"
echo "Node deve rimanere esclusivamente su 127.0.0.1:3000."
