use crate::{core::CoreState, media_bridge::MediaBridge};
use jni::objects::{JObject, JString, JValue};
use serde::{Deserialize, Serialize};
use std::{sync::mpsc, time::Duration};
use tauri::{AppHandle, Manager, State};

const BACKEND_NAME: &str = "libmpv-android-surface";
const UI_NAME: &str = "baia-android-native-overlay";
const MEDIA_SOURCE_NAME: &str = "media_bridge";
const ANDROID_MPV_BUILD: &str = "mpv-android-2026-09-17-arm64-v8a";
const MAIN_WINDOW_LABEL: &str = "main";
const JNI_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Default)]
pub struct NativePlayerState;

pub fn initialize(_app: &mut tauri::App) -> Result<NativePlayerState, String> {
    Ok(NativePlayerState)
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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
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
    ui_close_requested: bool,
    source: Option<serde_json::Value>,
}

enum AndroidCall {
    Probe,
    Open {
        url: String,
        title: String,
        meta: String,
        accent: String,
        start_seconds: f64,
        volume: f64,
    },
    Play,
    Pause,
    Seek(f64),
    SetVolume(f64),
    GetState,
    Stop,
}

enum AndroidCallResult {
    String(String),
    Bool(bool),
    Void,
}

fn jni_error(env: &mut jni::JNIEnv<'_>, context: &str, error: impl std::fmt::Display) -> String {
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_describe();
        let _ = env.exception_clear();
    }
    format!("{context}: {error}")
}

fn java_string(
    env: &mut jni::JNIEnv<'_>,
    value: jni::objects::JValueOwned<'_>,
    context: &str,
) -> Result<String, String> {
    let object = value
        .l()
        .map_err(|error| jni_error(env, context, error))?;
    if object.is_null() {
        return Err(format!("{context}: risultato Java nullo."));
    }
    let string = JString::from(object);
    env.get_string(&string)
        .map(|value| value.into())
        .map_err(|error| jni_error(env, context, error))
}

fn call_android(app: &AppHandle, call: AndroidCall) -> Result<AndroidCallResult, String> {
    let window = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "WebView principale Android non disponibile.".to_string())?;
    let (sender, receiver) = mpsc::sync_channel(1);

    window
        .with_webview(move |webview| {
            webview.jni_handle().exec(move |env, activity, _webview| {
                let result = match call {
                    AndroidCall::Probe => env
                        .call_method(
                            activity,
                            "baiaNativePlayerProbe",
                            "()Ljava/lang/String;",
                            &[],
                        )
                        .map_err(|error| jni_error(env, "Probe libmpv Android fallito", error))
                        .and_then(|value| java_string(env, value, "Probe libmpv Android fallito"))
                        .map(AndroidCallResult::String),
                    AndroidCall::Open {
                        url,
                        title,
                        meta,
                        accent,
                        start_seconds,
                        volume,
                    } => {
                        let url = env.new_string(url).map(JObject::from);
                        let title = env.new_string(title).map(JObject::from);
                        let meta = env.new_string(meta).map(JObject::from);
                        let accent = env.new_string(accent).map(JObject::from);
                        match (url, title, meta, accent) {
                            (Ok(url), Ok(title), Ok(meta), Ok(accent)) => env
                                .call_method(
                                    activity,
                                    "baiaNativePlayerOpen",
                                    "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;DD)Z",
                                    &[
                                        JValue::Object(&url),
                                        JValue::Object(&title),
                                        JValue::Object(&meta),
                                        JValue::Object(&accent),
                                        JValue::Double(start_seconds),
                                        JValue::Double(volume),
                                    ],
                                )
                                .map_err(|error| {
                                    jni_error(env, "Apertura player Android fallita", error)
                                })
                                .and_then(|value| {
                                    value
                                        .z()
                                        .map(AndroidCallResult::Bool)
                                        .map_err(|error| {
                                            jni_error(
                                                env,
                                                "Risposta apertura player Android non valida",
                                                error,
                                            )
                                        })
                                }),
                            _ => Err("Impossibile convertire i parametri del player Android in stringhe JNI.".to_string()),
                        }
                    }
                    AndroidCall::Play => env
                        .call_method(activity, "baiaNativePlayerPlay", "()V", &[])
                        .map(|_| AndroidCallResult::Void)
                        .map_err(|error| jni_error(env, "Play Android fallito", error)),
                    AndroidCall::Pause => env
                        .call_method(activity, "baiaNativePlayerPause", "()V", &[])
                        .map(|_| AndroidCallResult::Void)
                        .map_err(|error| jni_error(env, "Pausa Android fallita", error)),
                    AndroidCall::Seek(seconds) => env
                        .call_method(
                            activity,
                            "baiaNativePlayerSeek",
                            "(D)V",
                            &[JValue::Double(seconds)],
                        )
                        .map(|_| AndroidCallResult::Void)
                        .map_err(|error| jni_error(env, "Seek Android fallito", error)),
                    AndroidCall::SetVolume(value) => env
                        .call_method(
                            activity,
                            "baiaNativePlayerSetVolume",
                            "(D)V",
                            &[JValue::Double(value)],
                        )
                        .map(|_| AndroidCallResult::Void)
                        .map_err(|error| jni_error(env, "Volume Android fallito", error)),
                    AndroidCall::GetState => env
                        .call_method(
                            activity,
                            "baiaNativePlayerGetState",
                            "()Ljava/lang/String;",
                            &[],
                        )
                        .map_err(|error| jni_error(env, "Stato player Android non disponibile", error))
                        .and_then(|value| {
                            java_string(env, value, "Stato player Android non disponibile")
                        })
                        .map(AndroidCallResult::String),
                    AndroidCall::Stop => env
                        .call_method(activity, "baiaNativePlayerStop", "()Z", &[])
                        .map_err(|error| jni_error(env, "Stop Android fallito", error))
                        .and_then(|value| {
                            value
                                .z()
                                .map(AndroidCallResult::Bool)
                                .map_err(|error| jni_error(env, "Risposta stop Android non valida", error))
                        }),
                };
                let _ = sender.send(result);
            });
        })
        .map_err(|error| format!("Impossibile accedere alla WebView Android: {error}"))?;

    receiver
        .recv_timeout(JNI_TIMEOUT)
        .map_err(|_| "Timeout durante la comunicazione con il player nativo Android.".to_string())?
}

