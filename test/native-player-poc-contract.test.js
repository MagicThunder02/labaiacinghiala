const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('Baia Native Player e il default Windows ma conserva il fallback WebView', () => {
  const envExample = read('.env.example');
  const nativePlayer = read('src-tauri/src/native_player.rs');
  const films = read('public/js/films.js');
  const series = read('public/js/series.js');

  assert.match(envExample, /# BAIA_NATIVE_VIDEO_PLAYER=false/);
  assert.match(nativePlayer, /None => cfg!\(target_os = "windows"\)/);
  assert.match(films, /tryOpenNativeVideoPlayer\(movie\.id, \{/);
  assert.match(films, /elements\.videoPlayer\.src = streamUrl/);
  assert.doesNotMatch(series, /tryOpenNativeVideoPlayer\(episode\.id/);
  assert.match(series, /elements\.videoPlayer\.src = streamUrl/);
  assert.match(films, /startNativePlaybackMonitor\(movie\)/);
  assert.doesNotMatch(films, /PoC mpv avviato in una finestra separata/);
  assert.doesNotMatch(series, /PoC mpv avviato in una finestra separata/);
});

test('libmpv riceve solo movieId e dati di presentazione; la NativeMediaSource nasce nel Core', () => {
  const nativePlayer = read('src-tauri/src/native_player.rs');
  const nativeSource = read('src-tauri/src/native_media_source.rs');

  assert.match(nativePlayer, /baia_core_native_player_open\([\s\S]*movie_id: u64/);
  assert.match(nativePlayer, /title: Option<String>/);
  assert.match(nativePlayer, /start_seconds: Option<f64>/);
  assert.doesNotMatch(nativePlayer, /baia_core_native_player_open\([\s\S]{0,500}url: String/);
  assert.match(nativePlayer, /NativeMediaSourceTemplate::for_movie\(movie_id, &core_state\)/);
  assert.doesNotMatch(nativePlayer, /bridge\.register_movie_stream/);
  assert.match(nativeSource, /\/api\/movies\/\{movie_id\}\/stream/);
  assert.match(nativeSource, /connector_tls::MEDIA_PATH/);
  assert.match(nativeSource, /auth::authorize_media_path/);
});

test('video native path usa baia:// stream callback e bypassa Media Bridge localhost', () => {
  const nativePlayer = read('src-tauri/src/native_player.rs');
  const nativeSource = read('src-tauri/src/native_media_source.rs');

  assert.match(nativePlayer, /BACKEND_NAME: &str = "libmpv-render-api-native-source"/);
  assert.match(nativePlayer, /mpv_stream_cb_add_ro\\0/);
  assert.match(nativePlayer, /stream_open_callback/);
  assert.match(nativeSource, /const PROTOCOL: &str = "baia"/);
  assert.match(nativeSource, /format!\("\{PROTOCOL\}:\/\/movie\/\{token\}"\)/);
  assert.match(nativeSource, /INITIAL_RANGE_BYTES: usize = 1 \* 1024 \* 1024/);
  assert.match(nativeSource, /MID_RANGE_BYTES: usize = 2 \* 1024 \* 1024/);
  assert.match(nativeSource, /DEFAULT_MAX_RANGE_BYTES: usize = 4 \* 1024 \* 1024/);
  assert.match(nativeSource, /DEFAULT_WINDOW_BYTES: usize = 16 \* 1024 \* 1024/);
  assert.match(nativeSource, /VecDeque/);
  assert.doesNotMatch(nativeSource, /127\.0\.0\.1/);
  assert.doesNotMatch(nativeSource, /TcpListener/);
});

test('player usa libmpv Render API OpenGL con compositor nativo Baia separato dal Core mpv', () => {
  const nativePlayer = read('src-tauri/src/native_player.rs');
  const tauriConfig = read('src-tauri/tauri.conf.json');
  const films = read('public/js/films.js');
  const shell = read('public/js/app-shell.js');

  assert.match(nativePlayer, /Library::new\(path\)/);
  assert.match(nativePlayer, /mpv_create\\0/);
  assert.match(nativePlayer, /mpv_initialize\\0/);
  assert.match(nativePlayer, /mpv_render_context_create\\0/);
  assert.match(nativePlayer, /mpv_render_context_render\\0/);
  assert.match(nativePlayer, /MPV_RENDER_PARAM_OPENGL_FBO/);
  assert.match(nativePlayer, /api\.set_option\(handle, "vo", "libmpv"\)/);
  assert.match(nativePlayer, /BaiaMpvNativeCompositor/);
  assert.match(nativePlayer, /wglCreateContext/);
  assert.doesNotMatch(nativePlayer, /api\.set_option\(handle, "wid"/);
  assert.doesNotMatch(nativePlayer, /configure_script/);
  assert.match(nativePlayer, /mpv_render_context_set_update_callback\\0/);
  assert.match(nativePlayer, /baia-player-render/);
  assert.match(nativePlayer, /PeekMessageW/);
  assert.match(nativePlayer, /message_loop=render_thread/);
  assert.match(nativePlayer, /set_main_webview_visible\(&app, false, "file_loaded_native_compositor"\)/);
  assert.match(tauriConfig, /"transparent": false/);
  assert.doesNotMatch(films, /native-render-active/);
  assert.match(films, /uiCloseRequested/);
  assert.doesNotMatch(shell, /shell-native-video-surface/);
});

test('transizione native-first non espone il player WebView e usa maschere AA dagli SVG Baia', () => {
  const nativePlayer = read('src-tauri/src/native_player.rs');
  const films = read('public/js/films.js');

  const nativeUi = films.match(/function enterNativePlayerUi\([\s\S]*?\n}/)?.[0] || '';
  assert.match(nativeUi, /elements\.detailView\.hidden = false/);
  assert.match(nativeUi, /elements\.playerView\.hidden = true/);
  assert.doesNotMatch(nativeUi, /elements\.playerView\.hidden = false/);
  assert.match(nativePlayer, /"open_native_compositor"/);
  assert.match(nativePlayer, /"open_failed_native_compositor"/);

  for (const asset of [
    'chevron-left-16.alpha',
    'play-27.alpha',
    'pause-27.alpha',
    'fullscreen-enter-25.alpha',
    'fullscreen-exit-25.alpha',
    'volume-29.alpha',
  ]) assert.match(nativePlayer, new RegExp(asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  assert.match(nativePlayer, /glTexParameteri\(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR\)/);
  assert.match(nativePlayer, /glTexParameteri\(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR\)/);
  assert.match(nativePlayer, /ui_renderer=textured_svg source=webview_icons filter=linear antialias=alpha/);
  assert.match(nativePlayer, /smooth_circle\(&self\.ui_textures, seek_x, seek_y, 16\.0, accent\)/);
});

test('controlli Phase 6B appartengono al compositor Baia e non all OSC mpv', () => {
  const nativePlayer = read('src-tauri/src/native_player.rs');
  const films = read('public/js/films.js');

  assert.match(nativePlayer, /UI_NAME: &str = "baia-native-compositor"/);
  assert.match(nativePlayer, /SurfaceAction::TogglePause/);
  assert.match(nativePlayer, /SurfaceAction::SeekAbsolute/);
  assert.match(nativePlayer, /SurfaceAction::SetVolume/);
  assert.match(nativePlayer, /SurfaceAction::ToggleFullscreen/);
  assert.match(nativePlayer, /SurfaceAction::RequestClose/);
  assert.match(nativePlayer, /draw_baia_controls/);
  assert.match(nativePlayer, /ui_close_requested/);
  assert.match(films, /uiCloseRequested/);
  assert.doesNotMatch(nativePlayer, /configure_script/);
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
  ]) assert.match(nativePlayer, new RegExp(command));

  assert.match(nativePlayer, /player_backend=libmpv media_source=native_media_source/);
  assert.match(nativePlayer, /ui=\{\}/);
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
  assert.match(apiConfig, /Native player non disponibile: uso il fallback WebView/);
  assert.doesNotMatch(nativePlayer, /open_url/);
});

test('profilo mpv conserva il buffering Phase 4', () => {
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

test('bundle NSIS include libmpv locale senza versionare la DLL', () => {
  const tauriConfig = read('src-tauri/tauri.conf.json');
  const gitignore = read('.gitignore');
  const prepareScript = read('scripts/prepare-libmpv-windows.ps1');

  assert.match(tauriConfig, /resources\/libmpv\/\*\.dll/);
  assert.match(gitignore, /src-tauri\/resources\/libmpv\/\*\.dll/);
  assert.match(prepareScript, /libmpv-2\.dll/);
});

test('Tauri mantiene Media Bridge legacy soltanto come fallback', () => {
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
