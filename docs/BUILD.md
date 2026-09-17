# Sviluppo e build

## Requisiti comuni

- Node.js `>=24.18.1 <25` e npm compatibile;
- Rust stable e Cargo;
- dipendenze installate con `npm ci`;
- nessuna porta pubblica per Node: il server host usa `127.0.0.1:3000`.

Controlli indipendenti dal browser:

```text
npm run typecheck
npm run test:backend
npm run test:frontend
npm run test:frontend:coverage
npm run test:rust
npm run test:all
npm run build:frontend
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo test --locked --manifest-path host-connector/Cargo.toml
```

`npm run test:backend` usa `node:test` per unità, integrazione API e contratti legacy.
`npm run test:frontend` usa Vitest e jsdom per eseguire TypeScript e componenti Svelte in un
DOM isolato, senza Chrome o WebDriver. `npm test` esegue entrambe le suite JavaScript anche
se una fallisce e restituisce un unico exit code; `npm run test:all` aggiunge typecheck e i
test Rust di Host Connector e Core Tauri. La CI
GitHub esegue inoltre la build frontend. `dist/` e `coverage/` sono artefatti generati e non
devono essere modificati a mano.

## Sviluppo server e frontend

Avvia Node:

```text
npm start
```

In un secondo terminale, per il frontend Vite con proxy API verso Node:

```text
npm run dev:frontend
```

La build statica è:

```text
npm run build:frontend
```

Vite emette tutte le pagine HTML e gli asset legacy in `dist/`; non usa SSR. Il bootstrap
Tauri esegue automaticamente questa build tramite `beforeBuildCommand`.

## Server host

Il server Node funziona con gli stessi file e lo stesso schema SQLite su Windows, Linux e
macOS. Configurare `.env` come descritto nella documentazione operativa, mantenendo
`HOST=127.0.0.1` e `PORT=3000`. Prima di migrazioni o test distruttivi usare una copia di
database e libreria.

Per il Connector:

```text
npm run connector:test
npm run connector:build
```

Su Windows e Linux usare gli installer in `tools/direct-host/`. Su macOS il default
interattivo dell'identità è `~/Library/Application Support/Baia/HostConnector`; per un
servizio impostare `BAIA_CONNECTOR_DATA_DIR` a una directory assoluta con accesso ristretto.
Il bind deve essere un IPv4 loopback o RFC1918 specifico, mai `0.0.0.0`.

## Windows client

Richiede toolchain Rust MSVC, Visual Studio Build Tools e WebView2. Verifica senza bundle:

```text
npm run tauri build -- --debug --no-bundle
```

Per il pacchetto configurato:

```text
npm run tauri build
```

## Linux client

Installare i prerequisiti Tauri 2 della distribuzione, inclusi WebKitGTK, librerie GTK,
OpenSSL/build tools e Secret Service disponibile nella sessione utente. Quindi:

```text
npm run tauri build
```

La configurazione base include i bundle `deb` e `appimage` (l'AppImage è l'unico formato Linux
che l'updater sa sostituire da solo). Il test dell'identità richiede una sessione
D-Bus e un keyring sbloccato; l'assenza del servizio è un errore esplicito, non attiva un
fallback su file.

## Release firmate e aggiornamento automatico del client

Il client installato si aggiorna dalla propria interfaccia (Profilo -> Aggiornamenti). Perché
funzioni serve una release GitHub pubblicata con i bundle firmati e `latest.json`.

Chiavi di firma (minisign, generate una sola volta, **mai** nel repository):

```text
npm run tauri -- signer generate -w "%USERPROFILE%\.baia\baia-updater.key"
```

- la chiave pubblica sta in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`);
- la privata va nei secret del repository come `TAURI_SIGNING_PRIVATE_KEY`, con
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (vuoto se la chiave è senza password);
- se la chiave viene sostituita, i client già installati non accettano più le nuove release
  finché non vengono reinstallati a mano: la sostituzione è una decisione, non una manutenzione.

Pubblicare una versione:

1. allinea la versione in `package.json`, `src-tauri/Cargo.toml` e `src-tauri/tauri.conf.json`;
2. `node scripts/check-release-version.js v0.6.0` deve passare (lo rifà anche la CI);
3. crea e spingi il tag `v0.6.0`;
4. `.github/workflows/release.yml` costruisce NSIS (Windows) e AppImage/deb (Ubuntu 22.04),
   firma i bundle e allega `latest.json` a una release **in bozza**;
5. pubblica la bozza: solo allora i client vedono l'aggiornamento, perché l'endpoint è
   `/releases/latest/download/latest.json`.

Da quando `createUpdaterArtifacts` è attivo, una build con bundle aggiornabile (NSIS, AppImage)
richiede la chiave privata anche in locale, altrimenti il bundler si ferma: è voluto, un bundle
non firmato non sarebbe installabile dall'updater. In locale:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content "$env:USERPROFILE\.baia\baia-updater.key" -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''
npm run tauri build
```

Per provare l'app senza pacchettizzare resta valido `npm run tauri build -- --debug --no-bundle`,
che non tocca la firma. Il Flatpak costruisce esplicitamente `--bundles deb` e non è interessato.

L'updater sostituisce NSIS su Windows e AppImage su Linux. Un client installato da `deb` o da
Flatpak dichiara l'aggiornamento non disponibile e rimanda al gestore pacchetti; su iOS e
Android l'aggiornamento passa dallo store.

## macOS client e host

La build deve essere eseguita su macOS con Xcode completo, Command Line Tools, una toolchain
Rust per l'architettura desiderata e le dipendenze Tauri 2. Il file
`src-tauri/tauri.macos.conf.json` viene unito automaticamente alla configurazione base.

```text
npm ci
npm run typecheck
npm run build:frontend
cargo test --locked --manifest-path src-tauri/Cargo.toml
npm run tauri build
```

Il bundle usa hardened runtime e target `app`/`dmg`. Distribuzione e notarizzazione richiedono
certificati Apple appropriati; non aggiungere entitlement finché una capability effettiva non
lo richiede. Qualificare inoltre il server Node e il Connector con la stessa suite eseguita su
Windows/Linux.

## iOS

Sono obbligatori un Mac, Xcode, gli SDK iOS, un Apple Developer account per device/release e
i target Rust Apple. Verificare prima l'ambiente con:

```text
npm run tauri info
```

Se il progetto Xcode generato non esiste ancora, inizializzarlo una sola volta e revisionare
il diff prima di conservarlo:

```text
npm run tauri ios init
```

Build e apertura del progetto usano i comandi Tauri iOS:

```text
npm run tauri ios build
npm run tauri ios dev
```

La configurazione `src-tauri/tauri.ios.conf.json` imposta viewport mobile e versione minima.
L'app iOS contiene `dist/` e la libreria Rust: non contiene Node, SQLite host o media. Prima di
una release provare su simulatore e dispositivo reale Keychain, pairing Direct, pinning,
picker/iCloud, upload grande, Range/seek, rotazione, sospensione e ripresa. Signing,
provisioning profile e capability devono essere impostati nel progetto Apple senza allentare
App Transport Security per raggiungere Node in chiaro: il traffico remoto passa dal Connector
TLS.

## Limiti del cross-build

Una build Windows non certifica macOS/iOS. In particolare Security.framework, Keychain,
WebKit iOS, signing, provisioning ed entitlements richiedono macOS/Xcode. Se tali prerequisiti
non sono disponibili, registrare il target come non verificato e mantenere solo i test statici;
non dichiarare una build simulata come risultato.
