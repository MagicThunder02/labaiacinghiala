# Baia Native Player — Phase 4 implementation report

## Scopo

Stabilizzare il trasporto della NativeMediaSource senza cambiare il modello storage: un solo file originale, libmpv embedded e Connector direct-file.

## File modificati

- `.env.example`
- `src-tauri/src/connector_tls.rs`
- `src-tauri/src/native_media_source.rs`
- `src-tauri/src/native_player.rs`
- `host-connector/src/main.rs`
- `scripts/analyze-native-player-poc.js`
- `test/native-player-poc-contract.test.js`
- `test/native-player-log-analysis.test.js`
- `test/host-connector-contract.test.js`

## Modifiche chiave

1. Profilo cache mpv esplicito (45 s target, pause wait 5 s, demux cache 64/32 MiB, seekable cache, hysteresis 15 s, stream buffer 2 MiB).
2. Range NativeMediaSource adattivi 1 -> 2 -> 4 MiB.
3. Sliding window locale default 16 MiB, bounded 8..32 MiB.
4. `cancel_fn=None`: nessun latest-seek-wins a livello stream callback.
5. Range consumati interamente prima di riutilizzare la connessione.
6. Due client media TLS dedicati, un idle connection per client; metadata client separato.
7. Logging direct-file esteso con requested bytes, streamed bytes, disconnect e control-plane latency.
8. Analizzatore PoC aggiornato per Phase 4 e compatibile con log Phase 3.

## Sicurezza preservata

- JavaScript continua a passare solo `movieId`.
- URI `baia://` contiene solo token interno generato dal Core.
- chiave privata/device auth restano in Rust.
- pin TLS invariato.
- Connector continua a validare grant/device auth e Node resta autorità.
- direct-file mantiene canonicalizzazione/path validation già presenti.
- nessun URL/file arbitrario apribile dal JS.

## Test eseguiti in questo ambiente

Comando:

```text
node --test test/native-player-poc-contract.test.js test/native-player-log-analysis.test.js test/host-connector-contract.test.js test/range.test.js
```

Risultato: **38/38 pass**.

`node --check scripts/analyze-native-player-poc.js` passa.

## Limitazioni della validazione locale

Questo ambiente non contiene `cargo`/`rustc`, quindi non è stato possibile eseguire:

```text
cargo test --locked --manifest-path host-connector/Cargo.toml
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

La prima build Windows e la build Connector Linux della branch sono quindi anche la verifica compilativa Rust reale della patch.

L'ambiente ha Node 22.16.0, mentre il progetto richiede Node >=24.18.1 <25; i test Node mirati sopra non dipendono dalle dipendenze npm e sono passati, ma `npm run test:all` completo non è stato eseguito qui.

## Ipotesi verificata dal prossimo test

La Phase 3 produceva quasi un Broken pipe/TLS nuova per ogni richiesta. Phase 4 verifica specificamente se la causa dominante era la cancellazione/chiusura prematura del custom stream e il mancato consumo completo dei Range.

Non viene ancora introdotto un worker Rust parallelo: prima si misura se mpv + Range bounded + keep-alive sano sono sufficienti, mantenendo il layer custom il più semplice possibile.
