# Baia Cinghiala

## Guida per l'utente

La documentazione completa delle funzioni disponibili, dell'accesso, dei cataloghi,
dei player, dell'upload, degli account, del pairing e della manutenzione è in
[docs/GUIDA-UTENTE.md](docs/GUIDA-UTENTE.md).

Repository sorgente consegnato al PC host il **31 agosto 2026**.

## Architettura corrente

La mappa tecnica completa, inclusi confini dei componenti, route, servizi, persistenza,
comandi Tauri e matrice piattaforme, è in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Per sviluppo e build Windows/Linux/macOS/iOS vedere [docs/BUILD.md](docs/BUILD.md); la
sequenza incrementale è in [docs/REFACTOR-PLAN.md](docs/REFACTOR-PLAN.md).

Il percorso remoto primario deciso per Baia è:

```text
Client Baia
   -> Internet TCP 443 + TLS 1.3
   -> router casa host
   -> TCP 443 -> PC host:43127
   -> Baia Host Connector
   -> SOLO http://127.0.0.1:3000
   -> Node + SQLite + media
```

Il crate `relay/` resta nel repository come **fallback futuro**, ma non è requisito del percorso normale.

## Regole non negoziabili

- Node resta su `127.0.0.1:3000`.
- Non inoltrare mai la porta 3000 sul router.
- Il Connector è l'unico componente destinato a essere esposto.
- TLS 1.3 e pinning dell'identità server restano obbligatori.
- Il Connector non deve diventare un proxy generico verso LAN/Internet.
- Nessuna chiave privata nel JavaScript.
- Nessun IPC generico "firma byte arbitrari".
- Nessun timeout totale ~30 s su upload o streaming.

## Prima esecuzione su un nuovo PC di sviluppo/host

Requisiti principali:

- Windows 10/11 x64;
- Node.js `>=24.18.1 <25`;
- Rust stable MSVC + Cargo;
- WebView2 per Tauri.

Installa le dipendenze Node:

```powershell
npm.cmd ci
```

Controlla tipi e frontend statico:

```powershell
npm.cmd run typecheck
npm.cmd run build:frontend
```

Avvia Node:

```powershell
npm.cmd start
```

oppure usa:

```text
avvia-windows.bat
```

## Upload lunghi

Gli upload autorizzati non hanno una scadenza totale di ricezione: possono superare
i cinque minuti anche con connessioni lente. Se non arrivano dati per 130 secondi,
Node interrompe la ricezione con HTTP 408 (`UPLOAD_IDLE_TIMEOUT`) e Multer rimuove
i file parziali. Il timeout termina alla fine della ricezione, prima dell'importazione.
Le altre richieste conservano un limite di cinque minuti per ricevere il corpo;
gli header conservano il limite di 60 secondi. Node resta accessibile solo su loopback.

`npm.cmd test` verifica anche upload, interruzioni, pulizia e riuso delle connessioni.
Per provare il server reale con un trasferimento rallentato di circa 5 minuti e 35
secondi (database e libreria temporanei, senza usare quelli del server):

```powershell
$env:BAIA_LONG_UPLOAD_TEST = '1'
node --test test/server-upload-timeout-integration.test.js
Remove-Item Env:BAIA_LONG_UPLOAD_TEST
```

## Aggiornamento del client

L'app desktop si aggiorna da sola: Profilo -> Aggiornamenti scarica l'ultima release firmata da
GitHub, ne verifica la firma minisign e la installa. Il server Node non è toccato e resta
aggiornato a parte sull'host. Procedura di pubblicazione, chiavi di firma e limiti per pacchetto
(`deb`, Flatpak, store mobile) sono in [docs/BUILD.md](docs/BUILD.md).

## Host Linux

Il percorso Direct TCP 443 è supportato anche su host Linux. Node gira come servizio systemd su
`127.0.0.1:3000`, il Connector come servizio systemd non privilegiato sull'IPv4 LAN, porta 43127.
Script e procedura completa: `tools/direct-host/linux/README.md`.

Requisiti Linux: Node `>=24.18.1 <25`, Rust stable + Cargo, `build-essential` e `pkg-config`.

## Client e host Apple

Il Core Tauri usa macOS Keychain e iOS Keychain senza fallback in chiaro. Il client iOS usa
soltanto asset statici e Core Rust e raggiunge il Connector remoto: non include Node, SQLite
host o libreria media. Build, signing, provisioning e test Keychain/iOS richiedono macOS con
Xcode; i prerequisiti e i comandi sono descritti in `docs/BUILD.md`.

## Preflight corrente

Prima di modificare la rete o aprire il router:

```powershell
powershell -ExecutionPolicy Bypass -File .\phase5-direct-preflight.ps1
```

L'ultimo preflight noto, eseguito prima dell'handoff, ha concluso:

- Node/contratti Direct: 26 test PASS;
- Host Connector: 27 test PASS;
- Core/Tauri: 38 test PASS;
- build release Host Connector: PASS;
- risultato finale: `PREFLIGHT DIRECT TCP 443 PASS`.

## File da leggere prima di programmare

1. `HANDOFF.md`
2. `docs/ROADMAP-DIRECT-TCP443.md`
3. `PROMPT-NUOVA-CHAT-MATTE.md`
4. `host-connector/README.md`
5. `tools/direct-host/README.md`

## Elementi intenzionalmente NON presenti nel trasferimento

Per limiti di dimensione non sono stati inclusi:

- la libreria/cartella `media` reale;
- tutte le cartelle Rust/Tauri `target`;
- `src-tauri/gen/android`.

La cartella `media/` qui contiene soltanto `.gitkeep`.

`src-tauri/gen/android` **non deve essere inventata o ricostruita alla cieca**. Se servirà proseguire la build Android, recuperare quella cartella dal laptop sorgente oppure rigenerarla soltanto dopo aver verificato quali personalizzazioni native erano presenti.

## Stato locale

`.env`, `data/`, database, backup e cache presenti nello ZIP originale sono stati deliberatamente conservati così come forniti.
