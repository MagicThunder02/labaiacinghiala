# Baia Host Connector — Direct Internet TLS v1

Il Baia Host Connector e' il solo componente Baia destinato a essere raggiungibile da Internet nel percorso primario **Direct TCP 443**.
Node, SQLite e filesystem media restano locali.

## Percorso primario

```text
Baia client
  -> Internet TCP 443
  -> router host (443 -> PC:43127)
  -> Baia Host Connector TLS 1.3
  -> SOLO http://127.0.0.1:3000
```

Il crate/trasporto relay resta nel repository come fallback futuro e non e' necessario per la modalita Direct.

## Vincoli di sicurezza

- TLS 1.3 con Raw Public Key RFC 7250 Ed25519 persistente.
- Pinning della fingerprint server nel Core client.
- upstream unico: `http://127.0.0.1:3000`.
- niente host/porta upstream forniti dal client.
- API, media e upload richiedono un grant firmato dall'identita server + prova Ed25519 della chiave device prima dell'inoltro verso Node.
- Node continua a fare autorizzazione applicativa, account, nonce e revoche: il controllo del Connector e' un perimetro aggiuntivo, non lo sostituisce.
- media solo path logici allowlistati con Range/If-Range.
- upload solo endpoint nativi allowlistati.
- limiti su connessioni, header/frame e timeout pre-auth.
- nessun timeout totale su media/upload lunghi.
- log senza body, token, firme, nomi file o URL media completi.

## Endpoint v1

- `GET /baia/v1/health`
- `POST /baia/v1/request`
- `POST /baia/v1/media`
- `POST /baia/v1/pairing`
- `POST /baia/v1/upload`

Il pairing e' l'unico flusso pre-device-grant: usa un invito temporaneo e una prova Ed25519, viene limitato dimensionalmente e inoltrato solo alla route Node fissa `/api/pairing/redeem`.

## Bind

Il default resta loopback:

```text
127.0.0.1:43127
```

Per Direct Internet il processo deve essere configurato con un IPv4 LAN privato esplicito:

```text
BAIA_CONNECTOR_BIND_IP=192.168.1.50
```

Il validatore accetta solo loopback o IPv4 RFC1918; non e' previsto un bind `0.0.0.0`.

## Identita persistente

Per esecuzione interattiva Windows, il percorso storico resta sotto `%LOCALAPPDATA%\\Baia\\HostConnector`.
Per esecuzione ristetta/schedulata si puo' impostare una directory dati assoluta:

```text
BAIA_CONNECTOR_DATA_DIR=C:\ProgramData\Baia\HostConnector\data
```

Il nome del file identity e' fisso. La fingerprint pubblica puo' essere letta senza avviare il listener:

```powershell
$env:BAIA_CONNECTOR_DATA_DIR='C:\ProgramData\Baia\HostConnector\data'
.\baia-host-connector.exe --print-fingerprint
```

Su Linux **non esiste un percorso di default**: `BAIA_CONNECTOR_DATA_DIR` con percorso assoluto e'
obbligatorio, altrimenti l'avvio fallisce. L'unit systemd generata dagli script Linux lo imposta a
`/var/lib/baia-connector`.

Non cancellare o rigenerare l'identita per risolvere problemi di rete.

## Preparazione Linux pre-test

Usare gli script in `tools/direct-host/linux/`: creano utente di sistema dedicato, directory binario
root-owned, data dir riservata, regola firewall e unit systemd con privilegi minimi.
La procedura completa e' in `tools/direct-host/linux/README.md`.

## Preparazione Windows pre-test

Usare gli script in `tools/direct-host/` per copiare il binario in ProgramData, restringere ACL, eseguirlo come `NT AUTHORITY\\LOCAL SERVICE`, installare una regola Firewall specifica e conservare/migrare l'identita.

Il router **non va aperto** durante il preflight. Il port-forward verra' creato solo al primo test reale:

```text
WAN TCP 443 -> IP_LAN_PC TCP 43127
```

Non inoltrare mai TCP 3000 e non mettere il PC in DMZ.
