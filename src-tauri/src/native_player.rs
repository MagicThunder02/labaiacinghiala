use crate::{
    core::CoreState,
    native_media_source::{
        self, MpvStreamOpenFn, NativeMediaSourceRegistry,
        NativeMediaSourceStats, NativeMediaSourceTemplate,
    },
};
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
const BACKEND_NAME: &str = "libmpv-baia-native-source";
const MAIN_WINDOW_LABEL: &str = "main";
const OSC_RESOURCE_PATH: &str = "mpv/baia-osc.lua";
const UI_NAME: &str = "baia-native-osc";
const EVENT_POLL_INTERVAL: Duration = Duration::from_millis(40);
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
type MpvWaitEvent = unsafe extern "C" fn(*mut c_void, f64) -> *const MpvEvent;

#[repr(C)]
struct MpvEvent {
    event_id: i32,
    error: i32,
    reply_userdata: u64,
    data: *mut c_void,
}

const MPV_EVENT_NONE: i32 = 0;
const MPV_EVENT_SHUTDOWN: i32 = 1;
const MPV_EVENT_END_FILE: i32 = 7;
const MPV_EVENT_FILE_LOADED: i32 = 8;
type MpvStreamCbAddRo = unsafe extern "C" fn(
    *mut c_void,
    *const c_char,
    *mut c_void,
    MpvStreamOpenFn,
) -> i32;

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
    wait_event: MpvWaitEvent,
    stream_cb_add_ro: MpvStreamCbAddRo,
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
                wait_event: symbol(&library, b"mpv_wait_event\0")?,
                stream_cb_add_ro: symbol(&library, b"mpv_stream_cb_add_ro\0")?,
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
    cache_speed: Option<f64>,
    volume: Option<f64>,
    muted: bool,
    fullscreen: bool,
    demuxer_cache_idle: bool,
    demuxer_cache_state: Option<String>,
    hwdec_current: Option<String>,
    video_codec: Option<String>,
    audio_codec: Option<String>,
    source: Option<NativeMediaSourceStats>,
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
            cache_speed: number_property("cache-speed"),
            volume: number_property("volume"),
            muted: bool_property("mute"),
            fullscreen: bool_property("user-data/baia/fullscreen"),
            demuxer_cache_idle: bool_property("demuxer-cache-idle"),
            demuxer_cache_state: api.get_property(handle, "demuxer-cache-state"),
            hwdec_current: api.get_property(handle, "hwdec-current").filter(|value| !value.is_empty() && value != "no"),
            video_codec: api.get_property(handle, "video-codec"),
            audio_codec: api.get_property(handle, "audio-codec"),
            source: None,
        }
    }
}

