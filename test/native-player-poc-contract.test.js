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
  assert.match(nativeSource, /DEFAULT_MAX_RANGE_BYTES: usize = 2 \* 1024 \* 1024/);
  assert.match(nativeSource, /struct SparseRangeCache/);
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

test('Phase 6B.4 porta l intro WebView nel compositor e usa il frame finale come pre-roll', () => {
  const nativePlayer = read('src-tauri/src/native_player.rs');
  const shell = read('public/js/app-shell.js');

  assert.match(nativePlayer, /PLAYBACK_INTRO_ANIMATION_DURATION: Duration = Duration::from_secs\(9\)/);
  assert.match(nativePlayer, /PLAYBACK_INTRO_AUDIO_LEAD: Duration = Duration::from_millis\(250\)/);
  assert.match(nativePlayer, /PLAYBACK_INTRO_MIN_VISIBLE_DURATION: Duration = Duration::from_millis\(9250\)/);
  assert.match(nativePlayer, /intro_visible: bool/);
  assert.match(nativePlayer, /draw_playback_intro/);
  assert.match(nativePlayer, /intro-boar-open-1024\.alpha/);
  assert.match(nativePlayer, /intro-boar-wink-1024\.alpha/);
  assert.match(nativePlayer, /intro-eyepatch-1024\.rgba/);
  assert.match(nativePlayer, /intro-wordmark-2048x787\.rgba/);
  assert.match(nativePlayer, /intro-ring-1024\.alpha/);
  assert.match(nativePlayer, /intro-radial-256\.alpha/);
  assert.match(nativePlayer, /playback_intro_renderer=textured_svg source=webview_app_intro filter=linear antialias=alpha_rgba/);

  // Il load parte subito in pausa; al frame finale mpv fa un breve pre-roll mutato
  // e l'overlay viene rimosso solo dopo PLAYBACK_RESTART (o il failsafe).
  assert.match(nativePlayer, /api\.set_property\(handle, "pause", "yes"\)\?;[\s\S]{0,160}api\.command\(handle, &command\)\?;/);
  assert.match(nativePlayer, /api\.set_property\(handle, "mute", "yes"\)\?;/);
  assert.match(nativePlayer, /MPV_EVENT_PLAYBACK_RESTART: i32 = 21/);
  assert.match(nativePlayer, /elapsed >= PLAYBACK_INTRO_MIN_VISIBLE_DURATION[\s\S]{0,280}api\.set_property\(handle, "pause", "no"\)/);
  assert.match(nativePlayer, /playback_restart_seen/);
  assert.match(nativePlayer, /elapsed >= PLAYBACK_INTRO_MIN_VISIBLE_DURATION/);
  assert.match(nativePlayer, /api\.set_property\(handle, "mute", "no"\)/);
  assert.match(nativePlayer, /ui\.intro_visible = false/);

  // Il soundtrack parte subito; la timeline visiva resta sul primo frame per
  // 250ms e poi esegue gli stessi 9s di keyframe WebView.
  assert.match(nativePlayer, /intro_visual_started = intro_started \+ PLAYBACK_INTRO_AUDIO_LEAD/);
  assert.match(nativePlayer, /ui\.intro_started_at = Some\(intro_visual_started\)/);
  assert.match(shell, /PLAYBACK_INTRO_DURATION_MS = 9000/);
  assert.doesNotMatch(shell, /PLAYBACK_INTRO_AUDIO_DELAY_MS/);
  assert.doesNotMatch(shell, /playbackIntroAudioDelayTimer = window\.setTimeout/);
  assert.match(shell, /playbackIntroAudio: startPlaybackIntroAudioOnly/);
  assert.match(shell, /stopPlaybackIntroAudio: stopPlaybackIntroAudioOnly/);
  assert.match(nativePlayer, /window\.BaiaShell\?\.playbackIntroAudio\?\.\(\)/);
  assert.match(nativePlayer, /window\.BaiaShell\?\.stopPlaybackIntroAudio\?\.\(\)/);

  for (const [asset, size] of [
    ['intro-boar-open-1024.alpha', 1024 * 1024],
    ['intro-boar-wink-1024.alpha', 1024 * 1024],
    ['intro-eyepatch-1024.rgba', 1024 * 1024 * 4],
    ['intro-wordmark-2048x787.rgba', 2048 * 787 * 4],
    ['intro-ring-1024.alpha', 1024 * 1024],
    ['intro-radial-256.alpha', 256 * 256],
  ]) {
    assert.equal(fs.statSync(path.join(ROOT, 'src-tauri/src/native_player_assets', asset)).size, size);
  }
});

