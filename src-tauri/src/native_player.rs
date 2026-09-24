use crate::{core::CoreState, media_bridge::MediaBridge};
use libloading::Library;
use serde::Serialize;
use std::{
    env,
    ffi::{c_char, c_void, CStr, CString},
    path::{Path, PathBuf},
    ptr,
    sync::{
        mpsc::{self, Receiver, Sender},
        Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};
use tauri::{AppHandle, Manager, State};

const NATIVE_VIDEO_PLAYER_ENV: &str = "BAIA_NATIVE_VIDEO_PLAYER";
const LIBMPV_DLL_ENV: &str = "BAIA_LIBMPV_DLL";
const BACKEND_NAME: &str = "libmpv-embedded-wid";
const NATIVE_PLAYER_WINDOW_LABEL: &str = "baia-native-video";
const WORKER_START_TIMEOUT: Duration = Duration::from_secs(8);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(8);

type MpvCreate = unsafe extern "C" fn() -> *mut c_void;
type MpvInitialize = unsafe extern "C" fn(*mut c_void) -> i32;
type MpvTerminateDestroy = unsafe extern "C" fn(*mut c_void);
type MpvSetOptionString = unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char) -> i32;
type MpvSetPropertyString = unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char) -> i32;
type MpvGetPropertyString = unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_char;
type MpvCommand = unsafe extern "C" fn(*mut c_void, *const *const c_char) -> i32;
type MpvFree = unsafe extern "C" fn(*mut c_void);
type MpvErrorString = unsafe extern "C" fn(i32) -> *const c_char;
type MpvClientApiVersion = unsafe extern "C" fn() -> u64;

struct MpvApi {
    _library: Library,
    create: MpvCreate,
    initialize: MpvInitialize,
    terminate_destroy: MpvTerminateDestroy,
    set_option_string: MpvSetOptionString,
    set_property_string: MpvSetPropertyString,
    get_property_string: MpvGetPropertyString,
    command: MpvCommand,
    free: MpvFree,
    error_string: MpvErrorString,
    client_api_version: MpvClientApiVersion,
}

impl MpvApi {
    fn load(path: &Path) -> Result<Self, String> {
        let library = unsafe { Library::new(path) }
            .map_err(|error| format!("Impossibile caricare {}: {error}", path.display()))?;

        unsafe fn symbol<T: Copy>(library: &Library, name: &[u8]) -> Result<T, String> {
            let loaded: libloading::Symbol<'_, T> = library
                .get(name)
                .map_err(|error| format!("Simbolo libmpv mancante {}: {error}", String::from_utf8_lossy(name)))?;
            Ok(*loaded)
        }

        // SAFETY: tutti i simboli sono parte della Client API pubblica di libmpv.
        unsafe {
            Ok(Self {
                create: symbol(&library, b"mpv_create\0")?,
                initialize: symbol(&library, b"mpv_initialize\0")?,
                terminate_destroy: symbol(&library, b"mpv_terminate_destroy\0")?,
                set_option_string: symbol(&library, b"mpv_set_option_string\0")?,
                set_property_string: symbol(&library, b"mpv_set_property_string\0")?,
                get_property_string: symbol(&library, b"mpv_get_property_string\0")?,
                command: symbol(&library, b"mpv_command\0")?,
                free: symbol(&library, b"mpv_free\0")?,
                error_string: symbol(&library, b"mpv_error_string\0")?,
                client_api_version: symbol(&library, b"mpv_client_api_version\0")?,
                _library: library,
            })
        }
    }

    fn version_string(&self) -> String {
        let raw = unsafe { (self.client_api_version)() };
        let major = (raw >> 16) & 0xffff;
        let minor = raw & 0xffff;
        format!("libmpv client API {major}.{minor}")
    }

    fn error_text(&self, code: i32) -> String {
        let value = unsafe { (self.error_string)(code) };
        if value.is_null() {
            return format!("errore libmpv {code}");
        }
        unsafe { CStr::from_ptr(value) }.to_string_lossy().into_owned()
    }

    fn check(&self, code: i32, context: &str) -> Result<(), String> {
        if code >= 0 {
            Ok(())
        } else {
            Err(format!("{context}: {}", self.error_text(code)))
        }
    }

