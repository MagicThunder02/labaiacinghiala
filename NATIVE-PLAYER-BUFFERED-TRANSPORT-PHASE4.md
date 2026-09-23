# BAIA — Native Player Phase 4: buffered transport / TLS stabilization

## Obiettivo

Questa fase NON introduce HLS/DASH, transcoding o rendition multiple. Conserva:

- un solo file originale MP4/MKV;
- libmpv embedded nel client Tauri;
- protocollo interno `baia://`;
- Connector come data plane;
- Node come autorità/control plane;
- `BAIA_DIRECT_MEDIA_DATA_PLANE=true` per i test direct-file.

Il problema da correggere è quello osservato nei test reali Phase 3: quasi una nuova TLS per richiesta e Broken pipe quasi quanto le richieste, anche con un film leggero.

## Strategia

### 1. Lasciare a mpv il buffering da player

Il Core imposta prima di `mpv_initialize`:

```text
cache=yes
cache-secs=45
cache-pause=yes
cache-pause-initial=yes
cache-pause-wait=5
demuxer-max-bytes=64MiB
demuxer-max-back-bytes=32MiB
demuxer-seekable-cache=yes
demuxer-hysteresis-secs=15
stream-buffer-size=2MiB
demuxer-termination-timeout=5
hwdec=auto
```

NativeMediaSource non prova a sostituire la cache/demux policy di mpv.

### 2. Aggregare i piccoli read() di libmpv

La sorgente `baia://` usa una sliding window byte-level bounded, default 16 MiB.

Range remoti:

```text
open / seek fuori cache -> 1 MiB
prima lettura sequenziale -> 2 MiB
lettura sequenziale stabile -> fino a 4 MiB
```

`BAIA_NATIVE_READ_AHEAD_BYTES` resta supportata ma ora è il CAP del Range adattivo (1..4 MiB), non una dimensione fissa.

`BAIA_NATIVE_WINDOW_BYTES` controlla la sliding window locale ed è limitata a 8..32 MiB; default 16 MiB.

### 3. Nessun abort aggressivo

`mpv_stream_cb_info.cancel_fn` è deliberatamente `NULL`.

La callback cancel di mpv rappresenta la cancellazione delle letture/seek correnti e future dello stream. Usarla come `latest-seek-wins` equivaleva, nel nostro data path, a chiudere continuamente il consumer e ricreare churn TLS/Broken pipe.

Ogni Range remoto è bounded e viene consumato interamente prima di restituire la connessione al pool.

### 4. Pool media bounded

La HEAD metadata è separata dal data pool e usa `Connection: close`.

I Range video hanno due client reqwest dedicati. Ogni client conserva al massimo una connessione idle per host e non applica un idle timeout client-side; TCP keepalive è configurato a 20 s.

Questa fase usa ancora fetch sincroni bounded: lo scopo primario è verificare che, rimuovendo l'abort, le TLS tornino riusabili. Non introduce ancora un worker di prefetch parallelo custom.

## Metriche nuove

### Client / NativeMediaSource

I log `event=range` includono:

```text
generation
pool_slot
requested_start
requested_end
requested_bytes
bytes_received
elapsed_ms
sequential_fetches
cache_start
cache_end
cache_window_bytes
```

I seek includono:

```text
offset
cache_hit
generation
next_range_bytes
```

Lo stato player espone anche:

```text
cacheSpeed
demuxerCacheDuration
demuxerCacheIdle
demuxerCacheState
pausedForCache
cacheBufferingState
```

### Connector direct-file

Ogni risposta direct-file logga:

```text
method
requested_start
requested_end
requested_bytes
bytes_streamed
client_disconnected
status
control_elapsed_ms
elapsed_ms
```

Questo permette di distinguere:

- ritardo di autorizzazione/control plane;
- lentezza del filesystem/data plane;
- disconnect del client;
- Range incompleti;
- throughput reale.

## Deploy — server Linux

Dopo pull della branch:

```bash
cd /opt/baia
cargo build --locked --release --manifest-path host-connector/Cargo.toml
```

Prima di sostituire il binario, controllare il path usato dall'unit:

```bash
systemctl show baia-connector -p ExecStart
```

Se il deploy segue gli script del repository, reinstallare il binario con lo script esistente usando lo stesso bind IP configurato in precedenza, oppure sostituire il binario nel path mostrato da `ExecStart` a servizio fermo.

Esempio per l'installazione standard `/opt/baia-connector/bin/baia-host-connector`:

```bash
sudo systemctl stop baia-connector
sudo install -o root -g root -m 0755 \
  host-connector/target/release/baia-host-connector \
  /opt/baia-connector/bin/baia-host-connector
sudo systemctl start baia-connector
sudo systemctl status baia-connector --no-pager
```

Verificare che restino presenti:

```bash
sudo systemctl show baia-connector -p Environment
```

Per il test Phase 4 devono esserci almeno:

