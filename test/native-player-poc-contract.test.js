const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('native player PoC e disabilitato per default e conserva il fallback WebView', () => {
  const envExample = read('.env.example');
  const films = read('public/js/films.js');
  const series = read('public/js/series.js');

  assert.match(envExample, /BAIA_NATIVE_VIDEO_PLAYER=false/);
  assert.match(films, /tryOpenNativeVideoPlayer\(movie\.id\)/);
  assert.match(films, /elements\.videoPlayer\.src = streamUrl/);
  assert.match(series, /tryOpenNativeVideoPlayer\(episode\.id\)/);
  assert.match(series, /elements\.videoPlayer\.src = streamUrl/);
});

test('native player accetta solo movieId e genera la media URL nel Core Rust', () => {
  const nativePlayer = read('src-tauri/src/native_player.rs');
  const mediaBridge = read('src-tauri/src/media_bridge.rs');

  assert.match(nativePlayer, /baia_core_native_player_open\([\s\S]*movie_id: u64/);
  assert.doesNotMatch(nativePlayer, /baia_core_native_player_open\([\s\S]{0,180}url: String/);
  assert.match(nativePlayer, /bridge\.register_movie_stream\(movie_id, &core_state\)/);
  assert.match(mediaBridge, /register_movie_stream\(&self, movie_id: u64/);
  assert.match(mediaBridge, /\/api\/movies\/\{movie_id\}\/stream/);
});

test('mpv PoC usa argomenti fissi e non espone output con URL firmati', () => {
  const nativePlayer = read('src-tauri/src/native_player.rs');

  assert.match(nativePlayer, /--no-config/);
  assert.match(nativePlayer, /--force-window=yes/);
  assert.match(nativePlayer, /--cache=yes/);
  assert.match(nativePlayer, /\.stdout\(Stdio::null\(\)\)/);
  assert.match(nativePlayer, /\.stderr\(Stdio::null\(\)\)/);
  assert.doesNotMatch(nativePlayer, /open_url/);
});

test('Tauri registra stato e comandi del PoC senza rimuovere il Media Bridge', () => {
  const lib = read('src-tauri/src/lib.rs');

  assert.match(lib, /app\.manage\(native_player::NativePlayerState::default\(\)\)/);
  assert.match(lib, /native_player::baia_core_native_player_status/);
  assert.match(lib, /native_player::baia_core_native_player_open/);
  assert.match(lib, /native_player::baia_core_native_player_stop/);
  assert.match(lib, /media_bridge::baia_core_media_bridge_url/);
});
