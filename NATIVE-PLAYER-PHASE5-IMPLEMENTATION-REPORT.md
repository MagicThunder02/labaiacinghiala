# Phase 5 implementation report

## Cambiamenti

- eliminata la seconda Tauri window PoC `baia-native-video`;
- libmpv viene agganciato direttamente all'`HWND` della finestra principale Tauri tramite `wid`;
- mpv crea una child window che riempie il parent: non nasce una seconda top-level window, taskbar item o finestra Alt-Tab;
- OSC standard mpv disabilitato e sostituito da `baia-osc.lua`;
- fullscreen richiesto dall'OSC viene applicato alla finestra Tauri principale dal Core Rust;
- metadata di presentazione (titolo/meta/accent/posizione iniziale/volume) passano al Core senza URL o segreti nel JS;
- resume/progresso Film mantenuto tramite polling high-level dello stato libmpv;
- volume nativo sincronizzato con la preferenza locale;
- player nativo Windows attivo di default se libmpv e OSC sono disponibili; `BAIA_NATIVE_VIDEO_PLAYER=false` resta emergency fallback;
- Serie lasciate sul WebView fino al porting di previous/next episode;
- networking Phase 4 invariato.

## File modificati

- `.env.example`
- `public/js/api-config.js`
- `public/js/films.js`
- `public/js/series.js` (solo rollout conservativo)
- `src-tauri/src/native_player.rs`
- `src-tauri/tauri.conf.json`
- `test/native-player-poc-contract.test.js`

Nuovi:

- `src-tauri/resources/mpv/baia-osc.lua`
- `NATIVE-PLAYER-BAIA-OSC-PHASE5.md`
- `NATIVE-PLAYER-PHASE5-IMPLEMENTATION-REPORT.md`

## Invarianti verificate

Confronto byte-for-byte con il pacchetto Phase 4:

- `src-tauri/src/native_media_source.rs`: invariato;
- `src-tauri/src/connector_tls.rs`: invariato;
- `host-connector/src/main.rs`: invariato.

Questa iterazione non modifica quindi Range, cache NativeMediaSource, pool TLS o direct-file server.

## Test eseguiti nell'ambiente patch

- `node --check public/js/api-config.js`
- `node --check public/js/films.js`
- `node --check public/js/series.js`
- test contratto native player;
- test analizzatore native player;
- test controllo volume video.

Esito mirato: **22/22 PASS**.

Non sono disponibili `cargo`/`rustc` né un runtime Windows/libmpv in questo ambiente. La build NSIS Windows resta quindi la verifica compilativa/runtime reale. Non è stato possibile eseguire Lua dentro mpv qui; il contratto OSC è verificato staticamente contro le API mpv usate.
