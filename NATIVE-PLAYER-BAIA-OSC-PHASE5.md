# Baia Native Player — Phase 5 (libmpv + Baia OSC)

Base: **v9 tuning 1 / Phase 4** (contenuto equivalente a `550101c`, oggi ripristinato su `refactor-dati` tramite revert).

## Obiettivo

Questa patch non modifica il trasporto Phase 4. Introduce il primo player Film realmente nativo e verificabile, mantenendo Baia come unica finestra applicativa:

- `libmpv` resta il motore reale di playback, demux, decode, audio, cache, seek e rendering;
- `NativeMediaSource` e il protocollo `baia://` restano invariati;
- il vecchio Media Bridge/WebView resta disponibile come fallback;
- **non viene creata nessuna seconda top-level window Tauri o mpv**;
- libmpv riceve come `wid` l'`HWND` della finestra principale Baia e crea la propria child window video al suo interno;
- posizione, resize, minimizzazione, taskbar, titolo e chiusura della finestra restano quindi quelli di Baia;
- l'OSC standard mpv è disattivato e sostituito da un OSC grafico Baia custom.

Il catalogo WebView rimane vivo dietro il player. Quando il player viene chiuso, la child window mpv scompare e la stessa scheda Film torna immediatamente visibile.

## UI nativa Baia

Il file `src-tauri/resources/mpv/baia-osc.lua` replica i controlli del player Film attuale:

- Indietro / chiusura;
- play / pausa;
- timeline cliccabile e trascinabile;
- tempo rimanente e durata;
- volume verticale;
- fullscreen della **finestra Baia**;
- auto-hide dei controlli;
- indicazione di buffering;
- Space = play/pausa;
- frecce sinistra/destra = -10/+10 secondi;
- doppio click = fullscreen;
- Esc = esce dal fullscreen, oppure chiude il player se non fullscreen.

Titolo e metadati vengono mostrati nel player in fullscreen, come nel player Film WebView corrente.

Il fullscreen non viene delegato a una seconda finestra mpv: l'OSC invia una richiesta al Core Rust e Rust porta in fullscreen la finestra Tauri principale; la child window mpv segue automaticamente il parent.

## Rollout conservativo

In questa Phase 5 il nuovo player viene usato **solo per i Film**.

Le Serie restano intenzionalmente sul player WebView Phase 4: il player Serie possiede anche i controlli Episodio precedente/successivo e non vengono rimossi finché non saranno mappati correttamente nell'OSC nativo. Questo evita una regressione funzionale.

## Feature flag

Su Windows il Baia Native Player è ora il default se `libmpv-2.dll` e l'OSC sono disponibili.

Non impostare manualmente:

```powershell
$env:BAIA_NATIVE_VIDEO_PLAYER = "true"
```

Resta disponibile soltanto un emergency fallback esplicito:

```powershell
$env:BAIA_NATIVE_VIDEO_PLAYER = "false"
```

## Build Windows

La DLL non è versionata in Git. Prima della build verifica:

```powershell
Test-Path .\src-tauri\resources\libmpv\libmpv-2.dll
```

Deve restituire `True`.

Nel workflow Baia abituale: applica la patch alla branch, commit/push; poi sul PC di build fai pull e soltanto lì installa/builda:

```powershell
npm ci
npm.cmd run tauri -- build --bundles nsis
```

Il nuovo OSC Lua è una resource Tauri e viene incluso automaticamente nell'installer.

## Server

Questa patch è **client-only**.

Non modifica:

- `host-connector/src/main.rs`;
- `src-tauri/src/native_media_source.rs`;
- `src-tauri/src/connector_tls.rs`;
- dimensioni Range Phase 4;
- pool TLS;
- direct-file data plane.

Se il server è già sulla baseline Phase 4 corretta, **non ricompilare il Connector** per questo test.

## Test consigliato

Prima prova il Film leggero da circa 2.65 Mbps usato nei test precedenti.

Verifica nell'ordine:

1. catalogo e copertine sono normali;
2. Play resta nella stessa finestra **Baia Cinghiala**: non deve apparire una finestra “Player nativo”;
3. il video e l'OSC coprono l'area della finestra Baia, senza un secondo elemento in taskbar/Alt-Tab;
4. ridimensionando/minimizzando Baia il video segue la stessa finestra;
5. play/pausa, seekbar, volume e fullscreen funzionano;
6. Indietro/Esc chiudono il player e riportano alla stessa scheda Film;
7. il progresso riprende dal punto salvato e continua a essere salvato;
8. al server, durante il vero percorso `NativeMediaSource`, i Range devono finalmente riflettere il profilo nativo (1 -> 2 -> 4 MiB) invece dei chunk legacy da 8 MiB.

Per vedere gli ultimi Range server:

```bash
sudo journalctl -u baia-connector --since "2 minutes ago" --no-pager \
  | grep 'media_source=direct_file' \
  | tail -30
```

Nel log client Rust sono presenti firme esplicite:

```text
player_backend=libmpv media_source=native_media_source ui=baia-native-osc
```

## Cosa NON cambia ancora

Questa patch non tenta di ottimizzare ulteriormente seek, Range, cache o TLS. Prima serve un benchmark inequivocabile del vero percorso:

`Baia window -> libmpv child HWND -> NativeMediaSource -> Connector direct-file`.

Solo dopo quel test riprenderemo il tuning del seek/churn.

## Limitazioni del PoC grafico

L'OSC riproduce struttura e controlli del player Film WebView, ma il risultato pixel-perfect va verificato su Windows reale: font ASS, DPI e resa delle icone dipendono dal backend mpv/libass. La Phase 5 serve prima di tutto a validare l'architettura a finestra unica e il vero data path nativo; le rifiniture grafiche verranno fatte su screenshot del player reale.
