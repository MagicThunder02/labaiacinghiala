#!/usr/bin/env bash
# Installa il server Node di Baia come servizio systemd su host Linux.
# Node resta vincolato a 127.0.0.1:3000: l'unico componente esposto è il Connector.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-common.sh
source "$SCRIPT_DIR/lib-common.sh"

SERVICE_NAME="baia-node"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
DEFAULT_APP_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"

usage() {
    cat <<EOF
Uso: sudo $0 [--app-dir PATH] [--user NOME] [--node-bin PATH] [--skip-node-check]

  --app-dir PATH      Radice del repository Baia (default: $DEFAULT_APP_DIR)
  --user NOME         Utente di sistema che esegue Node (default: baia)
  --node-bin PATH     Eseguibile node da usare (default: quello nel PATH)
  --skip-node-check   Non bloccare se la versione di Node non rientra in >=24.18.1 <25
EOF
}

APP_DIR="$DEFAULT_APP_DIR"
SERVICE_USER="baia"
NODE_BIN=""
SKIP_NODE_CHECK=0

while [ $# -gt 0 ]; do
    case "$1" in
        --app-dir) APP_DIR="${2:-}"; shift 2 ;;
        --user) SERVICE_USER="${2:-}"; shift 2 ;;
        --node-bin) NODE_BIN="${2:-}"; shift 2 ;;
        --skip-node-check) SKIP_NODE_CHECK=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) die "argomento non riconosciuto: $1 (usa --help)" ;;
    esac
done

require_root

APP_DIR="$(readlink -f "$APP_DIR")"
[ -f "$APP_DIR/src/server.js" ] || die "src/server.js non trovato in $APP_DIR."
ENV_FILE="$APP_DIR/.env"
[ -f "$ENV_FILE" ] || die "$ENV_FILE mancante. Crealo partendo da .env.example prima di installare il servizio."

if [ -z "$NODE_BIN" ]; then
    NODE_BIN="$(command -v node || true)"