enum PlayerCommand {
    Open {
        source: NativeMediaSourceTemplate,
        title: String,
        meta: String,
        accent: String,
        start_seconds: f64,
        volume: f64,
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

    fn osc_path(&self) -> PathBuf {
        self.resource_dir.join(OSC_RESOURCE_PATH)
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
        let osc_path = self.osc_path();
        if !osc_path.is_file() {
            return Err(format!("OSC nativo Baia non trovato: {}", osc_path.display()));
        }
        let api = MpvApi::load(&path)?;
        Ok(api.version_string())
    }

    fn ensure_runtime(
        &self,
        app: AppHandle,
        parent_window_handle: usize,
        initial_fullscreen: bool,
    ) -> Result<Sender<PlayerCommand>, String> {
        let path = self.dll_path().ok_or_else(|| {
            format!(
                "libmpv-2.dll non trovata. Esegui scripts/prepare-libmpv-windows.ps1 prima della build oppure configura {LIBMPV_DLL_ENV}."
            )
        })?;
        let osc_path = self.osc_path();
        if !osc_path.is_file() {
            return Err(format!(
                "OSC nativo Baia non trovato: {}",
                osc_path.display()
            ));
        }

        let mut runtime = self
            .runtime
            .lock()
            .map_err(|_| "Stato libmpv non disponibile.".to_string())?;

        if runtime.as_ref().is_some_and(|existing| existing.worker.is_finished()) {
            if let Some(existing) = runtime.take() {
                let _ = existing.worker.join();
            }
        }
        if let Some(existing) = runtime.as_ref() {
            return Ok(existing.sender.clone());
        }

        let (sender, receiver) = mpsc::channel();
        let (ready_sender, ready_receiver) = mpsc::channel();
        let worker = thread::Builder::new()
            .name("baia-libmpv".to_string())
            .spawn(move || {
                player_worker(
                    path,
                    osc_path,
                    parent_window_handle,
                    initial_fullscreen,
                    app,
                    receiver,
                    ready_sender,
                )
            })
            .map_err(|error| format!("Impossibile avviare il thread libmpv: {error}"))?;

        match ready_receiver.recv_timeout(WORKER_START_TIMEOUT) {
            Ok(Ok(_version)) => {
                *runtime = Some(PlayerRuntime {
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

    fn open(
        &self,
        source: NativeMediaSourceTemplate,
        app: AppHandle,
        parent_window_handle: usize,
        initial_fullscreen: bool,
        title: String,
        meta: String,
        accent: String,
        start_seconds: f64,
        volume: f64,
    ) -> Result<(), String> {
        let sender = self.ensure_runtime(app, parent_window_handle, initial_fullscreen)?;
        let (response_sender, response_receiver) = mpsc::channel();
        sender
            .send(PlayerCommand::Open {
                source,
                title,
                meta,
                accent,
                start_seconds,
                volume,
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
            runtime
                .as_ref()
                .filter(|runtime| !runtime.worker.is_finished())
                .map(|runtime| runtime.sender.clone())
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
            runtime
                .as_ref()
                .filter(|runtime| !runtime.worker.is_finished())
                .map(|runtime| runtime.sender.clone())
        };
        let Some(sender) = sender else {
            return Ok(NativePlaybackState {
                idle: true,
                ..NativePlaybackState::default()
            });
        };
        let (response_sender, response_receiver) = mpsc::channel();
        if sender
            .send(PlayerCommand::GetState {
                response: response_sender,
            })
            .is_err()
        {
            return Ok(NativePlaybackState {
                idle: true,
                ..NativePlaybackState::default()
            });
        }
        response_receiver
            .recv_timeout(COMMAND_TIMEOUT)
            .unwrap_or_else(|_| Ok(NativePlaybackState {
                idle: true,
                ..NativePlaybackState::default()
            }))
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
    osc_path: PathBuf,
    parent_window_handle: usize,
    initial_fullscreen: bool,
    app: AppHandle,
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

    let registry = Box::new(NativeMediaSourceRegistry::new());
    let registry_ptr = (&*registry as *const NativeMediaSourceRegistry) as *mut c_void;

    let configure = (|| -> Result<(), String> {
        // libmpv crea una child window Win32 dentro l'HWND principale di Baia.
        // Non esiste quindi una seconda top-level window: taskbar, titolo,
        // posizione, resize e minimizzazione restano quelli della finestra Tauri.
        api.set_option(handle, "config", "no")?;
        api.set_option(handle, "terminal", "no")?;
        api.set_option(handle, "input-default-bindings", "no")?;
        api.set_option(handle, "input-builtin-bindings", "no")?;
        api.set_option(handle, "input-vo-keyboard", "yes")?;
        api.set_option(handle, "force-window", "no")?;
        api.set_option(handle, "keep-open", "no")?;
        api.set_option(handle, "background-color", "#000000")?;
        api.set_option(handle, "cursor-autohide", "2400")?;
        api.set_option(handle, "osc", "no")?;
        api.set_option(handle, "osd-bar", "no")?;
        api.set_option(handle, "save-position-on-quit", "no")?;

        // mpv documenta wid Win32 come HWND convertito a uint32_t.
        let wid = parent_window_handle as u32;
        api.set_option(handle, "wid", &wid.to_string())?;

        let osc = osc_path.to_string_lossy().into_owned();
        api.set_option(handle, "script", &osc)?;

        // Profilo rete Phase 4: non viene modificato in questa iterazione.
        api.set_option(handle, "cache", "yes")?;
        api.set_option(handle, "cache-secs", "45")?;
        api.set_option(handle, "cache-pause", "yes")?;
        api.set_option(handle, "cache-pause-initial", "yes")?;
        api.set_option(handle, "cache-pause-wait", "5")?;
        api.set_option(handle, "demuxer-max-bytes", "64MiB")?;
        api.set_option(handle, "demuxer-max-back-bytes", "32MiB")?;
        api.set_option(handle, "demuxer-seekable-cache", "yes")?;
        api.set_option(handle, "demuxer-hysteresis-secs", "15")?;
        api.set_option(handle, "stream-buffer-size", "2MiB")?;
        api.set_option(handle, "demuxer-termination-timeout", "5")?;
        api.set_option(handle, "hwdec", "auto")?;

        let code = unsafe { (api.initialize)(handle) };
        api.check(code, "Impossibile inizializzare libmpv")?;
        let protocol = native_media_source::protocol_name();
        let code = unsafe {
            (api.stream_cb_add_ro)(
                handle,
                protocol.as_ptr().cast::<c_char>(),
                registry_ptr,
                native_media_source::stream_open_callback,
            )
        };
        api.check(code, "Impossibile registrare il protocollo baia:// in libmpv")?;
        Ok(())
    })();

    if let Err(error) = configure {
        unsafe { (api.terminate_destroy)(handle) };
        let _ = ready.send(Err(error));
        return;
    }

    let _ = ready.send(Ok(version));
    let mut running = true;
    let mut last_fullscreen_request = String::new();

    while running {
        match receiver.recv_timeout(EVENT_POLL_INTERVAL) {
            Ok(command) => match command {
                PlayerCommand::Open {
                    source,
                    title,
                    meta,
                    accent,
                    start_seconds,
                    volume,
                    response,
                } => {
                    let result = registry.register(source).and_then(|url| {
                        let fullscreen = app
                            .get_window(MAIN_WINDOW_LABEL)
                            .and_then(|window| window.is_fullscreen().ok())
                            .unwrap_or(initial_fullscreen);
                        api.set_property(
                            handle,
                            "user-data/baia/fullscreen",
                            if fullscreen { "yes" } else { "no" },
                        )?;
                        api.set_property(handle, "user-data/baia/fullscreen-request", "")?;
                        last_fullscreen_request.clear();
                        api.set_property(handle, "user-data/baia/title", title.trim())?;
                        api.set_property(handle, "user-data/baia/meta", meta.trim())?;
                        api.set_property(handle, "user-data/baia/accent", accent.trim())?;
                        api.set_property(handle, "force-media-title", title.trim())?;
                        api.set_property(
                            handle,
                            "volume",
                            &format!("{:.2}", volume.clamp(0.0, 100.0)),
                        )?;

                        let mut command = vec![
                            "loadfile".to_string(),
                            url,
                            "replace".to_string(),
                        ];
                        if start_seconds.is_finite() && start_seconds > 0.0 {
                            command.push("-1".to_string());
                            command.push(format!("start={:.3}", start_seconds));
                        }
                        api.command(handle, &command)?;
                        api.set_property(handle, "pause", "no")?;
                        Ok(())
                    });
                    if result.is_ok() {
                        eprintln!(
                            "native_player event=open player_backend=libmpv media_source=native_media_source ui={} start_seconds={:.3}",
                            UI_NAME,
                            start_seconds.max(0.0)
                        );
                    }
                    let _ = response.send(result);
                }
                PlayerCommand::SetPaused { paused, response } => {
                    let result = api.set_property(handle, "pause", if paused { "yes" } else { "no" });
                    let _ = response.send(result);
                }
                PlayerCommand::Seek { seconds, response } => {
                    let result = if seconds.is_finite() && seconds >= 0.0 {
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
                    let mut state = NativePlaybackState::from_mpv(&api, handle);
                    state.source = registry.current_stats();
                    let _ = response.send(Ok(state));
                }
                PlayerCommand::Shutdown => running = false,
            },
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => running = false,
        }

        loop {
            let event = unsafe { (api.wait_event)(handle, 0.0) };
            if event.is_null() {
                break;
            }
            let event_id = unsafe { (*event).event_id };
            if event_id == MPV_EVENT_NONE {
                break;
            }
            if event_id == MPV_EVENT_FILE_LOADED {
                eprintln!(
                    "native_player event=file_loaded player_backend=libmpv media_source=native_media_source ui={}",
                    UI_NAME
                );
            }
            if event_id == MPV_EVENT_END_FILE {
                eprintln!("native_player event=end_file player_backend=libmpv ui={}", UI_NAME);
                running = false;
                break;
            }
            if event_id == MPV_EVENT_SHUTDOWN {
                running = false;
                break;
            }
        }

        if running {
            if let Some(request) = api.get_property(handle, "user-data/baia/fullscreen-request") {
                let request = request.trim().to_string();
                if !request.is_empty() && request != last_fullscreen_request {
                    let desired = request.split(':').next().and_then(parse_switch);
                    if let Some(desired) = desired {
                        if let Some(window) = app.get_window(MAIN_WINDOW_LABEL) {
                            if window.set_fullscreen(desired).is_ok() {
                                let _ = api.set_property(
                                    handle,
                                    "user-data/baia/fullscreen",
                                    if desired { "yes" } else { "no" },
                                );
                            }
                        }
                    }
                    last_fullscreen_request = request;
                }
            }
        }
    }

    unsafe { (api.terminate_destroy)(handle) };
    if let Some(window) = app.get_window(MAIN_WINDOW_LABEL) {
        let _ = window.set_fullscreen(initial_fullscreen);
        let _ = window.set_focus();
    }
    eprintln!("native_player event=closed player_backend=libmpv ui={}", UI_NAME);
}

fn configured_value(name: &str, compiled: Option<&'static str>) -> Option<String> {
    match env::var(name) {
        Ok(value) => Some(value),
        Err(env::VarError::NotPresent) => compiled.map(str::to_string),
        Err(env::VarError::NotUnicode(_)) => None,
    }
}

fn parse_switch(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn native_player_enabled() -> bool {
    match configured_value(NATIVE_VIDEO_PLAYER_ENV, option_env!("BAIA_NATIVE_VIDEO_PLAYER")) {
        Some(value) => parse_switch(&value).unwrap_or(cfg!(target_os = "windows")),
        None => cfg!(target_os = "windows"),
    }
}

fn clean_text(value: Option<String>, fallback: &str, max_chars: usize) -> String {
    let normalized = value
        .unwrap_or_default()
        .chars()
        .map(|character| if matches!(character, '\r' | '\n' | '\0') { ' ' } else { character })
        .collect::<String>()
        .trim()
        .chars()
        .take(max_chars)
        .collect::<String>();
    if normalized.is_empty() {
        fallback.to_string()
    } else {
        normalized
    }
}

fn clean_meta(value: Option<String>) -> String {
    value
        .unwrap_or_default()
        .chars()
        .map(|character| if matches!(character, '\r' | '\n' | '\0') { ' ' } else { character })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(260)
        .collect()
}

fn clean_accent(value: Option<String>) -> String {
    let value = value.unwrap_or_default();
    let value = value.trim();
    if value.len() == 7
        && value.starts_with('#')
        && value[1..].chars().all(|character| character.is_ascii_hexdigit())
    {
        value.to_ascii_lowercase()
    } else {
        "#8f79ff".to_string()
    }
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
    ui: &'static str,
    media_source: &'static str,
    version: Option<String>,
    detail: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePlayerLaunch {
    started: bool,
    backend: &'static str,
    ui: &'static str,
    media_source: &'static str,
}

#[tauri::command]
pub fn baia_core_native_player_status(player: State<'_, NativePlayerState>) -> NativePlayerStatus {
    let enabled = native_player_enabled();
    if !enabled {
        return NativePlayerStatus {
            enabled,
            available: false,
            backend: BACKEND_NAME,
            ui: UI_NAME,
            media_source: "native_media_source",
            version: None,
            detail: None,
        };
    }
    match player.probe() {
        Ok(version) => NativePlayerStatus {
            enabled,
            available: true,
            backend: BACKEND_NAME,
            ui: UI_NAME,
            media_source: "native_media_source",
            version: Some(version),
            detail: None,
        },
        Err(error) => NativePlayerStatus {
            enabled,
            available: false,
            backend: BACKEND_NAME,
            ui: UI_NAME,
            media_source: "native_media_source",
            version: None,
            detail: Some(error),
        },
    }
}

#[tauri::command]
pub async fn baia_core_native_player_open(
    movie_id: u64,
    title: Option<String>,
    meta: Option<String>,
    accent: Option<String>,
    start_seconds: Option<f64>,
    volume: Option<f64>,
    app: AppHandle,
    core_state: State<'_, CoreState>,
    player: State<'_, NativePlayerState>,
) -> Result<NativePlayerLaunch, String> {
    if !native_player_enabled() {
        return Err(format!(
            "Native player disattivato tramite {NATIVE_VIDEO_PLAYER_ENV}."
        ));
    }
    if movie_id == 0 {
        return Err("movieId non valido per il native player.".to_string());
    }
    player.probe()?;

    // Il frontend passa solo l'identificatore logico e dati di presentazione.
    // URL, autorizzazione, certificati e chiavi restano nel Core Rust.
    let media_source = NativeMediaSourceTemplate::for_movie(movie_id, &core_state)?;
    let main_window = app
        .get_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "Finestra principale Baia non disponibile.".to_string())?;

    #[cfg(target_os = "windows")]
    let parent_window_handle = main_window
        .hwnd()
        .map_err(|error| format!("HWND principale Baia non disponibile: {error}"))?
        .0 as usize;

    #[cfg(not(target_os = "windows"))]
    let parent_window_handle = 0usize;

    if parent_window_handle == 0 {
        return Err("HWND principale Baia non disponibile.".to_string());
    }
    let initial_fullscreen = main_window.is_fullscreen().unwrap_or(false);
    let title = clean_text(title, "Baia Cinghiala", 180);
    let meta = clean_meta(meta);
    let accent = clean_accent(accent);
    let start_seconds = start_seconds.filter(|value| value.is_finite() && *value >= 0.0).unwrap_or(0.0);
    let volume = volume.filter(|value| value.is_finite()).unwrap_or(100.0).clamp(0.0, 100.0);

    player.open(
        media_source,
        app,
        parent_window_handle,
        initial_fullscreen,
        title,
        meta,
        accent,
        start_seconds,
        volume,
    )?;

    Ok(NativePlayerLaunch {
        started: true,
        backend: BACKEND_NAME,
        ui: UI_NAME,
        media_source: "native_media_source",
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
    let _ = player.stop();
    player.shutdown_runtime();
    let _ = app.get_window(MAIN_WINDOW_LABEL).map(|window| window.set_focus());
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::{clean_accent, configured_value, parse_switch, BACKEND_NAME, UI_NAME};

    #[test]
    fn embedded_backend_is_explicitly_libmpv() {
        assert_eq!(BACKEND_NAME, "libmpv-baia-native-source");
        assert_eq!(UI_NAME, "baia-native-osc");
    }

    #[test]
    fn configured_value_uses_compiled_fallback() {
        let name = "BAIA_TEST_NATIVE_PLAYER_VALUE_SHOULD_NOT_EXIST";
        std::env::remove_var(name);
        assert_eq!(configured_value(name, Some("fallback")), Some("fallback".to_string()));
    }

    #[test]
    fn native_switch_accepts_explicit_on_and_off_values() {
        assert_eq!(parse_switch("true"), Some(true));
        assert_eq!(parse_switch("ON"), Some(true));
        assert_eq!(parse_switch("false"), Some(false));
        assert_eq!(parse_switch("0"), Some(false));
        assert_eq!(parse_switch("maybe"), None);
    }

    #[test]
    fn accent_is_bounded_to_hex_rgb() {
        assert_eq!(clean_accent(Some("#A1b2C3".into())), "#a1b2c3");
        assert_eq!(clean_accent(Some("red".into())), "#8f79ff");
    }
}
