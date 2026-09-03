# Baia Direct — deploy su host Linux

Equivalente Linux di `tools/direct-host/` (che resta la procedura Windows).
Stessa architettura, stessi vincoli:

```text
Baia client -> Internet TCP 443/TLS 1.3 -> router -> host Linux:43127 (Connector) -> http://127.0.0.1:3000 (Node)
```

- Node ascolta **solo** su `127.0.0.1:3000` ed è eseguito da un utente di sistema dedicato.
- Il Connector è l'unico componente Internet-facing, gira come utente `baia-connector` senza privilegi.
- La porta 3000 non va **mai** inoltrata sul router. Niente DMZ.

## 0. Prerequisiti

Debian/Ubuntu:

```bash
sudo apt update
sudo apt install -y build-essential pkg-config curl git acl
```

- Node.js `>=24.18.1 <25` installato a livello di sistema (non con nvm nel profilo di un utente:
  systemd non legge i profili di shell). Un percorso tipo `/usr/bin/node` o `/usr/local/bin/node` va bene.
- Rust stable + Cargo (`rustup`) solo per compilare il Connector.
- `build-essential` serve al crate `ring` durante la compilazione.

Gli script si invocano con `sudo bash <script>` oppure, dopo `chmod +x tools/direct-host/linux/*.sh`, direttamente.

## 1. Repository e configurazione

```bash
git clone <repo> /opt/baia
cd /opt/baia
npm ci
cp .env.example .env
```

In `.env`:

- `HOST=127.0.0.1` e `PORT=3000` — non modificare, l'installer rifiuta altri valori per `HOST`;
- `LIBRARY_PATH=/mnt/raid/Media` (percorso reale della libreria, già montato);
- `DATABASE_PATH`, `DATABASE_BACKUPS_PATH`, `METADATA_POSTER_CACHE_PATH`, `MUSIC_COVER_CACHE_PATH`
  possono restare relativi: verranno creati sotto la cartella dell'app.

## 2. Node come servizio systemd

```bash
sudo bash tools/direct-host/linux/install-node.sh --app-dir /opt/baia
```

Lo script crea l'utente di sistema `baia`, prepara le directory di stato, verifica che la libreria sia
leggibile, genera `/etc/systemd/system/baia-node.service` con hardening (`ProtectSystem=strict`,
`ReadWritePaths` limitate a dati e libreria) e verifica che `127.0.0.1:3000` risponda.

La libreria media **non** viene mai chownata ricorsivamente: se l'utente `baia` non può leggerla, lo
script lo segnala e suggerisce una ACL (`setfacl -R -m u:baia:rX ...`).

Opzioni utili: `--user`, `--node-bin`, `--skip-node-check`.

## 3. Compilare il Connector

```bash
cargo build --locked --release --manifest-path host-connector/Cargo.toml
```

Il binario risultante è `host-connector/target/release/baia-host-connector`.

## 4. Identità del server — leggere prima di installare

Il Connector su Linux **non ha un percorso identità di default**: `BAIA_CONNECTOR_DATA_DIR` è
obbligatorio e viene impostato dall'unit systemd (`/var/lib/baia-connector`).

- Nuovo server, nessun client già accoppiato: nessuna azione, l'identità viene generata al primo avvio.
- Stai migrando da un host Windows già accoppiato: copia il file
  `server-identity-ed25519-v1.pk8` dal vecchio host e passalo con `--migrate-identity`, altrimenti la
  fingerprint cambia e **tutti i device accoppiati vanno ri-accoppiati** (i client la pinnano).

## 5. Installare il Connector

```bash
sudo bash tools/direct-host/linux/install-connector.sh \
  --exe host-connector/target/release/baia-host-connector \
  --bind-ip 192.168.1.50
```

Con migrazione dell'identità esistente:

```bash
sudo bash tools/direct-host/linux/install-connector.sh \
  --exe host-connector/target/release/baia-host-connector \
  --bind-ip 192.168.1.50 \
  --migrate-identity /percorso/server-identity-ed25519-v1.pk8
```

Sostituisci `192.168.1.50` con l'IPv4 LAN riservato dell'host (sono accettati solo indirizzi RFC1918).

Lo script:

- crea l'utente di sistema `baia-connector`;
- installa il binario in `/opt/baia-connector/bin` (root-owned, non scrivibile dal servizio);
- riserva `/var/lib/baia-connector` (mode 700) all'identità persistente;
- stampa e salva la fingerprint in `/etc/baia-connector/install-info.json`;
- aggiunge la regola firewall su ufw o firewalld (con nftables stampa il comando da applicare a mano);
- genera `/etc/systemd/system/baia-connector.service` con capability azzerate, filesystem read-only e
  scrittura consentita solo sulla data dir;
- abilita e avvia il servizio, verificando che resti attivo.

Il relay resta disabilitato: l'unit non definisce `BAIA_RELAY_ENDPOINT` né `BAIA_RELAY_CERT_FINGERPRINT`
e systemd non eredita l'ambiente della shell.

## 6. Diagnostica prima dei test reali

```bash
sudo bash tools/direct-host/linux/test-host.sh
```

Con DDNS già configurato:

```bash
sudo bash tools/direct-host/linux/test-host.sh --public-endpoint https://nome-ddns.example:443
```

Verifica Node su loopback, Connector sull'IP LAN, stato dei servizi, firewall, fingerprint e — in più
rispetto alla versione Windows — che Node **non** risponda sull'IP LAN. La raggiungibilità WAN non è
testabile da qui: va verificata da rete mobile.

## 7. Rete

Solo dopo che la diagnostica locale è PASS:

1. DHCP reservation per l'IP LAN dell'host;
2. DDNS se l'IP pubblico è dinamico;
3. sul router **una sola** regola:

```text
WAN TCP 443 -> IP_LAN_HOST TCP 43127
```

Non aprire la 3000, non usare DMZ, non aprire intervalli di porte.

## 8. Bootstrap Direct nel `.env` di Node

Solo quando endpoint pubblico e fingerprint sono definitivi:

```text
BAIA_PUBLIC_CONNECTOR_ENDPOINT=https://nome-ddns.example:443
BAIA_CONNECTOR_SERVER_FINGERPRINT=SHA256:...
```

La fingerprint è quella stampata dall'installer (o `json_get` su `/etc/baia-connector/install-info.json`).
Dopo la modifica: `sudo systemctl restart baia-node`.

## 9. Kill switch

Per interrompere subito l'accesso da Internet:

```bash
sudo systemctl stop baia-connector
```

oppure disabilitare il port forwarding TCP 443 sul router. Node continua a funzionare in LAN/loopback.

## 10. Comandi utili

```bash
systemctl status baia-node baia-connector
journalctl -u baia-connector -f
journalctl -u baia-node -n 100 --no-pager
sudo runuser -u baia-connector -- env BAIA_CONNECTOR_DATA_DIR=/var/lib/baia-connector \
  /opt/baia-connector/bin/baia-host-connector --print-fingerprint
```

## 11. Disinstallazione

```bash
sudo bash tools/direct-host/linux/uninstall-connector.sh          # identità preservata
sudo bash tools/direct-host/linux/uninstall-connector.sh --remove-identity
sudo bash tools/direct-host/linux/uninstall-node.sh               # dati e libreria intatti
```