    fn set_option(&self, handle: *mut c_void, name: &str, value: &str) -> Result<(), String> {
        let name = CString::new(name).map_err(|_| "Nome opzione libmpv non valido.".to_string())?;
        let value = CString::new(value).map_err(|_| "Valore opzione libmpv non valido.".to_string())?;
        let code = unsafe { (self.set_option_string)(handle, name.as_ptr(), value.as_ptr()) };
        self.check(code, "Impossibile configurare libmpv")
    }

    fn set_property(&self, handle: *mut c_void, name: &str, value: &str) -> Result<(), String> {
        let name = CString::new(name).map_err(|_| "Nome proprietà libmpv non valido.".to_string())?;
        let value = CString::new(value).map_err(|_| "Valore proprietà libmpv non valido.".to_string())?;
        let code = unsafe { (self.set_property_string)(handle, name.as_ptr(), value.as_ptr()) };
        self.check(code, "Impossibile aggiornare libmpv")
    }

    fn get_property(&self, handle: *mut c_void, name: &str) -> Option<String> {
        let name = CString::new(name).ok()?;
        let value = unsafe { (self.get_property_string)(handle, name.as_ptr()) };
        if value.is_null() {
            return None;
        }
        let result = unsafe { CStr::from_ptr(value) }.to_string_lossy().into_owned();
        unsafe { (self.free)(value.cast::<c_void>()) };
        Some(result)
    }

    fn command(&self, handle: *mut c_void, values: &[String]) -> Result<(), String> {
        let c_values = values
            .iter()
            .map(|value| CString::new(value.as_str()).map_err(|_| "Comando libmpv non valido.".to_string()))
            .collect::<Result<Vec<_>, _>>()?;
        let mut pointers = c_values.iter().map(|value| value.as_ptr()).collect::<Vec<_>>();
        pointers.push(ptr::null());
        let code = unsafe { (self.command)(handle, pointers.as_ptr()) };
        self.check(code, "Comando libmpv fallito")
    }
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NativePlaybackState {
    active: bool,
    paused: bool,
    idle: bool,
    seeking: bool,
    paused_for_cache: bool,
    time_pos: Option<f64>,
    duration: Option<f64>,
    cache_duration: Option<f64>,
    cache_buffering_state: Option<f64>,
    hwdec_current: Option<String>,
    video_codec: Option<String>,
    audio_codec: Option<String>,
}

impl NativePlaybackState {
    fn from_mpv(api: &MpvApi, handle: *mut c_void) -> Self {
        let bool_property = |name: &str| {
            api.get_property(handle, name)
                .is_some_and(|value| matches!(value.as_str(), "yes" | "true" | "1"))
        };
        let number_property = |name: &str| {
            api.get_property(handle, name)
                .and_then(|value| value.parse::<f64>().ok())
        };
        let idle = bool_property("idle-active");
        Self {
            active: !idle,
            paused: bool_property("pause"),
            idle,
            seeking: bool_property("seeking"),
            paused_for_cache: bool_property("paused-for-cache"),
            time_pos: number_property("time-pos"),
            duration: number_property("duration"),
            cache_duration: number_property("demuxer-cache-duration"),
            cache_buffering_state: number_property("cache-buffering-state"),
            hwdec_current: api.get_property(handle, "hwdec-current").filter(|value| !value.is_empty() && value != "no"),
            video_codec: api.get_property(handle, "video-codec"),
            audio_codec: api.get_property(handle, "audio-codec"),
        }
    }
}

enum PlayerCommand {
    Open {
        url: String,
        response: Sender<Result<(), String>>,
    },
    SetPaused {
        paused: bool,
        response: Sender<Result<(), String>>,
    },
    Seek {
        seconds: f64,
        response: Sender<Result<(), String>>,
    },
    SetVolume {
        volume: f64,
        response: Sender<Result<(), String>>,
    },
    Stop {
        response: Sender<Result<(), String>>,
    },
    GetState {
        response: Sender<Result<NativePlaybackState, String>>,
    },
    Shutdown,
}

struct PlayerRuntime {
    native_window_handle: usize,
    sender: Sender<PlayerCommand>,
    worker: JoinHandle<()>,
}

pub struct NativePlayerState {
    resource_dir: PathBuf,
    runtime: Mutex<Option<PlayerRuntime>>,
}

impl NativePlayerState {
    fn new(resource_dir: PathBuf) -> Self {
        Self {
            resource_dir,
            runtime: Mutex::new(None),
        }
    }

