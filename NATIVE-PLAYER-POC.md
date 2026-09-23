# Baia Cinghiala — Native Player Gate A (mpv esterno)

Questo PoC implementa soltanto la **Fase 1** della roadmap native-player. Non introduce libmpv embedded, non rimuove il Media Bridge e non abilita il direct media data plane.

## Stato preservato

- `BAIA_DIRECT_MEDIA_DATA_PLANE=false` durante il Gate A.
- Il player WebView `<video>` resta il comportamento predefinito.
- Il Media Bridge V6 resta intatto per consentire un confronto sullo stesso trasporto esistente; la sua logica `latest-seek-wins` non viene copiata nel nuovo player.
- La chiave device, il grant, il pin TLS e l'URL media temporaneo restano nel Core Rust.
- Il JavaScript passa al native player soltanto `movieId`.

## Prerequisiti

- Node.js `>=24.18.1 <25` come richiesto da `package.json`.
- Dipendenze installate con `npm ci`.
- Toolchain Rust/Cargo compatibile con il progetto.
- `mpv` installato sul client e disponibile nel `PATH`, oppure `BAIA_MPV_EXECUTABLE` configurato nel processo Tauri.
- Server Baia + Host Connector reali raggiungibili.

## 1. Baseline WebView

Lasciare:

```text
BAIA_NATIVE_VIDEO_PLAYER=false
BAIA_DIRECT_MEDIA_DATA_PLANE=false
```

Avviare lo stesso build/client usato per il test mpv e riprodurre **lo stesso film sulla stessa rete**.

Sequenza minima:

1. start;
2. seek avanti;
3. seek indietro;
4. 20 seek rapidi;
5. pause/resume;
6. playback continuo 30–60 minuti;
7. fine film, se praticabile.

Conservare separatamente:

- log Host Connector;
- stderr/log del client Tauri contenente gli eventi `video_range_id=...`.

## 2. PoC mpv esterno

Impostare:

```text
BAIA_NATIVE_VIDEO_PLAYER=true
BAIA_DIRECT_MEDIA_DATA_PLANE=false
```

Opzionale, se `mpv` non e nel `PATH` del processo Tauri:

```text
BAIA_MPV_EXECUTABLE=<percorso-eseguibile-mpv>
```

Riavviare completamente il client Tauri. Quando si apre un Film o Episodio, il Core Rust:

1. riceve soltanto `movieId`;
2. genera internamente `/api/movies/:id/stream`;
3. registra una URL locale temporanea nel Media Bridge;
4. avvia `mpv` in una finestra separata con argomenti fissi;
5. non inoltra URL/path/comandi arbitrari dal JavaScript.

Il PoC usa `--no-config` per evitare che configurazioni o script mpv locali alterino il confronto.

Ripetere la stessa sequenza della baseline WebView sullo stesso film e sulla stessa rete.

> In questa fase seek/pause/resume vengono eseguiti tramite i controlli standard della finestra mpv. L'integrazione dei controlli Tauri e libmpv embedded appartiene ai gate successivi.

## 3. Analisi automatica dei log

Eseguire:

```bash
npm run analyze:native-player-poc -- connector.log client.log
```

Oppure solo con il Connector:

```bash
npm run analyze:native-player-poc -- connector.log
```

L'analizzatore riporta:

- richieste sul canale `/baia/v1/media`;
- connessioni TLS distinte;
- richieste con `transport_reused=true`;
- percentuale di riuso;
- massimo `request_index_on_connection`;
- righe `Broken pipe`;
- Range video completati/superseded/disconnessi;
- segmenti;
- byte dal Connector, byte al consumer e byte scartati.

## 4. Riferimenti V5/V6 da non perdere

V5 resta il riferimento positivo per il trasporto:

```text
Test 1: 887 richieste, 18 TLS, 869 reused, max index 200, Broken pipe 0
Test 2: 968 richieste, 14 TLS, 954 reused, max index 200, Broken pipe 0
```

V6 resta il riferimento negativo per l'abort aggressivo:

```text
Test 1: 452 richieste, 349 TLS, 103 reused, max index 5, Broken pipe 340
Test 2: 5689 richieste, 4722 TLS, 967 reused, max index 14, Broken pipe 4402
```

Il Gate A non richiede che mpv replichi esattamente V5. La priorita e verificare, sullo stesso file/rete, se mpv produce:

- seek piu stabile;
- meno buffering;
- playback lungo piu stabile;
- pattern Range meno patologico;
- nessuna regressione grave di connessioni/Broken pipe.

## 5. Gate

**GO verso libmpv embedded** soltanto se i dati reali confermano un vantaggio significativo di mpv rispetto alla WebView.

**NO-GO** se mpv mostra sostanzialmente gli stessi problemi: in quel caso investigare throughput, server, rete e bitrate prima di cambiare ulteriormente la UI.

## Limitazioni intenzionali del PoC

- Nessun embedding libmpv.
- Nessun `baia://` custom stream.
- Nessuna rimozione del Media Bridge video.
- Nessun direct-file data plane abilitato.
- Nessun tracking progresso dal processo mpv esterno.
- Nessun controllo mpv arbitrario esposto al JavaScript.
