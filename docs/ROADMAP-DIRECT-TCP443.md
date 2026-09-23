# ROADMAP TECNICA — DIRECT TCP 443

Questo documento prevale sulle vecchie note relay-first per il percorso remoto primario.

## A. Architettura

```text
Baia client -> TCP 443/TLS 1.3 -> router host -> Connector:43127 -> Node 127.0.0.1:3000
```

- Nessuna VPS nel percorso normale.
- Nessuna VPN richiesta agli amici.
- DDNS se l'IP pubblico cambia.
- Relay conservato soltanto come fallback futuro.

## B. Vincoli invarianti

### Host
- Node solo loopback.
- Connector unico componente Internet-facing.
- Upstream Connector fisso a Node.
- Nessun proxy generico.
- Connector con privilegi Windows minimi.

### Client
- L'utente installa soltanto Baia.
- Networking/chiavi/pinning nel Core nativo.
- Nessuna chiave privata in JS.
- Nessun endpoint arbitrario dal frontend.

### Crittografia
- TLS 1.3.
- Server identity persistente e separata dai device.
- Pinning server.
- Device identity distinta e revocabile.
- Crittografia/protocolli maturi; niente primitive proprietarie.

### Media/upload
- Range e seek preservati.
- Upload nativo.
- Backpressure bounded.
- Nessun timeout totale ~30 s.

## C. Fasi

### D0 — baseline
Conservare il preflight verde e i lockfile correnti.

### D1 — Direct primario
Completare Transport Manager Direct e mantenere relay soltanto fallback.

### D2 — hardening Internet-facing
Pre-auth minimo, limiti per IP/globali, timeout, dimensioni bounded, parser stretto.

### D3 — TLS e pinning
TLS 1.3 only; hostname separato dall'identità; server sbagliato sempre rifiutato.

### D4 — pairing/bootstrap
Invito temporaneo, hostname pubblico 443, pin, device identity, revoca.

### D5 — servizio Windows ristretto
Connector come servizio/task con account privilegi minimi, ACL ProgramData, firewall specifico.

### D6 — DDNS e diagnostica
Health locale, verifica Node/Connector/DDNS/firewall/port-forward separatamente.

### D7 — test Internet reali
Da rete mobile, uno per volta:
1. handshake/pairing;
2. catalogo;
3. artwork;
4. video;
5. Range/seek;
6. media non-video;
7. upload piccolo;
8. upload grande;
9. richieste concorrenti;
10. revoke.

### D8 — resilienza/ostile
Scanner, malformed, oversize, slow client, restart Node/Connector/Windows/router, cambio IP/rete.

### D9 — packaging server
`BaiaServerSetup.exe`, servizi, firewall, wizard librerie, DDNS, istruzioni router, backup identità.

### D10 — packaging client
Android/Windows, poi altre piattaforme.

### D11 — aggiornamenti
Update firmati, rollback, migrazioni e compatibilità protocollo.

## D. Exit criterion finale

- Client fuori casa usa catalogo e media.
- Seek e upload grande funzionano.
- Node non è raggiungibile da Internet/LAN.
- Unico forwarding: TCP 443 -> Connector.
- Device revocato respinto.
- Server identity errata respinta.
- Nessun accesso generico a LAN/filesystem.
- Reboot host recupera automaticamente.
- Cambio IP gestito dal DDNS.
- Amici installano soltanto Baia.

## Ottimizzazione streaming video: keep-alive + direct media data plane

Implementazione introdotta sul canale `/baia/v1/media`:

- HTTP/1.1 persistente tra Tauri Media Bridge e Host Connector, con `KEEP_ALIVE_IDLE_TIMEOUT = 30s` e `MAX_REQUESTS_PER_CONNECTION = 200`;
- keep-alive equivalente sul server HTTP loopback del Media Bridge;
- per i video, il Media Bridge segmenta i Range remoti maggiori di 8 MiB in richieste Connector bounded da massimo 8 MiB, mantenendo verso la WebView un unico `206` con il `Content-Range` originario. Ogni segmento viene consumato integralmente e senza buffering completo in RAM, così la connessione TLS può tornare nel pool anche quando la WebView lavora con Range multi-GB;
- log non sensibili `connector_connection_id`, `request_index_on_connection`, `transport_reused`, `media_source` e `bytes_streamed`;
- `HEAD /api/movies/:id/stream` esplicito in Node per autorizzare e risolvere il file senza aprire `createReadStream`;
- feature flag `BAIA_DIRECT_MEDIA_DATA_PLANE=true` per spostare il body video da Node al Connector;
- `LIBRARY_PATH` è la source of truth condivisa: Node continua a essere l'autorità per device/account/section/content lookup, mentre il Connector usa la libreria solo dopo un descriptor emesso da Node;
- il descriptor usa un path relativo, viene consumato dal Connector e non viene inoltrato al client;
- il Connector rifiuta path assoluti, traversal, backslash, drive/URI, segmenti `.`/`..`, canonicalizza root e file e richiede che il file canonico rimanga sotto la root. Questo blocca anche symlink/junction che risolvono fuori libreria;
- il Connector apre solo `File::open` e fa `seek` + `take` + `std::io::copy`, senza bufferizzare il Range intero in RAM;
- Range singolo, suffix/open range, 416, `If-Range`, ETag e Last-Modified sono gestiti nel direct data plane;
- poster, musica, reading e upload restano sul percorso storico.

### Modello operativo e ACL

Quando `BAIA_DIRECT_MEDIA_DATA_PLANE=true`, il processo Host Connector deve poter leggere `LIBRARY_PATH`. In produzione assegnargli ACL di sola lettura (`READ`), senza `WRITE`, `DELETE` o `CREATE`. Node mantiene i privilegi necessari alle funzioni di gestione/upload.

### Data path

Prima:

```text
file -> Node -> loopback HTTP -> Host Connector -> TLS -> Tauri Media Bridge -> WebView
```

Dopo, con direct data plane attivo:

```text
control: Host Connector -> HEAD Node -> auth/account/permission/lookup -> descriptor
data:    file -> Host Connector -> TLS persistente -> Tauri Media Bridge -> WebView
```

La revoca resta immediata a granularità di richiesta: ogni segmento Connector viene nuovamente autorizzato da Node. Non è stata introdotta una cache di autorizzazione lunga.

### Baseline playback reale keep-alive

Sul test reale del 23 settembre 2026, prima della segmentazione client, 1027 richieste `/baia/v1/media` hanno prodotto 812 connessioni TLS distinte: 812 richieste con `transport_reused=false`, 215 con `transport_reused=true`, e `request_index_on_connection` non oltre 2. Il pooling era quindi funzionante ma insufficiente, perché la WebView apriva Range da centinaia di MB o diversi GB e li abbandonava durante seek/preload; una risposta HTTP/1.1 non consumata non può essere rimessa nel pool. La segmentazione bounded del Media Bridge è stata introdotta per rendere il riuso effettivo nel comportamento reale del player.
