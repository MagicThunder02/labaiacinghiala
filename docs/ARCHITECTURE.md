# Architettura Baia Cinghiala

Questo documento descrive la baseline del refactoring incrementale iniziato a settembre 2026.
Gli invarianti di sicurezza di `HANDOFF.md` e `docs/ROADMAP-DIRECT-TCP443.md` restano
vincolanti.

## Topologia

```text
Client Tauri 2
  Svelte/Vite statico -> bridge comandi ristretto -> Baia Core Rust
                                               |
                                 TCP 443, TLS 1.3, pinning
                                               |
Internet -> router host -> Host Connector Rust:43127
                              |
                    solo http://127.0.0.1:3000
                              |
             Express 5 -> servizi -> node:sqlite -> media host
```

Il client iOS contiene solo asset statici e Baia Core. Non avvia Node, non apre il database
SQLite dell'host e non conserva la libreria media. L'URL logico
`http://127.0.0.1:3000` presente nel protocollo serve a firmare richieste compatibili con
Node: il trasporto fisico iOS usa il Connector remoto configurato dal pairing.

Node ascolta esclusivamente sull'host configurato, che in produzione deve rimanere
`127.0.0.1`. Il Connector ha un upstream costante verso `127.0.0.1:3000`; non accetta
destinazioni arbitrarie e applica le allowlist distinte per API, media e upload.

## Confini dei componenti

- `src/app.js`: costruisce Express tramite `createApp()` senza aprire socket. Database,
  configurazione, router, autenticazione device e directory statica sono iniettabili.
- `src/server.js`: bootstrap del processo, inizializzazione storage/identità, listener,
  backup, riconciliazione e shutdown.
- `src/routes/`: adapter HTTP. Le route migrate usano factory; le route legacy restano
  compatibili durante la conversione graduale.
- `src/services/`: casi d'uso e servizi di dominio. Alcuni moduli legacy importano ancora
  direttamente `src/database.js`; rimuovere questo debito un dominio per volta.
- `src/database.js`: schema e migrazioni SQLite esistenti. Usa WAL, foreign key e
  `busy_timeout=5000`; lo schema e il `user_version` non sono stati modificati in questa fase.
- `public/`: pagine vanilla ancora operative.
- `public/_modern/`: prima isola Svelte, client API tipizzato e bridge Tauri ristretto.
- `vite.config.ts`: build MPA statica in `dist/`, senza SSR. Copia gli asset legacy e
  innesta Svelte soltanto nella shell principale.
- `shared/`: contratti API TypeScript e validatori runtime riusabili senza cambiare i payload.
- `src-tauri/`: Core client Rust, pairing, identità device, trasporto, media bridge e upload.
- `host-connector/`: unico processo esposto; TLS 1.3, pinning, grant firmati, prova Ed25519,
  limiti e forwarding allowlistato verso Node loopback.
- `relay/`: fallback futuro; non è nel percorso Direct TCP 443 primario.

## Mappa HTTP

L'ordine dei middleware è parte del contratto. `/api/health` e il redeem del pairing vengono
prima dell'autenticazione device. Le altre API richiedono la prova device; dopo `/api/auth`
si applicano sessione account, cambio password e autorizzazioni di sezione/amministrazione.

| Prefisso | Operazioni principali | Protezione |
| --- | --- | --- |
| `/api/health` | health del processo | loopback/Connector, senza device |
| `/api/pairing/redeem` | consumo invito e registrazione device | invito firmato, prima del device auth |
| `/api/auth` | login, logout, sessione, cambio password | device; alcune operazioni richiedono account |
| `/api/app-info` | capacità e configurazione pubblica | device |
| `/api/movies` | catalogo, home, filtri, dettagli, poster, stream, stato utente | account + sezione |
| `/api/series` | catalogo, home, filtri, dettagli, poster, simili | account + sezione |
| `/api/reading` | catalogo, filtri, cover/file, manifest/entry reader, bookmark | account + categoria |
| `/api/music` | home, ricerca, album/artisti/tracce, cover/stream, preferiti, playlist | account + sezione |
| `/api/admin/accounts` | amministrazione account | admin |
| `/api/admin/pairing-invites` | elenco, creazione, revoca inviti | browser locale + admin |
| `/api/admin/paired-devices` | elenco e revoca device | browser locale + admin |
| `/api/library` | stato libreria | admin |
| `/api/metadata` e `/api/metadata/music` | editor metadati e artwork | admin |
| `/api/uploads` | stato, scansione musica, sessioni e import media | admin; ricezione lunga esplicita |

