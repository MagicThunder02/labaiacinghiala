# Sviluppo e build

## Requisiti comuni

- Node.js `>=24.18.1 <25` e npm compatibile;
- Rust stable e Cargo;
- dipendenze installate con `npm ci`;
- nessuna porta pubblica per Node: il server host usa `127.0.0.1:3000`.

Controlli indipendenti dal browser:

```text
npm run typecheck
npm test
npm run build:frontend
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo test --locked --manifest-path host-connector/Cargo.toml
```

`npm test` usa `node:test`; non richiede Chrome o WebDriver. `dist/` è un artefatto generato
e non deve essere modificato a mano.

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

La configurazione base include il bundle `deb`. Il test dell'identità richiede una sessione
D-Bus e un keyring sbloccato; l'assenza del servizio è un errore esplicito, non attiva un
fallback su file.

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