    fn dll_candidates(&self) -> Vec<PathBuf> {
        let mut candidates = Vec::new();
        if let Ok(value) = env::var(LIBMPV_DLL_ENV) {
            let value = value.trim();
            if !value.is_empty() {
                candidates.push(PathBuf::from(value));
            }
        }
        if let Some(value) = option_env!("BAIA_LIBMPV_DLL") {
            let value = value.trim();
            if !value.is_empty() {
                candidates.push(PathBuf::from(value));
            }
        }
        candidates.push(self.resource_dir.join("libmpv").join("libmpv-2.dll"));
        if let Ok(executable) = env::current_exe() {
            if let Some(parent) = executable.parent() {
                candidates.push(parent.join("libmpv-2.dll"));
                candidates.push(parent.join("libmpv").join("libmpv-2.dll"));
            }
        }
        if let Ok(current) = env::current_dir() {
            candidates.push(current.join("src-tauri").join("resources").join("libmpv").join("libmpv-2.dll"));
            candidates.push(current.join("resources").join("libmpv").join("libmpv-2.dll"));
        }
        candidates
    }

    fn dll_path(&self) -> Option<PathBuf> {
        self.dll_candidates().into_iter().find(|candidate| candidate.is_file())
    }

    fn probe(&self) -> Result<String, String> {
        if !cfg!(target_os = "windows") {
            return Err("La prima integrazione libmpv embedded è abilitata solo sul client Windows.".to_string());
        }
        let path = self.dll_path().ok_or_else(|| {
            format!(
                "libmpv-2.dll non trovata. Esegui scripts/prepare-libmpv-windows.ps1 prima della build oppure configura {LIBMPV_DLL_ENV}."
            )
        })?;
        let api = MpvApi::load(&path)?;
        Ok(api.version_string())
    }

    fn ensure_runtime(&self, hwnd: usize) -> Result<Sender<PlayerCommand>, String> {
        let path = self.dll_path().ok_or_else(|| {
            format!(
                "libmpv-2.dll non trovata. Esegui scripts/prepare-libmpv-windows.ps1 prima della build oppure configura {LIBMPV_DLL_ENV}."
            )
        })?;

        let mut runtime = self
            .runtime
            .lock()
            .map_err(|_| "Stato libmpv non disponibile.".to_string())?;
        if let Some(existing) = runtime.as_ref() {
            if existing.native_window_handle == hwnd {
                return Ok(existing.sender.clone());
            }
        }
        if let Some(existing) = runtime.take() {
            let _ = existing.sender.send(PlayerCommand::Shutdown);
            let _ = existing.worker.join();
        }

        let (sender, receiver) = mpsc::channel();
        let (ready_sender, ready_receiver) = mpsc::channel();
        let worker = thread::Builder::new()
            .name("baia-libmpv".to_string())
            .spawn(move || player_worker(path, hwnd, receiver, ready_sender))
            .map_err(|error| format!("Impossibile avviare il thread libmpv: {error}"))?;

        match ready_receiver.recv_timeout(WORKER_START_TIMEOUT) {
            Ok(Ok(_version)) => {
                *runtime = Some(PlayerRuntime {
                    native_window_handle: hwnd,
                    sender: sender.clone(),
                    worker,
                });
                Ok(sender)
            }
            Ok(Err(error)) => {
                let _ = worker.join();
                Err(error)
            }
            Err(_) => {
                let _ = sender.send(PlayerCommand::Shutdown);
                // Drop del JoinHandle: non trasformare il timeout in un join potenzialmente infinito.
                drop(worker);
                Err("Timeout durante l'inizializzazione di libmpv.".to_string())
            }
        }
    }