I file in `src/routes/` sono l'elenco autorevole dei sotto-path. Il Connector conserva
allowlist più strette per media e upload e normalizza sempre path relativi `/api/...`.

## Servizi applicativi e persistenza

I domini attuali sono:

- auth/account: `account-*-service.js` e middleware `account-*`;
- pairing/device: `pairing-service.js`, `device-auth-service.js`;
- film/serie: filtri, home/simili, metadata e upload dedicati;
- reading: catalogo, archivi, bookmark, metadata e upload;
- music: catalogo, cover, preferiti, ascolti, playlist, tag, import e sessioni upload;
- library/storage: identità libreria, path relativi, disponibilità, riconciliazione e migrazione;
- metadata/delete: override, poster gestiti e cancellazione transazionale;
- backup: snapshot SQLite giornalieri/mensili con retention.

SQLite resta basato sul modulo integrato `node:sqlite`, senza ORM. I percorsi persistiti
restano relativi alla libreria e i database esistenti continuano a essere aperti dalle stesse
migrazioni additive. Ogni futura modifica di schema deve mantenere backup prima della
migrazione, transazione, `foreign_key_check`, `integrity_check` e avanzamento monotono del
`user_version`.

## Pairing, autenticazione e crittografia

- Gli inviti, il loro formato e la procedura di redeem non cambiano.
- Ogni installazione client possiede un'identità Ed25519 distinta e revocabile.
- La chiave privata rimane nel Core nativo: Windows Credential Manager, Linux Secret
  Service, macOS Keychain e iOS Keychain. Non esiste fallback in chiaro.
- Il frontend può invocare solo comandi semantici. Non è disponibile un IPC per firmare
  byte arbitrari.
- Il Connector verifica TLS 1.3, pin del server, grant firmati e prova device prima di
  inoltrare a Node.

## Upload, streaming e shutdown

Gli upload multipart autorizzati disabilitano la deadline totale soltanto dopo i controlli
device/account/admin. Rimane un timeout di inattività; Multer e i servizi rimuovono i file
parziali. Le operazioni native usano token opachi e il Core costruisce il multipart senza
esporre percorsi al frontend. Android e iOS copiano i file selezionati dal provider nella
cache privata prima dell'upload.

Film, musica e risorse reading mantengono Range/seek e streaming bounded. Il Connector non
reintroduce un timeout totale per media o upload. Lo shutdown smette di accettare nuove
connessioni e chiude SQLite anche in caso di timeout della chiusura HTTP.

## Comandi Tauri

| Area | Comandi |
| --- | --- |
| bootstrap/configurazione | `baia_core_bootstrap`, `baia_core_set_server_endpoint`, `baia_core_reset_server_endpoint`, `baia_core_probe_server` |
| identità/autorizzazione | `baia_core_device_identity`, `baia_core_authorize_request`, `baia_core_authorize_media_url` |
| pairing | `baia_core_pairing_status`, `baia_core_pair_with_invite` |
| trasporto | `baia_core_api_request` |
| media | `baia_core_media_bridge_url` |
| upload | `baia_core_pick_upload_files`, `baia_core_release_upload_files`, `baia_core_upload_files` |
| aggiornamento client | `baia_core_update_status`, `baia_core_update_install` |

Il wrapper TypeScript esporta intenzionalmente solo il sottoinsieme richiesto dalla prima
isola. Ogni estensione deve rimanere tipizzata e orientata a un'operazione Baia specifica.

## Aggiornamento del client