```text
BAIA_DIRECT_MEDIA_DATA_PLANE=true
LIBRARY_PATH=<radice libreria>
```

## Deploy — client Windows

La DLL libmpv non è versionata. Se è già presente in:

```text
src-tauri\resources\libmpv\libmpv-2.dll
```

non serve ricopiarla.

Altrimenti:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\prepare-libmpv-windows.ps1 -Source C:\libmpv
```

Poi:

```powershell
npm ci
npm.cmd run tauri -- build --bundles nsis
```

Installare il nuovo NSIS sul client.

## Test consigliato

Usare prima un film con bitrate sostenibile dalla rete corrente.

Sequenza minima:

1. avvio e 5 minuti di playback;
2. seek +10 min;
3. seek indietro;
4. 10-20 seek rapidi;
5. altri 5-10 minuti di playback.

Non serve un test da un'ora finché il trasporto non supera il gate seguente.

## Gate Phase 4

Rispetto ai test Phase 3, il risultato atteso è:

```text
Broken pipe           -> vicino a 0
TLS distinte          -> poche rispetto alle richieste
transport_reused=true -> largamente dominante
request_index          -> cresce nel tempo
client_disconnected   -> vicino a 0
```

Solo dopo guardare startup, buffering e seek latency.

Se il churn TLS viene corretto ma i seek restano lenti, il passo successivo sarà valutare un prefetch worker/seconda lane urgente. Se invece il control plane domina `elapsed_ms`, il passo successivo sarà ridurre la frequenza di autorizzazione per Range mantenendo TTL/revoca.

## Analizzatore

Con log server e client salvati:

```text
npm run analyze:native-player-poc -- connector.log client.log
```

L'analizzatore Phase 4 riporta anche completion direct-file, disconnect, control latency, Range size distribution, pool slot usage e cache seek hits.

## Riepilogo server direttamente a terminale

Prima del test:

```bash
START=$(date '+%Y-%m-%d %H:%M:%S'); echo "START=$START"
```

Dopo il test:

```bash
LOGS="$(sudo journalctl -u baia-connector --since "$START" --no-pager)"
MEDIA="$(printf '%s\n' "$LOGS" | grep 'connector_connection_id=')"
DIRECT="$(printf '%s\n' "$LOGS" | grep 'media_source=direct_file')"

echo "===== BAIA PHASE 4 ====="
echo "richieste=$(printf '%s\n' "$MEDIA" | grep -c 'connector_connection_id=')"
echo "tls_distinte=$(printf '%s\n' "$MEDIA" | grep -o 'connector_connection_id=[^ ]*' | sort -u | wc -l)"
echo "reuse:"; printf '%s\n' "$MEDIA" | grep -o 'transport_reused=[a-z]*' | sort | uniq -c
echo "max_request_index=$(printf '%s\n' "$MEDIA" | grep -o 'request_index_on_connection=[0-9]*' | cut -d= -f2 | sort -n | tail -1)"
echo "broken_pipe=$(printf '%s\n' "$LOGS" | grep -ci 'Broken pipe')"
echo "direct_file=$(printf '%s\n' "$DIRECT" | grep -c 'media_source=direct_file')"
echo "client_disconnected=$(printf '%s\n' "$DIRECT" | grep -c 'client_disconnected=true')"
echo "zero_byte_get=$(printf '%s\n' "$DIRECT" | grep 'method=GET' | grep -c 'bytes_streamed=0')"
echo "completion_bytes:"
printf '%s\n' "$DIRECT" | awk '
  { req=0; sent=0; for(i=1;i<=NF;i++){if($i~/^requested_bytes=/){split($i,a,"=");req+=a[2]} if($i~/^bytes_streamed=/){split($i,a,"=");sent+=a[2]}} R+=req; S+=sent }
  END { printf "requested=%d streamed=%d completion=%.2f%%\n", R, S, (R?100*S/R:0) }
'
echo "control_elapsed_ms avg/max:"
printf '%s\n' "$DIRECT" | awk '
  {for(i=1;i<=NF;i++) if($i~/^control_elapsed_ms=/){split($i,a,"=");v=a[2]+0;s+=v;n++;if(v>m)m=v}}
  END {printf "avg=%.1f max=%d samples=%d\n",(n?s/n:0),m,n}
'
echo "request_elapsed_ms avg/max:"
printf '%s\n' "$DIRECT" | awk '
  {for(i=1;i<=NF;i++) if($i~/^elapsed_ms=/){split($i,a,"=");v=a[2]+0;s+=v;n++;if(v>m)m=v}}
  END {printf "avg=%.1f max=%d samples=%d\n",(n?s/n:0),m,n}
'
echo "range sizes:"; printf '%s\n' "$DIRECT" | grep 'method=GET' | grep -o 'requested_bytes=[0-9]*' | sort | uniq -c
echo "===== FINE ====="
```