fi
[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || die "eseguibile node non trovato: usa --node-bin."
NODE_BIN="$(readlink -f "$NODE_BIN")"

NODE_VERSION="$("$NODE_BIN" --version | sed 's/^v//')"
NODE_MAJOR="${NODE_VERSION%%.*}"
if [ "$NODE_MAJOR" != "24" ] && [ "$SKIP_NODE_CHECK" -eq 0 ]; then
    die "package.json richiede Node >=24.18.1 <25, trovato $NODE_VERSION (usa --skip-node-check per forzare)."
fi

env_get() {
    grep -m1 -E "^[[:space:]]*$1=" "$ENV_FILE" 2>/dev/null \
        | cut -d= -f2- \
        | sed -E 's/^[[:space:]]*//; s/[[:space:]]*$//; s/^"//; s/"$//'
}

abs_path() {
    local value="$1"
    [ -n "$value" ] || return 1
    case "$value" in
        /*) echo "$value" ;;
        *) echo "$APP_DIR/${value#./}" ;;
    esac
}

CONFIGURED_HOST="$(env_get HOST)"
if [ -n "$CONFIGURED_HOST" ] && [ "$CONFIGURED_HOST" != "127.0.0.1" ]; then
    die "HOST in .env è '$CONFIGURED_HOST': Node deve restare su 127.0.0.1. Correggi .env e riprova."
fi

# I default devono restare allineati a src/config.js: sono le directory che il server
# crea e scrive all'avvio, e systemd le blocca se non sono in ReadWritePaths.
LIBRARY_PATH="$(abs_path "$(env_get LIBRARY_PATH)" || echo "$APP_DIR/media")"
DATABASE_PATH="$(abs_path "$(env_get DATABASE_PATH)" || echo "$APP_DIR/data/media.sqlite")"
BACKUPS_PATH="$(abs_path "$(env_get DATABASE_BACKUPS_PATH)" || echo "$APP_DIR/data/backups")"
POSTER_CACHE_PATH="$(abs_path "$(env_get METADATA_POSTER_CACHE_PATH)" || echo "$APP_DIR/data/cache/posters")"
MUSIC_CACHE_PATH="$(abs_path "$(env_get MUSIC_COVER_CACHE_PATH)" || echo "$APP_DIR/data/cache/music-covers")"
LEGACY_POSTERS_PATH="$(abs_path "$(env_get METADATA_POSTERS_PATH)" || echo "$APP_DIR/data/metadata-posters")"
UPLOAD_TEMP_PATH="$(abs_path "$(env_get UPLOAD_TEMP_PATH)" || echo "$LIBRARY_PATH/.uploads")"
DATABASE_DIR="$(dirname "$DATABASE_PATH")"

ensure_system_user "$SERVICE_USER"

# Solo le directory di stato dell'applicazione vengono create e assegnate al servizio.
# La libreria media non viene mai chownata ricorsivamente: può essere un mount condiviso.
for dir in "$DATABASE_DIR" "$BACKUPS_PATH" "$POSTER_CACHE_PATH" "$MUSIC_CACHE_PATH" "$LEGACY_POSTERS_PATH"; do
    mkdir -p "$dir"
    chown -R "$SERVICE_USER:$SERVICE_USER" "$dir"
done

if [ ! -d "$LIBRARY_PATH" ]; then
    die "LIBRARY_PATH non esiste: $LIBRARY_PATH (montalo o correggi .env prima di installare il servizio)."
fi
if ! runuser -u "$SERVICE_USER" -- test -r "$LIBRARY_PATH" -a -x "$LIBRARY_PATH"; then
    echo "ATTENZIONE: $SERVICE_USER non può leggere $LIBRARY_PATH."
    echo "Concedi l'accesso (gruppo o ACL) prima di usare il catalogo, es.:"
    echo "  setfacl -R -m u:${SERVICE_USER}:rX '$LIBRARY_PATH'"
elif ! runuser -u "$SERVICE_USER" -- test -w "$LIBRARY_PATH"; then
    echo "ATTENZIONE: $SERVICE_USER può leggere ma non scrivere $LIBRARY_PATH: gli upload falliranno."
    echo "  setfacl -R -m u:${SERVICE_USER}:rwX '$LIBRARY_PATH'"
fi

# .env leggibile dal servizio ma non modificabile da lui.
chown root:"$SERVICE_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"

READ_WRITE_PATHS="$(printf '%s\n' "$DATABASE_DIR" "$BACKUPS_PATH" "$POSTER_CACHE_PATH" "$MUSIC_CACHE_PATH" \
    "$LEGACY_POSTERS_PATH" "$LIBRARY_PATH" \
    | awk 'NF && !seen[$0]++' | paste -sd' ' -)"
# La temp dir upload nasce al primo upload: il prefisso "-" evita che systemd
# rifiuti di avviare il servizio finché non esiste.
READ_WRITE_PATHS="$READ_WRITE_PATHS -$UPLOAD_TEMP_PATH"

# ProtectHome nasconderebbe app o libreria se stanno sotto /home o /root.
PROTECT_HOME=true
case "$APP_DIR $LIBRARY_PATH $READ_WRITE_PATHS" in
    */home/*|*/root/*) PROTECT_HOME=false ;;
esac

cat > "$UNIT_PATH" <<EOF
[Unit]
Description=Baia Cinghiala - server Node (loopback 127.0.0.1:3000)
After=network.target
# Se la libreria è su un mount (disco esterno, NAS, share di rete) il servizio
# attende che sia montata: senza questo Node partirebbe su una cartella vuota.
RequiresMountsFor=${LIBRARY_PATH}

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
ExecStart=${NODE_BIN} ${APP_DIR}/src/server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=${PROTECT_HOME}
ReadWritePaths=${READ_WRITE_PATHS}
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictRealtime=true
LockPersonality=true
CapabilityBoundingSet=
AmbientCapabilities=
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
UMask=0027

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}.service" >/dev/null

sleep 3
if ! systemctl is-active --quiet "${SERVICE_NAME}.service"; then
    journalctl -u "${SERVICE_NAME}.service" --no-pager -n 50 || true
    die "Il servizio Node non è rimasto in esecuzione. Vedi i log sopra."
fi

# La verifica della libreria all'avvio può richiedere tempo su cataloghi grandi.
echo "Attendo che 127.0.0.1:3000 risponda..."
listening=0
for _ in $(seq 1 15); do
    if tcp_check 127.0.0.1 3000 2; then
        listening=1
        break
    fi
    sleep 2
done
if [ "$listening" -ne 1 ]; then
    journalctl -u "${SERVICE_NAME}.service" --no-pager -n 50 || true
    die "Servizio attivo ma 127.0.0.1:3000 non risponde. Vedi i log sopra."
fi

echo ""
echo "INSTALLAZIONE NODE SYSTEMD: PASS"
echo "App dir      : $APP_DIR"
echo "Utente       : $SERVICE_USER"
echo "Node         : $NODE_BIN ($NODE_VERSION)"
echo "Libreria     : $LIBRARY_PATH"
echo "Node ascolta solo su 127.0.0.1:3000. Non inoltrare mai la porta 3000 sul router."