fn clean_text(value: Option<String>, fallback: &str, max_chars: usize) -> String {
    let value = value.unwrap_or_default();
    let cleaned: String = value
        .chars()
        .filter(|character| !character.is_control())
        .take(max_chars)
        .collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        fallback.to_string()
    } else {
        cleaned.to_string()
    }
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

#[tauri::command]
pub fn baia_core_native_player_status() -> NativePlayerStatus {
    // Il vero load delle .so viene verificato al primo open, dove Kotlin può
    // restituire un errore senza toccare il percorso Windows. Qui segnaliamo la
    // capability compilata nell'APK, così il frontend tenta il backend nativo.
    NativePlayerStatus {
        enabled: true,
        available: true,
        backend: BACKEND_NAME,
        ui: UI_NAME,
        media_source: MEDIA_SOURCE_NAME,
        version: Some(ANDROID_MPV_BUILD.to_string()),
        detail: None,
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
    media_bridge: State<'_, MediaBridge>,
) -> Result<NativePlayerLaunch, String> {
    if movie_id == 0 {
        return Err("movieId non valido per il native player Android.".to_string());
    }

    let stream_url = media_bridge.register_movie_stream(movie_id, &core_state)?;
    let title = clean_text(title, "Baia Cinghiala", 180);
    let meta = clean_text(meta, "", 220);
    let accent = clean_accent(accent);
    let start_seconds = start_seconds
        .filter(|value| value.is_finite() && *value >= 0.0)
        .unwrap_or(0.0);
    let volume = volume
        .filter(|value| value.is_finite())
        .unwrap_or(70.0)
        .clamp(0.0, 100.0);

    match call_android(
        &app,
        AndroidCall::Open {
            url: stream_url,
            title,
            meta,
            accent,
            start_seconds,
            volume,
        },
    )? {
        AndroidCallResult::Bool(true) => Ok(NativePlayerLaunch {
            started: true,
            backend: BACKEND_NAME,
            ui: UI_NAME,
            media_source: MEDIA_SOURCE_NAME,
        }),
        AndroidCallResult::Bool(false) => {
            let detail = match call_android(&app, AndroidCall::Probe) {
                Ok(AndroidCallResult::String(value)) => value,
                _ => "libmpv Android non ha accettato l'apertura.".to_string(),
            };
            Err(detail)
        }
        _ => Err("Risposta inattesa dal player nativo Android.".to_string()),
    }
}

#[tauri::command]
pub async fn baia_core_native_player_play(app: AppHandle) -> Result<(), String> {
    match call_android(&app, AndroidCall::Play)? {
        AndroidCallResult::Void => Ok(()),
        _ => Err("Risposta inattesa al comando play Android.".to_string()),
    }
}

#[tauri::command]
pub async fn baia_core_native_player_pause(app: AppHandle) -> Result<(), String> {
    match call_android(&app, AndroidCall::Pause)? {
        AndroidCallResult::Void => Ok(()),
        _ => Err("Risposta inattesa al comando pausa Android.".to_string()),
    }
}

#[tauri::command]
pub async fn baia_core_native_player_seek(seconds: f64, app: AppHandle) -> Result<(), String> {
    if !seconds.is_finite() || seconds < 0.0 {
        return Err("Posizione seek Android non valida.".to_string());
    }
    match call_android(&app, AndroidCall::Seek(seconds))? {
        AndroidCallResult::Void => Ok(()),
        _ => Err("Risposta inattesa al comando seek Android.".to_string()),
    }
}

#[tauri::command]
pub async fn baia_core_native_player_set_volume(
    value: f64,
    app: AppHandle,
) -> Result<(), String> {
    if !value.is_finite() {
        return Err("Volume Android non valido.".to_string());
    }
    match call_android(&app, AndroidCall::SetVolume(value.clamp(0.0, 100.0)))? {
        AndroidCallResult::Void => Ok(()),
        _ => Err("Risposta inattesa al comando volume Android.".to_string()),
    }
}

#[tauri::command]
pub async fn baia_core_native_player_get_state(
    app: AppHandle,
) -> Result<NativePlaybackState, String> {
    match call_android(&app, AndroidCall::GetState)? {
        AndroidCallResult::String(json) => serde_json::from_str(&json)
            .map_err(|error| format!("Stato JSON del player Android non valido: {error}")),
        _ => Err("Risposta inattesa allo stato del player Android.".to_string()),
    }
}

#[tauri::command]
pub async fn baia_core_native_player_stop(app: AppHandle) -> Result<bool, String> {
    match call_android(&app, AndroidCall::Stop)? {
        AndroidCallResult::Bool(value) => Ok(value),
        _ => Err("Risposta inattesa allo stop Android.".to_string()),
    }
}
