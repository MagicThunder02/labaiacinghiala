# Piano di refactoring incrementale

## Invarianti

- protocollo, endpoint, payload, inviti, schema SQLite e regole di autorizzazione restano
  compatibili;
- Node rimane su `127.0.0.1:3000` e il Connector è l'unico ingresso remoto;
- TLS 1.3, pinning, Ed25519, grant firmati e allowlist non vengono indeboliti;
- nessuna chiave privata o firma arbitraria passa al frontend;
- ogni fase lascia server e pagine legacy avviabili.

## Fase 1 — fondazioni verificabili

Stato: implementata in questo batch.

- separare `createApp()` dal bootstrap e rendere iniettabili dipendenze/route;
- attivare TypeScript strict con `allowJs`, mantenendo il runtime CommonJS;
- introdurre contratti e validazione runtime condivisi;
- aggiungere Vite MPA statico e una piccola isola Svelte nella shell;
- aggiungere adapter Apple per Keychain, upload mobile ed endpoint non-loopback;
- aggiungere configurazioni macOS/iOS e documentazione di build;
- conservare schema SQLite, pagine vanilla e API.

## Fase 2 — un dominio backend alla volta

Ordine consigliato: auth/pairing, upload, music, movies/series, reading, metadata/library.
Per ogni dominio: tipi, schema di input esplicito, repository SQLite iniettato, servizio puro,
route sottile, test integrazione. Convertire file `.js` in `.ts` senza passare insieme a ESM o
cambiare framework. Rimuovere `allowJs` solo dopo l'ultimo dominio.

Priorità tecniche: eliminare gli import globali di `src/database.js`, centralizzare errori
tipizzati, rendere iniettabili clock/filesystem nei test di upload e aggiungere casi reali per
disconnect, file parziale e shutdown durante import.

## Fase 3 — shell Svelte e stato condiviso

Portare nella shell navigazione, account/sessione, error boundary e stato del Core. Migrare poi
Music come prima area completa: catalogo, filtri, player e upload. Ogni pagina convertita deve
mantenere URL, accessibilità, tastiera, touch e fallback vanilla fino al cutover verificato.

## Fase 4 — qualificazione multipiattaforma

- CI Windows e Linux per Node, Rust, TypeScript e Vite;
- runner macOS per Core, Connector e bundle `.app`;
- simulatore e device iOS per Keychain, picker, trasporto, media e lifecycle;
- packaging/signing per piattaforma, entitlements minimi e test upgrade;
- matrice di interoperabilità tra versioni client/Connector/server.

## Fase 5 — rimozione controllata del legacy

Solo dopo copertura funzionale e confronto delle API: rimuovere pagine vanilla migrate,
disabilitare `allowJs`, valutare ESM in un batch separato e pulire adapter non più usati. Non è
previsto sostituire Express, SQLite o Tauri in questa sequenza.