    fn send_unit<F>(&self, build: F) -> Result<(), String>
    where
        F: FnOnce(Sender<Result<(), String>>) -> PlayerCommand,
    {
        let sender = {
            let runtime = self
                .runtime
                .lock()
                .map_err(|_| "Stato libmpv non disponibile.".to_string())?;
            runtime
                .as_ref()
                .map(|runtime| runtime.sender.clone())
                .ok_or_else(|| "Player libmpv non ancora avviato.".to_string())?
        };
        let (response_sender, response_receiver) = mpsc::channel();
        sender
            .send(build(response_sender))
            .map_err(|_| "Thread libmpv terminato inaspettatamente.".to_string())?;
        response_receiver
            .recv_timeout(COMMAND_TIMEOUT)
            .map_err(|_| "Timeout comando libmpv.".to_string())?
    }

    fn open(&self, url: String, hwnd: usize) -> Result<(), String> {
        let sender = self.ensure_runtime(hwnd)?;
        let (response_sender, response_receiver) = mpsc::channel();
        sender
            .send(PlayerCommand::Open {
                url,
                response: response_sender,
            })
            .map_err(|_| "Thread libmpv terminato inaspettatamente.".to_string())?;
        response_receiver
            .recv_timeout(COMMAND_TIMEOUT)
            .map_err(|_| "Timeout apertura media libmpv.".to_string())?
    }

    fn set_paused(&self, paused: bool) -> Result<(), String> {
        self.send_unit(|response| PlayerCommand::SetPaused { paused, response })
    }

    fn seek(&self, seconds: f64) -> Result<(), String> {
        self.send_unit(|response| PlayerCommand::Seek { seconds, response })
    }

    fn set_volume(&self, volume: f64) -> Result<(), String> {
        self.send_unit(|response| PlayerCommand::SetVolume { volume, response })
    }

    fn stop(&self) -> Result<(), String> {
        let sender = {
            let runtime = self
                .runtime
                .lock()
                .map_err(|_| "Stato libmpv non disponibile.".to_string())?;
            runtime.as_ref().map(|runtime| runtime.sender.clone())
        };
        let Some(sender) = sender else {
            return Ok(());
        };
        let (response_sender, response_receiver) = mpsc::channel();
        sender
            .send(PlayerCommand::Stop {
                response: response_sender,
            })
            .map_err(|_| "Thread libmpv terminato inaspettatamente.".to_string())?;
        response_receiver
            .recv_timeout(COMMAND_TIMEOUT)
            .map_err(|_| "Timeout arresto libmpv.".to_string())?
    }

    fn shutdown_runtime(&self) {
        let runtime = self.runtime.lock().ok().and_then(|mut runtime| runtime.take());
        if let Some(runtime) = runtime {
            let _ = runtime.sender.send(PlayerCommand::Shutdown);
            let _ = runtime.worker.join();
        }
    }

