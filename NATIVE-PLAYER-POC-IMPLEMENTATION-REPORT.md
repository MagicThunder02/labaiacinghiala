# Native Player PoC — Implementation Report

## Baseline ricostruita

Lo ZIP consegnato contiene lo stato V6 del Media Bridge:

- `src-tauri/src/media_bridge.rs` implementa `latest-seek-wins` per i long Range video;
- il trasporto Connector mantiene keep-alive bounded e metriche `connector_connection_id`, `request_index_on_connection`, `transport_reused`;
- `BAIA_DIRECT_MEDIA_DATA_PLANE=false` e il direct-file Connector e gia presente dietro feature flag;
- il frontend assegna ancora la URL del Media Bridge a `<video>`;
- lo ZIP non contiene `.git`, quindi la baseline e stata ricostruita direttamente dai file e da `HANDOFF.md`/roadmap.

Il riferimento V5 documentato resta positivo per il keep-alive; V6 resta negativo per churn/Broken pipe. La modifica non riscrive ne copia la politica V6 nel native player.

## Modifica implementata — Gate A / Fase 1

Aggiunto un PoC **mpv esterno**, disabilitato per default:

- `BAIA_NATIVE_VIDEO_PLAYER=false` mantiene il comportamento legacy;
- con flag `true`, Film e Serie provano il PoC mpv prima di usare `<video>`;
- il JavaScript passa soltanto `movieId`;
- il Core Rust genera internamente la route `/api/movies/:id/stream` e la registra nel Media Bridge;
- mpv riceve soltanto una URL locale temporanea creata dal Core;
- nessuna chiave, grant, pin TLS, filesystem path o URL arbitraria viene fornita al JavaScript;
- gli argomenti mpv sono fissi e il processo viene gestito da uno state Rust dedicato;
- `--no-config` riduce le variabili del test evitando config/script mpv utente;
- stdout/stderr mpv sono soppressi per non riversare URL temporanee nei log applicativi;
- il precedente processo mpv viene terminato quando si apre un nuovo media o tramite comando stop.

Non sono stati implementati libmpv embedded, custom `baia://`, direct data plane attivo o rimozione del Media Bridge: richiedono prima il GO del Gate A.

## Analisi log aggiunta

`scripts/analyze-native-player-poc.js` calcola dai log reali:

- richieste `/baia/v1/media`;
- TLS distinte;
- richieste riusate e percentuale di reuse;
- massimo request index;
- Broken pipe;
- Range video complete/superseded/client-disconnected;
- segment count;
- byte dal Connector, al consumer e scartati.

Comando:

```bash
npm run analyze:native-player-poc -- connector.log client.log
```

## File modificati / aggiunti

- `.env.example`
- `package.json`
- `public/js/api-config.js`
- `public/js/films.js`
- `public/js/series.js`
- `src-tauri/src/lib.rs`
- `src-tauri/src/media_bridge.rs`
- `src-tauri/src/native_player.rs` (nuovo)
- `scripts/analyze-native-player-poc.js` (nuovo)
- `test/native-player-poc-contract.test.js` (nuovo)
- `test/native-player-log-analysis.test.js` (nuovo)
- `NATIVE-PLAYER-POC.md` (nuovo)

## Test eseguiti in questo ambiente

Passano **58/58 test mirati** usando solo componenti disponibili localmente:

- `test/api-config.test.js`
- `test/host-connector-contract.test.js`
- `test/range.test.js`
- `test/native-player-poc-contract.test.js`
- `test/native-player-log-analysis.test.js`
- syntax check di `api-config.js`, `films.js`, `series.js`

## Test non eseguibili qui

La suite completa non e stata marcata come eseguita perché l'ambiente corrente non soddisfa i prerequisiti del progetto:

- Node installato: `v22.16.0`; `package.json` richiede `>=24.18.1 <25`;
- `node_modules` non e incluso nello ZIP e l'ambiente non dispone di risoluzione DNS outbound per scaricarlo;
- `cargo` e `rustc` non sono installati;
- `mpv` non e installato;
- `media/` non contiene un film di test;
- il server/Host Connector reale e la rete dei benchmark V5/V6 non sono disponibili.

Quindi restano obbligatori sulla macchina Baia:

1. `npm ci` con Node 24.18.1+;
2. `npm run test:all`;
3. build Tauri/Cargo;
4. baseline WebView reale;
5. test mpv reale sullo stesso film/rete;
6. analisi log;
7. decisione GO/NO-GO prima di iniziare libmpv embedded.

## Stato del Gate A

**Implementazione pronta per il test reale; Gate A non ancora deciso.**

Non esiste evidenza in questo ambiente per dichiarare che mpv riduca buffering o migliori il seek. La roadmap richiede che tale evidenza venga misurata prima di procedere alla Fase 2.
