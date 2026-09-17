//! Aggiornamento del client Baia.
//!
//! Il client scarica la release firmata pubblicata su GitHub e la installa da solo.
//! Il server Node non è coinvolto: quel deploy resta aggiornato a parte (git pull
//! pianificata sull'host), quindi qui non esiste alcun comando che tocchi l'host.
//!
//! Il bridge espone soltanto due comandi di dominio: stato e installazione. Non
//! esiste un IPC generico "scarica questo URL ed eseguilo": l'endpoint e la chiave
//! pubblica minisign arrivano da `tauri.conf.json` e la verifica della firma è fatta
//! dal plugin prima di installare qualunque byte.

use serde::Serialize;

/// Versione del client compilata nel binario: è il termine di paragone del confronto.
const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

#[allow(dead_code)]
const REASON_MOBILE: &str =
    "L'aggiornamento automatico non è disponibile su questa piattaforma: usa lo store di sistema.";
#[allow(dead_code)]
const REASON_LINUX_PACKAGE: &str =
    "Client installato da pacchetto di sistema (deb o Flatpak): aggiornalo con il gestore pacchetti.";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    /// `false` quando l'installazione corrente non può aggiornarsi da sola.
    supported: bool,
    available: bool,
    current_version: String,
    latest_version: Option<String>,
    notes: Option<String>,
    published_at: Option<String>,
    unsupported_reason: Option<String>,
}

impl UpdateStatus {
    fn unsupported(reason: &str) -> Self {
        Self {
            supported: false,
            available: false,
            current_version: CURRENT_VERSION.to_string(),
            latest_version: None,
            notes: None,
            published_at: None,
            unsupported_reason: Some(reason.to_string()),
        }
    }

    fn up_to_date() -> Self {
        Self {
            supported: true,
            available: false,
            current_version: CURRENT_VERSION.to_string(),
            latest_version: None,
            notes: None,
            published_at: None,
            unsupported_reason: None,
        }
    }

    fn available(version: String, notes: Option<String>, published_at: Option<String>) -> Self {
        Self {
            supported: true,
            available: true,
            current_version: CURRENT_VERSION.to_string(),
            latest_version: Some(version),
            notes: notes.map(|value| truncate_notes(&value)),
            published_at,
            unsupported_reason: None,
        }
    }
}

/// Avanzamento inviato al frontend durante l'installazione.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    /// `download`, `install` oppure `restart`.
    phase: &'static str,
    downloaded: u64,
    total: Option<u64>,
}

/// Esito restituito quando l'installazione è andata a buon fine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInstallReport {
    installed_version: String,
    /// `true` quando l'app viene riavviata subito dal Core o dall'installer.
    restarting: bool,
}

const MAX_NOTES_CHARS: usize = 2_000;

/// Le note della release sono testo remoto: entrano nella UI solo come testo e
/// con una lunghezza massima, senza mai essere interpretate come markup.
fn truncate_notes(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= MAX_NOTES_CHARS {
        return trimmed.to_string();
    }
    let mut notes: String = trimmed.chars().take(MAX_NOTES_CHARS).collect();
    notes.push('…');
    notes
}

#[cfg(desktop)]
mod platform {
    use super::{UpdateInstallReport, UpdateProgress, UpdateStatus, REASON_LINUX_PACKAGE};
    use std::{
        sync::{Arc, Mutex},
        time::{Duration, Instant},
    };
    use tauri::{ipc::Channel, AppHandle, Manager};
    use tauri_plugin_updater::UpdaterExt;

    const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

    struct DownloadProgress {
        downloaded: u64,
        total: Option<u64>,
        last_sent_at: Instant,
    }

    /// Alcune installazioni non possono sostituire i propri file: su Linux il
    /// plugin aggiorna soltanto l'AppImage, mentre deb e Flatpak sono gestiti dal
    /// sistema. Meglio dirlo prima di scaricare qualsiasi cosa.
    fn unsupported_reason(app: &AppHandle) -> Option<&'static str> {
        #[cfg(target_os = "linux")]
        {
            if app.env().appimage.is_none() {
                return Some(REASON_LINUX_PACKAGE);
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = app;
        }
        None
    }

