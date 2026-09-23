# BAIA — Native Player Phase 3: `baia://` NativeMediaSource

## Obiettivo

Questa patch elimina il **Media Bridge HTTP localhost V6 dal data path del native player**.

Il fallback WebView legacy resta presente e continua a usare il Media Bridge; soltanto il player libmpv embedded passa al nuovo percorso:

```text
WebView UI
   ↓ movieId
Tauri Rust Core
   ↓
libmpv embedded
   ↓ baia://movie/<token>
NativeMediaSource Rust
   ↓ POST /baia/v1/media + Range bounded
Host Connector TLS pinnato
   ↓
Node stream route                  (BAIA_DIRECT_MEDIA_DATA_PLANE=false)
```

Con `BAIA_DIRECT_MEDIA_DATA_PLANE=true` sul **server/Host Connector**, lo stesso client può poi essere provato senza Node nel body path:

```text
libmpv → baia:// → Rust Core → Connector → filesystem
                              ↘ Node solo resolve/autorizzazione
```

## Cosa cambia

- nuovo `src-tauri/src/native_media_source.rs`;
- registrazione libmpv `mpv_stream_cb_add_ro()` per il protocollo interno `baia://`;
- il JS continua a passare soltanto `movieId`;
- niente URL Internet/localhost arbitrario dal frontend;
- niente `TcpListener` locale per il native player;
- niente chunking/latest-seek-wins V6 per il native player;
- Range remoti bounded, default **4 MiB**;
- una sola cache read-ahead locale bounded per stream;
- TLS/pinning, access grant e firma device restano nel Core Rust;
- metriche/log NativeMediaSource per throughput, Range e seek.

## Read-ahead

Default:

```text
BAIA_NATIVE_READ_AHEAD_BYTES=4194304
```

Range accettato dal codice:

```text
256 KiB .. 16 MiB
```

Per il primo test lasciare **4 MiB**. Non cambiare contemporaneamente player, read-ahead e direct-file: serve capire quale hop limita il flusso.

## Build Windows

La DLL libmpv è la stessa della Phase 2. Non servono nuove dipendenze npm.

Dopo il pull:

```powershell
npm ci
powershell -ExecutionPolicy Bypass -File scripts\prepare-libmpv-windows.ps1 -Source C:\libmpv
npm.cmd run tauri -- build --bundles nsis
```

Se la DLL locale è già in `src-tauri\resources\libmpv\libmpv-2.dll`, il secondo comando non è necessario.

## Primo test: isolare il Media Bridge

Sul server lasciare:

```text
BAIA_DIRECT_MEDIA_DATA_PLANE=false
```

Riavviare il Connector se necessario, installare il nuovo NSIS sul client e aprire un film.

Il data path atteso è:

```text
libmpv → baia:// → NativeMediaSource → Connector → Node → FILE
```

Nel log client devono apparire righe come:

```text
native_media_source event=open ...
native_media_source event=range start=... end=... bytes=4194304 elapsed_ms=...
native_media_source event=seek offset=...
```

Non devono più apparire `video_range_id=...` per il film aperto nel native player: quelle righe appartengono al Media Bridge legacy.

### Sequenza pratica

1. play dall'inizio;
2. lasciare andare 2–5 minuti;
3. seek +10 minuti;
4. seek indietro;
5. 20 seek rapidi;
6. playback continuo 20–60 minuti.

Salvare:

```text
client-native-source.log
connector-native-source.log
```

Analisi:

```powershell
npm.cmd run analyze:native-player-poc -- connector-native-source.log client-native-source.log
```

L'output ora include:

- Range NativeMediaSource;
- byte letti;
- tempo medio/massimo per Range;
- throughput misurato;
- seek osservati;
- errori;
- riuso TLS Connector.

Da DevTools si può anche leggere lo stato live:

```js
await BaiaApi.nativeVideoPlayerState()
```

La proprietà `source` contiene i contatori della NativeMediaSource.

## Secondo test opzionale: eliminare Node dal body path

Farlo **solo dopo un breve test con direct-file false**, così il risultato è interpretabile.

Sul server/Host Connector:

```text
BAIA_DIRECT_MEDIA_DATA_PLANE=true
LIBRARY_PATH=<radice reale della libreria Baia>
```

Riavviare il Connector.

Non serve ricompilare il client: la stessa NativeMediaSource usa lo stesso `/baia/v1/media` e il Connector sceglie internamente il direct-file data plane.

Il log Connector deve mostrare:

```text
media_source=direct_file
```

### Interpretazione

- **Phase 3 fluida con direct=false**: il problema principale era Media Bridge/V6/WebView data-path.
- **Phase 3 lenta con direct=false, fluida con direct=true**: il collo di bottiglia è soprattutto Node nel body path.
- **Lenta anche con direct=true**, ma throughput Range alto: investigare cache/demux/seek policy e bitrate/codec.
- **Lenta anche con direct=true e throughput Range insufficiente**: il limite è rete/throughput fisico o filesystem/server.

## Sicurezza preservata

- `movieId` è l'unico identificatore accettato dal frontend;
- `baia://` usa token interni generati dal Core e registrati soltanto nel processo;
- private key, grant, firma e pin non arrivano al JS;
- il protocollo accetta soltanto token interni esadecimali;
- il Core continua a usare l'allowlist `/api/movies/<id>/stream`;
- nessun accesso arbitrario al filesystem client/server viene esposto al frontend.

## Nota tecnica mpv

La custom stream API di libmpv richiede callback `open/read/seek/size/close` e consente short reads. La patch implementa questa API dinamicamente tramite `libmpv-2.dll` e lascia a mpv demux cache e seek policy; la NativeMediaSource fornisce soltanto uno stream seekable bounded.
