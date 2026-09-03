# Baia Cinghiala

Repository sorgente consegnato al PC host il **31 agosto 2026**.

## Architettura corrente

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

Avvia Node:

```powershell
npm.cmd start
```

oppure usa:

```text
avvia-windows.bat
```

## Host Linux

Il percorso Direct TCP 443 è supportato anche su host Linux. Node gira come servizio systemd su
`127.0.0.1:3000`, il Connector come servizio systemd non privilegiato sull'IPv4 LAN, porta 43127.
Script e procedura completa: `tools/direct-host/linux/README.md`.

Requisiti Linux: Node `>=24.18.1 <25`, Rust stable + Cargo, `build-essential` e `pkg-config`.

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