    fn playback_state(&self) -> Result<NativePlaybackState, String> {
        let sender = {
            let runtime = self
                .runtime
                .lock()
                .map_err(|_| "Stato libmpv non disponibile.".to_string())?;
            runtime.as_ref().map(|runtime| runtime.sender.clone())
        };
        let Some(sender) = sender else {
            return Ok(NativePlaybackState {
                idle: true,
                ..NativePlaybackState::default()
            });
        };
        let (response_sender, response_receiver) = mpsc::channel();
        sender
            .send(PlayerCommand::GetState {
                response: response_sender,
            })
            .map_err(|_| "Thread libmpv terminato inaspettatamente.".to_string())?;
        response_receiver
            .recv_timeout(COMMAND_TIMEOUT)
            .map_err(|_| "Timeout lettura stato libmpv.".to_string())?
    }
}

impl Drop for NativePlayerState {
    fn drop(&mut self) {
        if let Ok(runtime) = self.runtime.get_mut() {
            if let Some(runtime) = runtime.take() {
                let _ = runtime.sender.send(PlayerCommand::Shutdown);
                let _ = runtime.worker.join();
            }
        }
    }
}

fn player_worker(
    dll_path: PathBuf,
    native_window_handle: usize,
    receiver: Receiver<PlayerCommand>,
    ready: Sender<Result<String, String>>,
) {
    let api = match MpvApi::load(&dll_path) {
        Ok(api) => api,
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };
    let version = api.version_string();
    let handle = unsafe { (api.create)() };
    if handle.is_null() {
        let _ = ready.send(Err("mpv_create ha restituito un handle nullo.".to_string()));
        return;
    }

    let configure = (|| -> Result<(), String> {
        // Il JS non può fornire opzioni mpv. Il profilo iniziale resta piccolo e
        // misurabile: cache/demux/seek rimangono responsabilità del motore nativo.
        api.set_option(handle, "config", "no")?;
        api.set_option(handle, "terminal", "no")?;
        api.set_option(handle, "input-default-bindings", "yes")?;
        api.set_option(handle, "input-vo-keyboard", "yes")?;
        api.set_option(handle, "force-window", "yes")?;
        // mpv su win32 documenta wid come HWND convertito a uint32_t.
        let wid = native_window_handle as u32;
        api.set_option(handle, "wid", &wid.to_string())?;
        api.set_option(handle, "cache", "yes")?;
        api.set_option(handle, "demuxer-seekable-cache", "yes")?;
        api.set_option(handle, "hwdec", "auto")?;
        let code = unsafe { (api.initialize)(handle) };
        api.check(code, "Impossibile inizializzare libmpv")?;
        Ok(())
    })();

    if let Err(error) = configure {
        unsafe { (api.terminate_destroy)(handle) };
        let _ = ready.send(Err(error));
        return;
    }

    let _ = ready.send(Ok(version));

    while let Ok(command) = receiver.recv() {
        match command {
            PlayerCommand::Open { url, response } => {
                let result = api.command(
                    handle,
                    &["loadfile".to_string(), url, "replace".to_string()],
                );
                let _ = response.send(result);
            }
            PlayerCommand::SetPaused { paused, response } => {
                let result = api.set_property(handle, "pause", if paused { "yes" } else { "no" });
                let _ = response.send(result);
            }
            PlayerCommand::Seek { seconds, response } => {
                let result = if seconds.is_finite() && seconds >= 0.0 {
                    // absolute+keyframes privilegia reattività durante i test di seek.
                    // La precisione finale potrà essere affinata dopo aver misurato rete e cache.
                    api.command(
                        handle,
                        &[
                            "seek".to_string(),
                            format!("{seconds:.3}"),
                            "absolute+keyframes".to_string(),
                        ],
                    )
                } else {
                    Err("Posizione seek non valida.".to_string())
                };
                let _ = response.send(result);
            }
            PlayerCommand::SetVolume { volume, response } => {
                let result = if volume.is_finite() {
                    api.set_property(handle, "volume", &format!("{:.2}", volume.clamp(0.0, 100.0)))
                } else {
                    Err("Volume non valido.".to_string())
                };
                let _ = response.send(result);
            }
            PlayerCommand::Stop { response } => {
                let result = api.command(handle, &["stop".to_string()]);
                let _ = response.send(result);
            }
            PlayerCommand::GetState { response } => {
                let _ = response.send(Ok(NativePlaybackState::from_mpv(&api, handle)));
            }
            PlayerCommand::Shutdown => break,
        }
    }

    unsafe { (api.terminate_destroy)(handle) };
}

fn configured_value(name: &str, compiled: Option<&'static str>) -> Option<String> {
    match env::var(name) {
        Ok(value) => Some(value),
        Err(env::VarError::NotPresent) => compiled.map(str::to_string),
        Err(env::VarError::NotUnicode(_)) => None,
    }
}

fn native_player_enabled() -> bool {
    configured_value(NATIVE_VIDEO_PLAYER_ENV, option_env!("BAIA_NATIVE_VIDEO_PLAYER"))
        .is_some_and(|value| matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
}

pub fn initialize(app: &mut tauri::App) -> Result<NativePlayerState, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("Resource directory Tauri non disponibile: {error}"))?;
    Ok(NativePlayerState::new(resource_dir))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePlayerStatus {
    enabled: bool,
    available: bool,
    backend: &'static str,
    version: Option<String>,
    detail: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePlayerLaunch {
    started: bool,
    backend: &'static str,
}

#[tauri::command]
pub fn baia_core_native_player_status(player: State<'_, NativePlayerState>) -> NativePlayerStatus {
    let enabled = native_player_enabled();
    if !enabled {
        return NativePlayerStatus {
            enabled,
            available: false,
            backend: BACKEND_NAME,
            version: None,
            detail: None,
        };
    }
    match player.probe() {
        Ok(version) => NativePlayerStatus {
            enabled,
            available: true,
            backend: BACKEND_NAME,
            version: Some(version),
            detail: None,
        },
        Err(error) => NativePlayerStatus {
            enabled,
            available: false,
            backend: BACKEND_NAME,
            version: None,
            detail: Some(error),
        },
    }
}

#[tauri::command]
pub async fn baia_core_native_player_open(
    movie_id: u64,
    app: AppHandle,
    core_state: State<'_, CoreState>,
    bridge: State<'_, MediaBridge>,
    player: State<'_, NativePlayerState>,
) -> Result<NativePlayerLaunch, String> {
    if !native_player_enabled() {
        return Err(format!(
            "Native player disattivato. Imposta {NATIVE_VIDEO_PLAYER_ENV}=true per usare libmpv embedded."
        ));
    }
    if movie_id == 0 {
        return Err("movieId non valido per il native player.".to_string());
    }
    player.probe()?;

    // Il frontend continua a passare soltanto l'identificatore logico. URL locale,
    // grant, chiave device e pin TLS restano nel Core Rust/Media Bridge.
    let media_url = bridge.register_movie_stream(movie_id, &core_state)?;

    let window = if let Some(window) = app.get_window(NATIVE_PLAYER_WINDOW_LABEL) {
        window
    } else {
        let window = tauri::window::WindowBuilder::new(&app, NATIVE_PLAYER_WINDOW_LABEL)
            .title("Baia Cinghiala — Player nativo")
            .inner_size(1280.0, 720.0)
            .min_inner_size(640.0, 360.0)
            .resizable(true)
            .visible(false)
            .build()
            .map_err(|error| format!("Impossibile creare la finestra video nativa: {error}"))?;

        let app_for_close = app.clone();
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed) {
                if let Some(player) = app_for_close.try_state::<NativePlayerState>() {
                    player.shutdown_runtime();
                }
            }
        });
        window
    };

    #[cfg(target_os = "windows")]
    let hwnd = window
        .hwnd()
        .map_err(|error| format!("HWND player nativo non disponibile: {error}"))?
        .0 as usize;

    #[cfg(not(target_os = "windows"))]
    let hwnd = 0usize;

    if hwnd == 0 {
        return Err("Finestra video nativa non disponibile su questa piattaforma.".to_string());
    }

    player.open(media_url, hwnd)?;
    window
        .show()
        .map_err(|error| format!("Impossibile mostrare il player nativo: {error}"))?;
    let _ = window.set_focus();

    Ok(NativePlayerLaunch {
        started: true,
        backend: BACKEND_NAME,
    })
}

