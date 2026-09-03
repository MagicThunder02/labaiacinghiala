#!/usr/bin/env bash
# Rimuove il servizio systemd del server Node. Dati, database e libreria restano intatti.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-common.sh
source "$SCRIPT_DIR/lib-common.sh"

SERVICE_NAME="baia-node"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"

require_root

systemctl stop "${SERVICE_NAME}.service" 2>/dev/null || true
systemctl disable "${SERVICE_NAME}.service" 2>/dev/null || true
rm -f "$UNIT_PATH"
systemctl daemon-reload

echo "Servizio ${SERVICE_NAME} rimosso. Database, backup, cache e libreria non sono stati toccati."