test('Phase 6B.4.4 ripristina auto-hide e toggle dei controlli in fullscreen', () => {
  const nativePlayer = read('src-tauri/src/native_player.rs');

  assert.match(nativePlayer, /FULLSCREEN_CONTROLS_HIDE_DELAY: Duration = Duration::from_secs\(3\)/);
  assert.match(nativePlayer, /controls_visible: bool/);
  assert.match(nativePlayer, /controls_hide_at: Option<Instant>/);
  assert.match(nativePlayer, /fn auto_hide_controls_if_due\(&mut self, now: Instant\) -> bool/);
  assert.match(nativePlayer, /self\.fullscreen && !self\.paused && !self\.intro_visible/);
  assert.match(nativePlayer, /shared\.auto_hide_controls_if_due\(now\)/);
  assert.match(nativePlayer, /if !state\.controls_visible \{[\s\S]{0,180}ui\.show_controls\(now\)[\s\S]{0,80}return;/);
  assert.match(nativePlayer, /if state\.fullscreen \{\s*self\.shared\.update\(\|ui\| ui\.hide_controls\(\)\);\s*\}/);
  assert.match(nativePlayer, /fn mouse_move[\s\S]{0,1600}ui\.show_controls\(now\)/);
  assert.match(nativePlayer, /if !state\.controls_visible \{\s*unsafe \{ glDisable\(GL_BLEND\); \}\s*return;\s*\}/);
  assert.match(nativePlayer, /ui\.show_controls\(controls_now\)/);
});

test('Phase 6B.4.5 evita riapertura sintetica dei controlli e protegge lo snapshot progresso', () => {
  const nativePlayer = read('src-tauri/src/native_player.rs');
  const films = read('public/js/films.js');

  assert.match(nativePlayer, /POINTER_MOVE_WAKE_THRESHOLD: f32 = 2\.0/);
  assert.match(nativePlayer, /last_pointer: Mutex<Option<\(f32, f32\)>>/);
  assert.match(nativePlayer, /let _ = self\.remember_pointer\(x, y\);/);
  assert.match(nativePlayer, /DragMode::None => \{[\s\S]{0,500}if self\.remember_pointer\(x, y\)/);

  assert.match(nativePlayer, /let terminal_idle = state\.idle/);
  assert.match(nativePlayer, /if terminal_idle \|\| state\.time_pos\.is_none\(\)/);
  assert.match(nativePlayer, /progress_snapshot=teardown/);

  assert.match(films, /function nativePlaybackNumber\(value\)/);
  assert.match(films, /if \(value === null \|\| value === undefined \|\| value === ''\) return null/);
  assert.match(films, /async function refreshNativePlaybackSnapshot\(\)/);
  assert.match(films, /await refreshNativePlaybackSnapshot\(\);[\s\S]{0,500}stopNativeVideoPlayer[\s\S]{0,500}await refreshNativePlaybackSnapshot\(\)/);
  assert.match(films, /if \(!state\.nativeUiActive\) saveProgress\(true\)/);
  assert.doesNotMatch(films, /if \(state\.nativeUiActive\) saveProgressOnPageExit\(\)/);
});

test('rifiniture native player: Indietro glass, tempi visibili, volume 100 e niente fascia fumé', () => {
  const nativePlayer = read('src-tauri/src/native_player.rs');
  const films = read('public/js/films.js');

  assert.match(nativePlayer, /back-pill-208x84\.alpha/);
  assert.match(nativePlayer, /text-indietro-100x32\.alpha/);
  assert.match(nativePlayer, /time-glyphs-312x40\.alpha/);
  assert.match(nativePlayer, /let back_width = 104\.0/);
  assert.match(nativePlayer, /self\.ui_textures\.back_button_pill/);
  assert.match(nativePlayer, /self\.ui_textures\.text_indietro/);
  assert.match(nativePlayer, /draw_player_time\(/);
  assert.match(nativePlayer, /format!\("-\{\}", time_string\(remaining\)\)/);
  assert.match(nativePlayer, /NATIVE_PLAYBACK_START_VOLUME: f64 = 100\.0/);
  assert.match(films, /volume: 100,/);
  assert.doesNotMatch(nativePlayer, /quad\(0\.0, height - 156\.0, width, height/);

  assert.equal(
    fs.statSync(path.join(ROOT, 'src-tauri/src/native_player_assets', 'back-pill-208x84.alpha')).size,
    208 * 84,
  );
  assert.equal(
    fs.statSync(path.join(ROOT, 'src-tauri/src/native_player_assets', 'text-indietro-100x32.alpha')).size,
    100 * 32,
  );
  assert.equal(
    fs.statSync(path.join(ROOT, 'src-tauri/src/native_player_assets', 'time-glyphs-312x40.alpha')).size,
    312 * 40,
  );
});

test('progresso native sopravvive al teardown e viene salvato prima di chiudere lo stato UI', () => {
  const nativePlayer = read('src-tauri/src/native_player.rs');
  const films = read('public/js/films.js');

  assert.match(nativePlayer, /last_playback_state: Arc<Mutex<NativePlaybackState>>/);
  assert.match(nativePlayer, /fn capture_playback_state\(/);
  assert.match(nativePlayer, /SurfaceAction::RequestClose[\s\S]{0,900}progress_snapshot=close_cached/);
  assert.match(nativePlayer, /fn cached_playback_state\(&self\)/);
  assert.match(nativePlayer, /return self\.cached_playback_state\(\)/);
  assert.match(nativePlayer, /progress_snapshot=close_cached/);

  const monitor = films.match(/function startNativePlaybackMonitor\(movie\) \{[\s\S]*?\n\}/)?.[0] || '';
  const snapshotImport = monitor.indexOf('importNativePlaybackSnapshot(playback)');
  const closeRequested = monitor.indexOf('if (playback?.uiCloseRequested && state.nativeUiActive)');
  assert.ok(snapshotImport >= 0, 'il monitor deve importare timePos dallo snapshot nativo');
  assert.ok(closeRequested > snapshotImport, 'timePos/duration vanno importati prima del closePlayer');
  assert.match(monitor, /await closePlayer\(\{ nativeAlreadyClosed: true \}\)/);

  const closePlayer = films.match(/async function closePlayer\([\s\S]*?\n\}/)?.[0] || '';
  assert.match(closePlayer, /await saveNativeProgressSnapshot\(movieId, seconds, duration\)/);
});


test('Phase 6B.5 riduce contention e latenza tra WebView, worker mpv e compositor', () => {
  const nativePlayer = read('src-tauri/src/native_player.rs');

  assert.match(nativePlayer, /EVENT_POLL_INTERVAL: Duration = Duration::from_millis\(8\)/);
  assert.match(nativePlayer, /DIAGNOSTIC_STATE_REFRESH_INTERVAL: Duration = Duration::from_secs\(1\)/);
  assert.match(nativePlayer, /VOLUME_ACTION_INTERVAL: Duration = Duration::from_millis\(16\)/);

  // Il polling frontend legge uno snapshot Rust gia pronto: non deve piu
  // accodare GetState al worker libmpv quattro volte al secondo.
  assert.doesNotMatch(nativePlayer, /PlayerCommand::GetState/);
  assert.match(nativePlayer, /fn playback_state\(&self\)[\s\S]{0,1200}last_playback_state/);
  assert.match(nativePlayer, /Il worker aggiorna questo snapshot ogni 100ms/);

  // Le letture costose di cache/codec/source sono separate dal refresh UI rapido.
  assert.match(nativePlayer, /fn refresh_playback_diagnostics\(/);
  assert.match(nativePlayer, /fn update_render_state_from_snapshot\(/);
  assert.match(nativePlayer, /latency=slow operation=fast_state_refresh/);
  assert.match(nativePlayer, /latency=slow operation=mpv_terminate_destroy/);

  // Il drag volume non deve saturare la coda e il close spegne subito il surface.
  assert.match(nativePlayer, /fn volume_at\(&self, y: f32, height: f32, commit: bool\)/);
  assert.match(nativePlayer, /commit \|\| last\.map_or/);
  assert.match(nativePlayer, /fn request_close\(&self\)[\s\S]{0,500}shutdown\.store\(true, Ordering::Release\)[\s\S]{0,250}SurfaceAction::RequestClose/);

  // Le invoke che possono attendere il worker non girano come command sincrone.
  for (const command of [
    'baia_core_native_player_play',
    'baia_core_native_player_pause',
    'baia_core_native_player_seek',
    'baia_core_native_player_set_volume',
    'baia_core_native_player_get_state',
    'baia_core_native_player_stop',
  ]) {
    assert.match(nativePlayer, new RegExp(`pub async fn ${command}\\(`));
  }
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

test('Phase 6B.6 mantiene la telemetria transport/chunk usata per i benchmark', () => {
  const nativePlayer = read('src-tauri/src/native_player.rs');
  const nativeSource = read('src-tauri/src/native_media_source.rs');
  const analyzer = read('scripts/analyze-native-player-transport.js');
  const packageJson = read('package.json');
  const benchmark = read('NATIVE-PLAYER-TRANSPORT-BENCHMARK.md');

  for (const field of [
    'metadata_elapsed_ms',
    'blocking_fetch_ms_total',
    'blocking_fetch_ms_max',
    'range_headers_ms_total',
    'range_body_ms_total',
    'range_elapsed_ms_total',
    'first_range_elapsed_ms',
    'slow_ranges_250ms',
    'seek_distance_bytes_max',
  ]) assert.match(nativeSource, new RegExp(field));

  assert.match(nativeSource, /let blocked_started = Instant::now\(\);/);
  assert.match(nativeSource, /throughput_mib_s=\{:\.2\}/);
  assert.match(nativePlayer, /native_player transport_sample/);
  assert.match(nativePlayer, /native_player transport_summary/);
  assert.match(nativePlayer, /transport_event=cache_pause_start/);
  assert.match(nativePlayer, /open_to_file_loaded_ms/);
  assert.match(nativePlayer, /open_to_reveal_ms/);

  // Il profilo mpv resta invariato; la cache NativeMediaSource viene evoluta nelle fasi successive.
  assert.match(nativePlayer, /api\.set_option\(handle, "cache-secs", "45"\)/);
  assert.match(nativePlayer, /api\.set_option\(handle, "stream-buffer-size", "2MiB"\)/);

  assert.match(analyzer, /transport_summary/);
  assert.match(analyzer, /maxBlockingFetchMs/);
  assert.match(packageJson, /analyze:native-player-transport/);
  assert.match(benchmark, /prefetch asincrono\/doppio buffer/);
});


test('Phase 6B.7 usa Range 2 MiB e prefetch async generation-aware sul secondo client TLS', () => {
  const nativePlayer = read('src-tauri/src/native_player.rs');
  const nativeSource = read('src-tauri/src/native_media_source.rs');
  const analyzer = read('scripts/analyze-native-player-transport.js');

  assert.match(nativeSource, /DEFAULT_MAX_RANGE_BYTES: usize = 2 \* 1024 \* 1024/);
  assert.match(nativeSource, /FOREGROUND_POOL_SLOT: usize = 0/);
  assert.match(nativeSource, /PREFETCH_POOL_SLOT: usize = 1/);
  assert.match(nativeSource, /struct PrefetchCoordinator/);
  assert.match(nativeSource, /thread::Builder::new\(\)[\s\S]*baia-native-prefetch/);
  assert.match(nativeSource, /event=prefetch_schedule/);
  assert.match(nativeSource, /event=prefetch_timeout/);
  assert.match(nativeSource, /prefetch\.invalidate\(\)/);
  assert.match(nativeSource, /template\.metrics\.generation\.load\(Ordering::Acquire\)/);
  assert.match(nativeSource, /PREFETCH_BODY_CHUNK_BYTES/);
  assert.match(nativeSource, /prefetch_cancelled/);
  assert.match(nativeSource, /prefetch_bytes_discarded/);
  assert.match(nativeSource, /PREFETCH_WAIT_SOFT_BUDGET/);
  assert.match(nativeSource, /PREFETCH_WAIT_HARD_BUDGET/);
  assert.match(nativeSource, /\(\*info\)\.cancel_fn = None/);
  assert.doesNotMatch(nativeSource, /stream_cancel_callback/);

  assert.match(nativePlayer, /prefetch_requests=\{\}/);
  assert.match(nativePlayer, /prefetch_wait_ms_max=\{\}/);
  assert.match(nativePlayer, /prefetch_bytes_discarded=\{\}/);
  assert.match(analyzer, /prefetchHits/);
  assert.match(analyzer, /prefetchWaitMaxMs/);
  assert.match(analyzer, /prefetchDiscardedMiB/);
});

test('Phase 6B.7.1 usa handoff progress-aware e limita i fallback duplicati', () => {
  const nativePlayer = read('src-tauri/src/native_player.rs');
  const nativeSource = read('src-tauri/src/native_media_source.rs');
  const analyzer = read('scripts/analyze-native-player-transport.js');

  assert.match(nativeSource, /PREFETCH_WAIT_SOFT_BUDGET: Duration = Duration::from_millis\(750\)/);
  assert.match(nativeSource, /PREFETCH_WAIT_HARD_BUDGET: Duration = Duration::from_millis\(3000\)/);
  assert.match(nativeSource, /PREFETCH_STALL_BUDGET: Duration = Duration::from_millis\(500\)/);
  assert.match(nativeSource, /struct PrefetchProgress/);
  assert.match(nativeSource, /headers_received: AtomicBool/);
  assert.match(nativeSource, /bytes_received: AtomicU64/);
  assert.match(nativeSource, /fn wait_ready_adaptive/);
  assert.match(nativeSource, /event=prefetch_wait_extend/);
  assert.match(nativeSource, /reason=stalled/);
  assert.match(nativeSource, /reason=hard_cap/);
  assert.match(nativeSource, /prefetch_wait_extensions/);
  assert.match(nativeSource, /prefetch_fallback_stalled/);
  assert.match(nativeSource, /prefetch_fallback_hard/);
  assert.match(nativePlayer, /prefetch_wait_extensions=\{\}/);
  assert.match(nativePlayer, /prefetch_fallback_stalled=\{\}/);
  assert.match(nativePlayer, /prefetch_fallback_hard=\{\}/);
  assert.match(analyzer, /prefetchWaitExtensions/);
  assert.match(analyzer, /prefetchFallbackStalled/);
  assert.match(analyzer, /prefetchFallbackHard/);
});


test('Phase 6B.7.2 usa cache sparsa LRU e preserva i segmenti sui seek miss', () => {
  const nativePlayer = read('src-tauri/src/native_player.rs');
  const nativeSource = read('src-tauri/src/native_media_source.rs');
  const analyzer = read('scripts/analyze-native-player-transport.js');

  assert.match(nativeSource, /DEFAULT_WINDOW_BYTES: usize = 64 \* 1024 \* 1024/);
  assert.match(nativeSource, /MAX_WINDOW_BYTES: usize = 128 \* 1024 \* 1024/);
  assert.match(nativeSource, /struct SparseRangeCache/);
  assert.match(nativeSource, /cache_policy=sparse_lru/);
  assert.match(nativeSource, /event=sparse_cache_miss/);
  assert.match(nativeSource, /cache_preserved_miss_bytes/);
  assert.match(nativeSource, /cache_evictions/);
  assert.match(nativeSource, /fetch_bytes_until_cached/);
  assert.match(nativeSource, /self\.sequential_fetches = if initial_seek \{ 0 \} else \{ 1 \}/);
  assert.doesNotMatch(nativeSource, /self\.cache\.clear\(\);\s*self\.cache_start = offset/);

  assert.match(nativePlayer, /seek_cache_misses=\{\}/);
  assert.match(nativePlayer, /cache_peak_bytes=\{\}/);
  assert.match(nativePlayer, /cache_evictions=\{\}/);
  assert.match(nativePlayer, /cache_preserved_miss_bytes=\{\}/);
  assert.match(analyzer, /seekCacheHitRate/);
  assert.match(analyzer, /cachePeakMiB/);
  assert.match(analyzer, /cacheEvictedMiB/);
});

test('Phase 6B.7.3 usa forward reservoir seriale low/high senza overlap foreground', () => {
  const nativePlayer = read('src-tauri/src/native_player.rs');
  const nativeSource = read('src-tauri/src/native_media_source.rs');
  const analyzer = read('scripts/analyze-native-player-transport.js');

  assert.match(nativeSource, /DEFAULT_RESERVOIR_LOW_BYTES: usize = 8 \* 1024 \* 1024/);
  assert.match(nativeSource, /DEFAULT_RESERVOIR_HIGH_BYTES: usize = 12 \* 1024 \* 1024/);
  assert.match(nativeSource, /RESERVOIR_LOW_ENV: &str = "BAIA_NATIVE_RESERVOIR_LOW_BYTES"/);
  assert.match(nativeSource, /RESERVOIR_HIGH_ENV: &str = "BAIA_NATIVE_RESERVOIR_HIGH_BYTES"/);
  assert.match(nativeSource, /struct PrefetchSpan/);
  assert.match(nativeSource, /spans: Vec<PrefetchSpan>/);
  assert.match(nativeSource, /for \(index, span\) in job\.spans\.into_iter\(\)\.enumerate\(\)/);
  assert.match(nativeSource, /reservoir_policy=serial_low_high/);
  assert.match(nativeSource, /event=reservoir_refill/);
  assert.match(nativeSource, /event=reservoir_harvest/);
  assert.match(nativeSource, /fn ensure_forward_reservoir/);
  assert.match(nativeSource, /fn harvest_prefetch_ready/);
  assert.match(nativeSource, /reservoir_ranges_scheduled/);
  assert.match(nativeSource, /reservoir_ranges_completed/);
  assert.doesNotMatch(nativeSource, /prefetch_overlap_scheduled/);

  assert.match(nativePlayer, /reservoir_low_bytes=\{\}/);
  assert.match(nativePlayer, /reservoir_high_bytes=\{\}/);
  assert.match(nativePlayer, /reservoir_depth_bytes=\{\}/);
  assert.match(nativePlayer, /reservoir_ranges_completed=\{\}/);
  assert.match(analyzer, /reservoirLowMiB/);
  assert.match(analyzer, /reservoirDepthMiB/);
  assert.match(analyzer, /reservoirCompletionRate/);
});

test('Phase 6B.7.3.1 protegge gli END_FILE prematuri e ricarica la stessa sorgente nativa', () => {
  const nativePlayer = read('src-tauri/src/native_player.rs');
  const analyzer = read('scripts/analyze-native-player-transport.js');

  assert.match(nativePlayer, /struct MpvEventEndFile/);
  assert.match(nativePlayer, /MPV_END_FILE_REASON_EOF: i32 = 0/);
  assert.match(nativePlayer, /MPV_END_FILE_REASON_ERROR: i32 = 4/);
  assert.match(nativePlayer, /PREMATURE_END_NEAR_END_SECONDS: f64 = 8\.0/);
  assert.match(nativePlayer, /fn end_file_is_premature/);
  assert.match(nativePlayer, /fn recover_premature_end_file/);
  assert.match(nativePlayer, /current_media_url = Some\(url\.clone\(\)\)/);
  assert.match(nativePlayer, /premature_end_recovery=start/);
  assert.match(nativePlayer, /action=reload_same_native_source/);
  assert.match(nativePlayer, /premature_end_recovery=stabilized/);
  assert.match(nativePlayer, /premature_end_files=\{\}/);
  assert.match(nativePlayer, /end_file_recoveries=\{\}/);
  assert.match(nativePlayer, /end_file_recovery_failures=\{\}/);
  assert.match(analyzer, /prematureEndFiles/);
  assert.match(analyzer, /endFileRecoveries/);
  assert.match(analyzer, /endFileRecoveryFailures/);
});