    fn published_at(update: &tauri_plugin_updater::Update) -> Option<String> {
        update
            .raw_json
            .get("pub_date")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string())
    }

    pub(super) async fn status(app: AppHandle) -> Result<UpdateStatus, String> {
        if let Some(reason) = unsupported_reason(&app) {
            return Ok(UpdateStatus::unsupported(reason));
        }

        let updater = app.updater().map_err(|error| error.to_string())?;
        match updater.check().await.map_err(|error| error.to_string())? {
            Some(update) => Ok(UpdateStatus::available(
                update.version.clone(),
                update.body.clone(),
                published_at(&update),
            )),
            None => Ok(UpdateStatus::up_to_date()),
        }
    }

    pub(super) async fn install(
        app: AppHandle,
        on_progress: Channel<UpdateProgress>,
    ) -> Result<UpdateInstallReport, String> {
        if let Some(reason) = unsupported_reason(&app) {
            return Err(reason.to_string());
        }

        let updater = app.updater().map_err(|error| error.to_string())?;
        let update = updater
            .check()
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "Nessun aggiornamento disponibile per questo client.".to_string())?;

        let version = update.version.clone();
        let _ = on_progress.send(UpdateProgress {
            phase: "download",
            downloaded: 0,
            total: None,
        });

        let progress = Arc::new(Mutex::new(DownloadProgress {
            downloaded: 0,
            total: None,
            last_sent_at: Instant::now(),
        }));
        let chunk_progress = Arc::clone(&progress);
        let chunk_channel = on_progress.clone();
        let finish_channel = on_progress.clone();
        let finish_progress = Arc::clone(&progress);

        update
            .download_and_install(
                move |chunk, total| {
                    let Ok(mut state) = chunk_progress.lock() else {
                        return;
                    };
                    state.downloaded = state.downloaded.saturating_add(chunk as u64);
                    state.total = total;
                    let now = Instant::now();
                    if total.is_some_and(|value| state.downloaded >= value)
                        || now.duration_since(state.last_sent_at) >= PROGRESS_INTERVAL
                    {
                        state.last_sent_at = now;
                        let _ = chunk_channel.send(UpdateProgress {
                            phase: "download",
                            downloaded: state.downloaded,
                            total: state.total,
                        });
                    }
                },
                move || {
                    let (downloaded, total) = finish_progress
                        .lock()
                        .map(|state| (state.downloaded, state.total))
                        .unwrap_or((0, None));
                    let _ = finish_channel.send(UpdateProgress {
                        phase: "install",
                        downloaded,
                        total,
                    });
                },
            )
            .await
            .map_err(|error| error.to_string())?;

        let _ = on_progress.send(UpdateProgress {
            phase: "restart",
            downloaded: 0,
            total: None,
        });

        // Su Windows l'installer NSIS in modalità passive chiude e riavvia l'app da
        // solo: se arriviamo qui il processo sta già uscendo. Su macOS e AppImage il
        // riavvio spetta a noi.
        #[cfg(target_os = "windows")]
        {
            let _ = &app;
            Ok(UpdateInstallReport {
                installed_version: version,
                restarting: true,
            })
        }

        #[cfg(not(target_os = "windows"))]
        {
            let _ = version;
            app.restart();
        }
    }
}

#[cfg(mobile)]
mod platform {
    use super::{UpdateInstallReport, UpdateProgress, UpdateStatus, REASON_MOBILE};
    use tauri::{ipc::Channel, AppHandle};

    pub(super) async fn status(_app: AppHandle) -> Result<UpdateStatus, String> {
        Ok(UpdateStatus::unsupported(REASON_MOBILE))
    }

    pub(super) async fn install(
        _app: AppHandle,
        _on_progress: Channel<UpdateProgress>,
    ) -> Result<UpdateInstallReport, String> {
        Err(REASON_MOBILE.to_string())
    }
}

/// Stato dell'aggiornamento: legge l'endpoint delle release e confronta le versioni.
#[tauri::command]
pub async fn baia_core_update_status(app: tauri::AppHandle) -> Result<UpdateStatus, String> {
    platform::status(app).await
}

/// Scarica la release firmata, la installa e riavvia il client.
#[tauri::command]
pub async fn baia_core_update_install(
    app: tauri::AppHandle,
    on_progress: tauri::ipc::Channel<UpdateProgress>,
) -> Result<UpdateInstallReport, String> {
    platform::install(app, on_progress).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stato_non_supportato_non_annuncia_versioni() {
        let status = UpdateStatus::unsupported(REASON_LINUX_PACKAGE);
        assert!(!status.supported);
        assert!(!status.available);
        assert_eq!(status.latest_version, None);
        assert_eq!(
            status.unsupported_reason.as_deref(),
            Some(REASON_LINUX_PACKAGE)
        );
        assert_eq!(status.current_version, CURRENT_VERSION);
    }

    #[test]
    fn stato_allineato_non_espone_motivi() {
        let status = UpdateStatus::up_to_date();
        assert!(status.supported);
        assert!(!status.available);
        assert_eq!(status.unsupported_reason, None);
        assert_eq!(status.notes, None);
    }

    #[test]
    fn stato_disponibile_riporta_versione_e_note() {
        let status = UpdateStatus::available(
            "0.6.0".to_string(),
            Some("  Correzioni varie  ".to_string()),
            Some("2026-09-18T10:00:00Z".to_string()),
        );
        assert!(status.supported);
        assert!(status.available);
        assert_eq!(status.latest_version.as_deref(), Some("0.6.0"));
        assert_eq!(status.notes.as_deref(), Some("Correzioni varie"));
        assert_eq!(
            status.published_at.as_deref(),
            Some("2026-09-18T10:00:00Z")
        );
    }

    #[test]
    fn note_remote_troppo_lunghe_vengono_troncate() {
        let notes = "à".repeat(MAX_NOTES_CHARS + 500);
        let truncated = truncate_notes(&notes);
        assert_eq!(truncated.chars().count(), MAX_NOTES_CHARS + 1);
        assert!(truncated.ends_with('…'));
    }

    #[test]
    fn stato_serializza_in_camel_case_per_il_frontend() {
        let status = UpdateStatus::available("0.6.0".to_string(), None, None);
        let json = serde_json::to_value(&status).expect("serializzazione stato aggiornamento");
        assert_eq!(json["currentVersion"], CURRENT_VERSION);
        assert_eq!(json["latestVersion"], "0.6.0");
        assert_eq!(json["unsupportedReason"], serde_json::Value::Null);
    }

    #[test]
    fn avanzamento_serializza_le_fasi_note() {
        let progress = UpdateProgress {
            phase: "download",
            downloaded: 10,
            total: Some(100),
        };
        let json = serde_json::to_value(&progress).expect("serializzazione avanzamento");
        assert_eq!(json["phase"], "download");
        assert_eq!(json["downloaded"], 10);
        assert_eq!(json["total"], 100);
    }
}