Il client desktop si aggiorna da solo: `src-tauri/src/updater.rs` usa `tauri-plugin-updater`
per leggere `latest.json` dall'ultima release GitHub pubblicata, verifica la firma minisign con
la chiave pubblica in `src-tauri/tauri.conf.json` e installa il bundle. Il frontend vede
soltanto i due comandi di dominio: nessun IPC accetta URL, percorsi o comandi dal chiamante.

- endpoint: `https://github.com/MagicThunder02/labaiacinghiala/releases/latest/download/latest.json`;
- bundle aggiornabili: NSIS su Windows, AppImage su Linux; `deb` e Flatpak restano al gestore
  pacchetti e il Core lo dichiara con `supported: false` invece di scaricare;
- su Android il percorso è separato (`src-tauri/src/updater_android.rs`): il plugin non installa
  nulla su mobile, quindi il client legge `latest-android.json` dallo stesso endpoint, verifica la
  firma minisign dell'APK con la stessa chiave e lo consegna al package installer di sistema, che
  chiede conferma all'utente. La chiamata all'installer passa da JNI (`jni_handle`), senza moduli
  Kotlin aggiuntivi, e il file sta nella cache dell'app già coperta dal FileProvider;
- su iOS il comando risponde "non supportato": l'aggiornamento passa dallo store;
- UI: Profilo -> Aggiornamenti, visibile solo dentro l'app, con controllo automatico all'apertura.

Il server Node **non** è coinvolto: quel deploy si aggiorna a parte sull'host (git pull
pianificata), senza alcuna azione esposta nell'interfaccia.

## Matrice piattaforme

| Funzione | Windows | Linux | macOS | iOS |
| --- | --- | --- | --- | --- |
| client Tauri | supportato | supportato | configurato, build da verificare su macOS | configurato, build da verificare con Xcode |
| aggiornamento in-app | NSIS | AppImage (deb/Flatpak no) | bundle app, da qualificare | no, store di sistema |
| identità device | Credential Manager | Secret Service | Keychain | Keychain |
| selezione/upload | path desktop | path desktop | path desktop | provider -> cache privata |
| Node/SQLite/media host | sì | sì | compatibile, da qualificare su macOS | mai incluso |
| Host Connector | sì | sì | percorso identità nativo, da qualificare | non è un server iOS |

Su Windows non sono installati SDK/target Apple e Xcode non è disponibile: test statici
controllano le configurazioni e i branch `cfg`, ma non sostituiscono una build o test Keychain
su hardware Apple.

## Dipendenze specifiche e test

- `keyring`: backend Windows, Secret Service Linux e Security.framework Apple.
- `tauri-plugin-dialog` e `tauri-plugin-fs`: selezione e accesso file nativo/mobile.
- `tauri-plugin-updater` (solo desktop): download e verifica firma delle release del client.
- `jni`, `minisign-verify`, `semver`, `webpki-roots` (solo Android): manifesto, verifica della firma
  e consegna dell'APK al package installer. Le radici TLS sono incluse nel binario perché il
  verificatore di piattaforma di rustls richiederebbe un componente Kotlin.
- `rustls`: TLS 1.3 e pinning nel Core e nel Connector.
- `node:test`: unità, integrazione, contratti e regressioni UI statiche.
- test Rust: firma/verifica Ed25519, pairing, allowlist, trasporto, pinning, Range e upload.
- `tsc --strict` e `svelte-check`: contratti e prima area Svelte.

## Incompatibilità e lavoro residuo

Le incompatibilità Apple concrete della baseline erano storage sicuro non implementato,
upload iOS instradato come path desktop, endpoint fisico iniziale loopback e assenza di config
Apple. Questi punti ora hanno adapter/configurazioni espliciti. Restano da verificare su macOS:
Keychain reale, sandbox/entitlement, picker iOS con provider iCloud, media bridge durante
backgrounding, rotazione/orientamento, code signing e packaging. La conversione dei servizi
legacy con import globale del database e delle pagine vanilla proseguirà per dominio.
