const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('native player embedded resta dietro feature flag e conserva il fallback WebView', () => {
  const envExample = read('.env.example');
  const films = read('public/js/films.js');
  const series = read('public/js/series.js');

  assert.match(envExample, /BAIA_NATIVE_VIDEO_PLAYER=false/);
  assert.match(films, /tryOpenNativeVideoPlayer\(movie\.id\)/);
  assert.match(films, /elements\.videoPlayer\.src = streamUrl/);
  assert.match(series, /tryOpenNativeVideoPlayer\(episode\.id\)/);
  assert.match(series, /elements\.videoPlayer\.src = streamUrl/);
});

test('libmpv embedded accetta solo movieId e genera la media URL nel Core Rust', () => {
  const nativePlayer = read('src-tauri/src/native_player.rs');
  const mediaBridge = read('src-tauri/src/media_bridge.rs');

  assert.match(nativePlayer, /baia_core_native_player_open\([\s\S]*movie_id: u64/);
  assert.doesNotMatch(nativePlayer, /baia_core_native_player_open\([\s\S]{0,220}url: String/);
  assert.match(nativePlayer, /bridge\.register_movie_stream\(movie_id, &core_state\)/);
  assert.match(mediaBridge, /register_movie_stream\(&self, movie_id: u64/);
  assert.match(mediaBridge, /\/api\/movies\/\{movie_id\}\/stream/);
});

test('player usa libmpv in-process e non lancia più mpv.exe', () => {
  const nativePlayer = read('src-tauri/src/native_player.rs');

  assert.match(nativePlayer, /BACKEND_NAME: &str = "libmpv-embedded-wid"/);
  assert.match(nativePlayer, /Library::new\(path\)/);
  assert.match(nativePlayer, /mpv_create\\0/);
  assert.match(nativePlayer, /mpv_initialize\\0/);
  assert.match(nativePlayer, /"wid"/);
  assert.match(nativePlayer, /WindowBuilder::new\(&app, NATIVE_PLAYER_WINDOW_LABEL\)/);
  assert.doesNotMatch(nativePlayer, /Command::new\(mpv_executable/);
  assert.doesNotMatch(nativePlayer, /BAIA_MPV_EXECUTABLE/);
});

test('Core espone controlli high-level e diagnostica senza open_url arbitrario', () => {
  const nativePlayer = read('src-tauri/src/native_player.rs');
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
  assert.match(apiConfig, /nativeVideoPlayerState/);
  assert.doesNotMatch(nativePlayer, /open_url/);
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

test('Tauri inizializza stato embedded e registra tutti i comandi mantenendo Media Bridge', () => {
  const lib = read('src-tauri/src/lib.rs');

  assert.match(lib, /native_player::initialize\(app\)/);
  assert.match(lib, /native_player::baia_core_native_player_status/);
  assert.match(lib, /native_player::baia_core_native_player_open/);
  assert.match(lib, /native_player::baia_core_native_player_play/);
  assert.match(lib, /native_player::baia_core_native_player_seek/);
  assert.match(lib, /native_player::baia_core_native_player_get_state/);
  assert.match(lib, /native_player::baia_core_native_player_stop/);
  assert.match(lib, /media_bridge::baia_core_media_bridge_url/);
});
