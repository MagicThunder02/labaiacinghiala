# Baia Cinghiala — Native Player embedded / Fase 2 Windows

## Obiettivo

Questa patch sostituisce il PoC basato su `mpv.exe` esterno con **libmpv caricata nello stesso processo Tauri/Rust**.

Il data path resta volutamente invariato durante questo passaggio:

```text
libmpv embedded
  -> HTTP localhost Media Bridge
  -> Connector TLS
  -> server
```

Questo permette di separare il problema "player/rendering" dal successivo lavoro sul trasporto.

## Cosa cambia

- nessun `Command::new("mpv")`;
- nessun `BAIA_MPV_EXECUTABLE`;
- finestra video nativa Tauri/Win32 creata on-demand;
- libmpv usa l'`HWND` della finestra tramite `wid`;
- `movieId` resta l'unico identificatore media accettato dal frontend;
- Media Bridge, autorizzazione, device key e TLS pinning restano in Rust;
- comandi high-level disponibili: play, pause, seek, volume, stop;
- diagnostica disponibile: posizione, durata, seek, cache, buffering, hwdec e codec;
- fallback WebView ancora disponibile con `BAIA_NATIVE_VIDEO_PLAYER=false`.

## DLL libmpv: non va su Git

La DLL viene inclusa nell'installer NSIS, ma è ignorata da Git:

```text
src-tauri/resources/libmpv/libmpv-2.dll
```

Per ottenere la DLL serve una build **libmpv/dev**, non necessariamente l'archivio normale contenente `mpv.exe`.
Negli archivi Windows della famiglia mpv cercare tipicamente un file tipo:

```text
mpv-dev-x86_64-v3-....7z
```

oppure `mpv-dev-x86_64-....7z` per CPU meno recenti.

Dopo aver estratto l'archivio, eseguire dalla root Baia:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\prepare-libmpv-windows.ps1 -Source C:\percorso\cartella-estratta
```

Se `libmpv-2.dll` è già in `C:\mpv`, è sufficiente:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\prepare-libmpv-windows.ps1 -Source C:\mpv
```

Controllo:

```powershell
Get-Item .\src-tauri\resources\libmpv\libmpv-2.dll

git status --short
```

La DLL **non deve comparire in `git status`**.

## Build installer

Sul PC Windows di build/test:

```powershell
npm ci
powershell -ExecutionPolicy Bypass -File scripts\prepare-libmpv-windows.ps1 -Source C:\percorso\libmpv
npm.cmd run tauri -- build --bundles nsis
```

Tauri inserisce la DLL nelle resources dell'installer.

Dopo aver installato la nuova build, `C:\mpv` non è più necessario per Baia.

## Attivazione test

Mantenere:

```text
BAIA_NATIVE_VIDEO_PLAYER=true
BAIA_DIRECT_MEDIA_DATA_PLANE=false
```

Aprendo un film o episodio deve comparire una finestra:

```text
Baia Cinghiala — Player nativo
```

In Task Manager **non deve comparire un processo `mpv.exe`**. Il decoder è dentro il processo Baia.

La finestra supporta anche i binding input di mpv durante questa fase, quindi frecce/spazio possono essere usati per i test rapidi di seek/play-pause.

## Test pratico iniziale

Usare un film che mostrava chiaramente il problema precedente:

1. apertura da inizio;
2. 5 minuti playback;
3. seek +10 minuti;
4. seek indietro;
5. 20 seek rapidi;
6. pausa/riprendi;
7. 30-60 minuti playback continuo;
8. chiudere la finestra con X;
9. riaprire lo stesso film per verificare cleanup/reinizializzazione.

Conservare log client e Connector.

## Diagnostica disponibile nel Core

`baia_core_native_player_get_state` restituisce:

```text
active
paused
idle
seeking
pausedForCache
timePos
duration
cacheDuration
cacheBufferingState
hwdecCurrent
videoCodec
audioCodec
```

Questi valori saranno la base per distinguere nei test successivi:

- decode/render lento;
- cache libmpv insufficiente;
- seek che esce dalla cache;
- Media Bridge / Range churn;
- throughput remoto insufficiente.

## Nota sul seek iniziale

Il comando high-level usa inizialmente `absolute+keyframes`: privilegia la risposta rapida durante i test. La precisione finale del seek verrà regolata dopo aver visto le metriche reali.

## Passo successivo dopo il test

Se il player embedded continua a essere lento con lo stesso Media Bridge, non ha senso lavorare sulla grafica: il candidato principale diventa il data source. Il passo successivo della roadmap è confrontare/rimuovere progressivamente il Media Bridge video e portare libmpv verso una `NativeMediaSource`/custom stream controllata da Rust.
