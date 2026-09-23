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
- il Media Bridge mantiene un unico `reqwest::blocking::Client` condiviso (clone dello stesso pool) per tutte le route registrate con lo stesso fingerprint;
- il keep-alive remoto verso `/baia/v1/media` è inizialmente consentito solo per `/api/movies/:id/stream`; poster, cover, music e reading inviano `Connection: close` per evitare che risorse brevi saturino `MAX_ACTIVE_CONNECTIONS_PER_IP`;
- keep-alive equivalente sul server HTTP loopback del Media Bridge;
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

La revoca resta immediata a granularità di richiesta: ogni nuova richiesta Range viene nuovamente autorizzata da Node. Non è stata introdotta una cache di autorizzazione lunga.


### Validazione reale keep-alive (23 settembre 2026)

La prima prova reale ha mostrato 1027 richieste media su 812 connessioni TLS distinte (215 richieste riutilizzate, massimo 2 richieste per connessione). Una successiva prova con segmentazione client da 8 MiB ha peggiorato il comportamento applicativo (cover/catalogo/video) senza migliorare il riuso in modo sufficiente: 221 richieste su 195 connessioni TLS, ancora massimo 2 richieste per connessione.

La segmentazione da 8 MiB è stata quindi rimossa nella V3. Il codice reale mostrava inoltre un `reqwest::blocking::Client` creato per route media, con pool separati potenzialmente in conflitto con `MAX_ACTIVE_CONNECTIONS_PER_IP = 16`. V3 ha introdotto un solo client condiviso e ha mantenuto il keep-alive remoto esclusivamente per il video. Il test reale V3 ha confermato che i rifiuti per limite connessioni sono scesi a 0 e che catalogo/cover/playback sono tornati stabili, ma il riuso TLS video è rimasto quasi invariato: 1321 richieste, 1042 connessioni TLS distinte, 279 richieste riutilizzate, massimo 2 richieste per connessione.

V4 ha mantenuto le protezioni V3 e reintrodotto bounded streaming soltanto per grandi forward Range video con segmenti da 32 MiB. Il test video-only ha però confermato che la connessione veniva ancora quasi sempre abbandonata prima di poter essere riutilizzata: 1479 richieste, 1173 connessioni TLS distinte, 306 richieste riutilizzate e massimo 2 richieste per connessione. In uso reale è stato inoltre osservato un pattern di buffering ripetuto dopo i seek e, su alcuni film, dopo playback prolungato, coerente con starvation del buffer durante churn di Range/TLS.

V5 ha mantenuto il pool condiviso e introdotto segmenti remoti da 8 MiB, massimo 2 long Range video concorrenti, coda bounded da 4 MiB e drain-on-cancel. Nei test reali ha finalmente soddisfatto il criterio TLS: 1855 richieste complessive su 32 TLS distinte (~98,3% richieste riutilizzate), massimo 200 richieste per connessione, 0 `Broken pipe` e 0 rifiuti per limite connessioni. Il playback ha però continuato a mostrare buffering ripetuto dopo seek e, su alcuni film, anche durante riproduzione prolungata. Questo indica che la priorità successiva è ridurre byte obsoleti/contesa di banda, non aumentare ulteriormente il reuse TLS.

V6 mantiene segmenti da 8 MiB e prefetch/backpressure bounded da 4 MiB, ma elimina le due long-lane concorrenti e il drain obbligatorio. Per ogni path video, un nuovo long Range rende immediatamente obsoleto il precedente (`latest-seek-wins`); producer e writer verificano una generazione condivisa a ogni blocco da 256 KiB e terminano il vecchio flusso senza consumarne il residuo remoto. Piccoli Range e suffix range restano indipendenti. La strumentazione V6 misura `bytes_from_connector`, `bytes_to_webview` e `bytes_discarded` per distinguere banda utile da overfetch. `BAIA_DIRECT_MEDIA_DATA_PLANE` deve restare `false` finché seek/playback lungo non risultano stabili.
