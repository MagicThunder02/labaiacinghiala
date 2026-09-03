#!/usr/bin/env bash
# Funzioni condivise dagli script Baia Direct per Linux.
# Va sempre incluso con: source "$(dirname "$0")/lib-common.sh"

die() {
    echo "ERRORE: $*" >&2
    exit 1
}

require_root() {
    if [ "$(id -u)" -ne 0 ]; then
        die "esegui questo script con sudo/root."
    fi
}

# Accetta solo IPv4 RFC1918 (10/8, 172.16/12, 192.168/16), come il validatore Rust del Connector.
is_private_ipv4() {
    local ip="$1"
    [[ "$ip" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
    local a="${BASH_REMATCH[1]}" b="${BASH_REMATCH[2]}" c="${BASH_REMATCH[3]}" d="${BASH_REMATCH[4]}"
    local octet
    for octet in "$a" "$b" "$c" "$d"; do
        [ "$octet" -ge 0 ] && [ "$octet" -le 255 ] || return 1
    done
    if [ "$a" -eq 10 ]; then return 0; fi
    if [ "$a" -eq 172 ] && [ "$b" -ge 16 ] && [ "$b" -le 31 ]; then return 0; fi
    if [ "$a" -eq 192 ] && [ "$b" -eq 168 ]; then return 0; fi
    return 1
}

validate_private_ipv4_or_die() {
    local ip="$1"
    is_private_ipv4 "$ip" || die "$ip non è un IPv4 LAN privato valido (10/8, 172.16/12 o 192.168/16)."
    echo "$ip"
}

# Prova ad aprire una connessione TCP; ritorna 0 se il servizio risponde entro il timeout.
tcp_check() {
    local host="$1" port="$2" timeout_s="${3:-2}"
    timeout "$timeout_s" bash -c "exec 3<>/dev/tcp/${host}/${port}" >/dev/null 2>&1
}

# Estrae il valore di una chiave da un JSON piatto (stringhe o numeri, nessun nesting).
json_get() {
    local file="$1" key="$2"
    grep -oE "\"${key}\"[[:space:]]*:[[:space:]]*\"?[^\",}]*\"?" "$file" 2>/dev/null \
        | head -n1 \
        | sed -E "s/\"${key}\"[[:space:]]*:[[:space:]]*//; s/^\"//; s/\"\$//"
}

# Rileva il gestore firewall disponibile: ufw, firewalld, nft o none.
detect_firewall() {
    if command -v ufw >/dev/null 2>&1; then
        echo ufw
        return
    fi
    if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld 2>/dev/null; then
        echo firewalld
        return
    fi
    if command -v nft >/dev/null 2>&1; then
        echo nft
        return
    fi
    echo none
}

ensure_system_user() {
    local user="$1"
    if ! id "$user" >/dev/null 2>&1; then
        useradd --system --no-create-home --shell /usr/sbin/nologin "$user"
        echo "Utente di sistema creato: $user"
    fi
}
