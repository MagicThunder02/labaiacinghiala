const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('native player resta dietro feature flag e conserva il fallback WebView', () => {
  const envExample = read('.env.example');
  const films = read('public/js/films.js');
  const series = read('public/js/series.js');

  assert.match(envExample, /BAIA_NATIVE_VIDEO_PLAYER=false/);
  assert.match(films, /tryOpenNativeVideoPlayer\(movie\.id\)/);
  assert.match(films, /elements\.videoPlayer\.src = streamUrl/);
  assert.match(series, /tryOpenNativeVideoPlayer\(episode\.id\)/);
  assert.match(series, /elements\.videoPlayer\.src = streamUrl/);
});

test('libmpv embedded accetta solo movieId e costruisce NativeMediaSource nel Core', () => {
  const nativePlayer = read('src-tauri/src/native_player.rs');
  const nativeSource = read('src-tauri/src/native_media_source.rs');

  assert.match(nativePlayer, /baia_core_native_player_open\([\s\S]*movie_id: u64/);
  assert.doesNotMatch(nativePlayer, /baia_core_native_player_open\([\s\S]{0,220}url: String/);
  assert.match(nativePlayer, /NativeMediaSourceTemplate::for_movie\(movie_id, &core_state\)/);
  assert.doesNotMatch(nativePlayer, /bridge\.register_movie_stream/);
  assert.match(nativeSource, /\/api\/movies\/\{movie_id\}\/stream/);
  assert.match(nativeSource, /connector_tls::MEDIA_PATH/);
  assert.match(nativeSource, /auth::authorize_media_path/);
});

test('video native path usa baia:// stream callback e bypassa Media Bridge localhost', () => {
  const nativePlayer = read('src-tauri/src/native_player.rs');
  const nativeSource = read('src-tauri/src/native_media_source.rs');

  assert.match(nativePlayer, /BACKEND_NAME: &str = "libmpv-baia-native-source"/);
  assert.match(nativePlayer, /mpv_stream_cb_add_ro\\0/);
  assert.match(nativePlayer, /stream_open_callback/);
  assert.match(nativeSource, /const PROTOCOL: &str = "baia"/);
  assert.match(nativeSource, /format!\("\{PROTOCOL\}:\/\/movie\/\{token\}"\)/);
  assert.match(nativeSource, /INITIAL_RANGE_BYTES: usize = 1 \* 1024 \* 1024/);
  assert.match(nativeSource, /MID_RANGE_BYTES: usize = 2 \* 1024 \* 1024/);
  assert.match(nativeSource, /DEFAULT_MAX_RANGE_BYTES: usize = 4 \* 1024 \* 1024/);
  assert.match(nativeSource, /DEFAULT_WINDOW_BYTES: usize = 16 \* 1024 \* 1024/);
  assert.match(nativeSource, /VecDeque/);
  assert.match(nativeSource, /Range NativeMediaSource/);
  assert.doesNotMatch(nativeSource, /127\.0\.0\.1/);
  assert.doesNotMatch(nativeSource, /TcpListener/);
});

test('player usa libmpv in-process e non lancia mpv.exe', () => {
  const nativePlayer = read('src-tauri/src/native_player.rs');

  assert.match(nativePlayer, /Library::new\(path\)/);
  assert.match(nativePlayer, /mpv_create\\0/);
  assert.match(nativePlayer, /mpv_initialize\\0/);
  assert.match(nativePlayer, /"wid"/);
  assert.match(nativePlayer, /WindowBuilder::new\(&app, NATIVE_PLAYER_WINDOW_LABEL\)/);
  assert.doesNotMatch(nativePlayer, /Command::new\(mpv_executable/);
  assert.doesNotMatch(nativePlayer, /BAIA_MPV_EXECUTABLE/);
});

test('Core espone controlli high-level e diagnostica player + source', () => {
  const nativePlayer = read('src-tauri/src/native_player.rs');
  const nativeSource = read('src-tauri/src/native_media_source.rs');
  const apiConfig = read('public/js/api-config.js');

  for (const command of [
    'baia_core_native_player_play',
    'baia_core_native_player_pause',
    'baia_core_native_player_seek',
    'baia_core_native_player_set_volume',
    'baia_core_native_player_get_state',
    'baia_core_native_player_stop',
  ]) {
    assert.match(nativePlayer, new RegExp(command));
  }
  assert.match(nativePlayer, /demuxer-cache-duration/);
  assert.match(nativePlayer, /cache-buffering-state/);
  assert.match(nativePlayer, /hwdec-current/);
  assert.match(nativePlayer, /NativeMediaSourceStats/);
  assert.match(nativeSource, /remote_requests/);
  assert.match(nativeSource, /cache_hits/);
  assert.match(nativeSource, /last_range_elapsed_ms/);
  assert.match(nativeSource, /cache_seek_hits/);
  assert.match(nativeSource, /pool_slot_0_requests/);
  assert.match(nativePlayer, /cache-speed/);
  assert.match(nativePlayer, /demuxer-cache-idle/);
  assert.match(apiConfig, /nativeVideoPlayerState/);
  assert.doesNotMatch(nativePlayer, /open_url/);
});


test('profilo mpv usa buffering temporale e stream buffer per MP4 remoti', () => {
  const nativePlayer = read('src-tauri/src/native_player.rs');
  for (const [name, value] of [
    ['cache-secs', '45'],
    ['cache-pause-wait', '5'],
    ['demuxer-max-bytes', '64MiB'],
    ['demuxer-max-back-bytes', '32MiB'],
    ['demuxer-hysteresis-secs', '15'],
    ['stream-buffer-size', '2MiB'],
  ]) {
    assert.match(nativePlayer, new RegExp(`api\\.set_option\\(handle, "${name}", "${value.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}"\\)`));
  }
  assert.match(nativePlayer, /"cache-pause-initial", "yes"/);
  assert.match(nativePlayer, /"demuxer-seekable-cache", "yes"/);
});

test('NativeMediaSource non usa cancel_fn aggressivo e mantiene due pool TLS bounded', () => {
  const nativeSource = read('src-tauri/src/native_media_source.rs');
  const connectorTls = read('src-tauri/src/connector_tls.rs');

  assert.match(nativeSource, /MEDIA_POOL_SIZE: usize = 2/);
  assert.match(nativeSource, /\(\*info\)\.cancel_fn = None/);
  assert.doesNotMatch(nativeSource, /stream_cancel_callback/);
  assert.match(connectorTls, /pub fn blocking_media_client/);
  assert.match(connectorTls, /pool_max_idle_per_host\(1\)/);
  assert.match(connectorTls, /pool_idle_timeout\(None::<Duration>\)/);
  assert.match(connectorTls, /tcp_keepalive/);
});

test('bundle NSIS può includere libmpv locale senza versionare la DLL', () => {
  const tauriConfig = read('src-tauri/tauri.conf.json');
  const gitignore = read('.gitignore');
  const prepareScript = read('scripts/prepare-libmpv-windows.ps1');

  assert.match(tauriConfig, /resources\/libmpv\/\*\.dll/);
  assert.match(tauriConfig, /"libmpv\/"/);
  assert.match(gitignore, /src-tauri\/resources\/libmpv\/\*\.dll/);
  assert.match(prepareScript, /libmpv-2\.dll/);
});

test('Tauri mantiene Media Bridge legacy per fallback ma native video usa modulo dedicato', () => {
  const lib = read('src-tauri/src/lib.rs');

  assert.match(lib, /mod native_media_source;/);
  assert.match(lib, /native_player::initialize\(app\)/);
  assert.match(lib, /native_player::baia_core_native_player_status/);
  assert.match(lib, /native_player::baia_core_native_player_open/);
  assert.match(lib, /native_player::baia_core_native_player_play/);
  assert.match(lib, /native_player::baia_core_native_player_seek/);
  assert.match(lib, /native_player::baia_core_native_player_get_state/);
  assert.match(lib, /native_player::baia_core_native_player_stop/);
  assert.match(lib, /media_bridge::baia_core_media_bridge_url/);
});


test('diagnostica Phase 4.1 distingue NativeMediaSource dal Media Bridge legacy end-to-end', () => {
  const nativeSource = read('src-tauri/src/native_media_source.rs');
  const mediaBridge = read('src-tauri/src/media_bridge.rs');
  const connector = read('host-connector/src/main.rs');
  const analyzer = read('scripts/analyze-native-player-poc.js');
  const originSummary = read('scripts/phase4-1-connector-origin-summary.sh');

  assert.match(nativeSource, /client_kind: "native_media_source"/);
  assert.match(nativeSource, /event=http_request[\s\S]{0,180}client_kind=native_media_source/);
  assert.match(mediaBridge, /client_kind: "legacy_media_bridge"/);
  assert.match(mediaBridge, /event=http_request[\s\S]{0,180}client_kind=legacy_media_bridge/);
  assert.match(connector, /client_kind: Option<String>/);
  assert.match(connector, /client_kind=\{\} request_path=\{\}/);
  assert.match(connector, /"native_media_source" \| "legacy_media_bridge"/);
  assert.match(analyzer, /clientKinds/);
  assert.match(analyzer, /rangeSizesByClientKind/);
  assert.match(originSummary, /client_kind=native_media_source/);
  assert.match(originSummary, /client_kind=legacy_media_bridge/);
});