#[tauri::command]
pub fn baia_core_native_player_play(player: State<'_, NativePlayerState>) -> Result<(), String> {
    player.set_paused(false)
}

#[tauri::command]
pub fn baia_core_native_player_pause(player: State<'_, NativePlayerState>) -> Result<(), String> {
    player.set_paused(true)
}

#[tauri::command]
pub fn baia_core_native_player_seek(
    seconds: f64,
    player: State<'_, NativePlayerState>,
) -> Result<(), String> {
    player.seek(seconds)
}

#[tauri::command]
pub fn baia_core_native_player_set_volume(
    value: f64,
    player: State<'_, NativePlayerState>,
) -> Result<(), String> {
    player.set_volume(value)
}

#[tauri::command]
pub fn baia_core_native_player_get_state(
    player: State<'_, NativePlayerState>,
) -> Result<NativePlaybackState, String> {
    player.playback_state()
}

#[tauri::command]
pub fn baia_core_native_player_stop(
    app: AppHandle,
    player: State<'_, NativePlayerState>,
) -> Result<bool, String> {
    player.stop()?;
    player.shutdown_runtime();
    if let Some(window) = app.get_window(NATIVE_PLAYER_WINDOW_LABEL) {
        let _ = window.close();
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::{configured_value, BACKEND_NAME};

    #[test]
    fn embedded_backend_is_explicitly_libmpv() {
        assert_eq!(BACKEND_NAME, "libmpv-embedded-wid");
    }

    #[test]
    fn configured_value_uses_compiled_fallback() {
        let name = "BAIA_TEST_NATIVE_PLAYER_VALUE_SHOULD_NOT_EXIST";
        std::env::remove_var(name);
        assert_eq!(configured_value(name, Some("fallback")), Some("fallback".to_string()));
    }
}
