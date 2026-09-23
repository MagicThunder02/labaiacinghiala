use crate::{core::CoreState, media_bridge::MediaBridge};
use serde::Serialize;
use std::{
    env,
    process::{Child, Command, Stdio},
    sync::Mutex,
};
use tauri::State;

const NATIVE_VIDEO_PLAYER_ENV: &str = "BAIA_NATIVE_VIDEO_PLAYER";
const MPV_EXECUTABLE_ENV: &str = "BAIA_MPV_EXECUTABLE";
const BACKEND_NAME: &str = "mpv-external-poc";

#[derive(Default)]
pub struct NativePlayerState {
    child: Mutex<Option<Child>>,
}

impl NativePlayerState {
    fn stop(&self) -> Result<bool, String> {
        let mut guard = self
            .child
            .lock()
            .map_err(|_| "Stato native player non disponibile.".to_string())?;
        let Some(mut child) = guard.take() else {
            return Ok(false);
        };

        match child.try_wait() {
            Ok(Some(_)) => Ok(false),
            Ok(None) => {
                child
                    .kill()
                    .map_err(|error| format!("Impossibile arrestare mpv: {error}"))?;
                let _ = child.wait();
                Ok(true)
            }
            Err(error) => Err(format!("Impossibile leggere lo stato di mpv: {error}")),
        }
    }

    fn replace(&self, mut child: Child) -> Result<(), String> {
        if let Err(error) = self.stop() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        let mut guard = match self.child.lock() {
            Ok(guard) => guard,
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Stato native player non disponibile.".to_string());
            }
        };
        *guard = Some(child);
        Ok(())
    }
}

impl Drop for NativePlayerState {
    fn drop(&mut self) {
        if let Ok(slot) = self.child.get_mut() {
            if let Some(child) = slot.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
            *slot = None;
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePlayerStatus {
    enabled: bool,
    available: bool,
    backend: &'static str,
    version: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePlayerLaunch {
    started: bool,
    backend: &'static str,
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

fn mpv_executable() -> String {
    configured_value(MPV_EXECUTABLE_ENV, option_env!("BAIA_MPV_EXECUTABLE"))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "mpv".to_string())
}

fn probe_mpv() -> Option<String> {
    let output = Command::new(mpv_executable())
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout)
        .ok()?
        .lines()
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
}

#[tauri::command]
pub fn baia_core_native_player_status() -> NativePlayerStatus {
    let enabled = native_player_enabled();
    let version = enabled.then(probe_mpv).flatten();
    NativePlayerStatus {
        enabled,
        available: version.is_some(),
        backend: BACKEND_NAME,
        version,
    }
}

#[tauri::command]
pub fn baia_core_native_player_open(
    movie_id: u64,
    core_state: State<'_, CoreState>,
    bridge: State<'_, MediaBridge>,
    player: State<'_, NativePlayerState>,
) -> Result<NativePlayerLaunch, String> {
    if !native_player_enabled() {
        return Err(format!(
            "Native player PoC disattivato. Imposta {NATIVE_VIDEO_PLAYER_ENV}=true solo per il test mpv."
        ));
    }
    if movie_id == 0 {
        return Err("movieId non valido per il native player.".to_string());
    }
    if probe_mpv().is_none() {
        return Err(format!(
            "mpv non disponibile. Installa mpv oppure configura {MPV_EXECUTABLE_ENV}."
        ));
    }

    // Il frontend passa soltanto l'identificatore logico. Autorizzazione, grant,
    // pin TLS e URL locale temporaneo restano interamente nel Core Rust.
    let media_url = bridge.register_movie_stream(movie_id, &core_state)?;

    // PoC Fase 1: processo esterno e finestra mpv separata. Gli argomenti sono
    // fissi; il JavaScript non puo' fornire URL, path o comandi mpv arbitrari.
    // stdout/stderr sono soppressi per evitare che l'URL locale firmato finisca
    // nei log del client.
    let child = Command::new(mpv_executable())
        .args([
            "--no-config",
            "--force-window=yes",
            "--keep-open=no",
            "--terminal=no",
            "--input-default-bindings=yes",
            "--cache=yes",
            "--",
        ])
        .arg(media_url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Impossibile avviare mpv: {error}"))?;

    player.replace(child)?;
    Ok(NativePlayerLaunch {
        started: true,
        backend: BACKEND_NAME,
    })
}

#[tauri::command]
pub fn baia_core_native_player_stop(
    player: State<'_, NativePlayerState>,
) -> Result<bool, String> {
    player.stop()
}

#[cfg(test)]
mod tests {
    use super::{configured_value, BACKEND_NAME};

    #[test]
    fn poc_backend_is_explicitly_external_mpv() {
        assert_eq!(BACKEND_NAME, "mpv-external-poc");
    }

    #[test]
    fn configured_value_uses_compiled_fallback() {
        let name = "BAIA_TEST_NATIVE_PLAYER_VALUE_SHOULD_NOT_EXIST";
        std::env::remove_var(name);
        assert_eq!(configured_value(name, Some("fallback")), Some("fallback".to_string()));
    }
}
