//! Aggiornamento del client Android.
//!
//! `tauri-plugin-updater` non sa installare nulla su mobile: la sua routine di
//! installazione è vuota. Qui il percorso è quindi esplicito e sta tutto in Rust:
//!
//! 1. si legge `latest-android.json` accanto al `latest.json` del desktop, sullo
//!    stesso endpoint configurato in `tauri.conf.json`;
//! 2. si confronta la versione remota con quella compilata nel binario;
//! 3. si scarica l'APK e si verifica la firma minisign con la **stessa** chiave
//!    pubblica del desktop, prima che il file tocchi il disco;
//! 4. si consegna l'APK verificato al package installer di sistema, che chiede
//!    conferma all'utente: nessun aggiornamento viene installato di nascosto.
//!
//! Nessun URL arriva dal frontend: endpoint e chiave vengono dalla configurazione.

use super::{UpdateInstallReport, UpdateProgress, UpdateStatus, CURRENT_VERSION};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use minisign_verify::{PublicKey, Signature};
use serde::Deserialize;
use std::{
    sync::{mpsc, Arc},
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, AppHandle, Manager};
use url::Url;

/// Manifesto Android, pubblicato dalla release accanto a `latest.json`.
const MANIFEST_FILE: &str = "latest-android.json";
const MANIFEST_TIMEOUT: Duration = Duration::from_secs(20);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
const MAX_MANIFEST_BYTES: usize = 64 * 1024;
/// Un APK del client sta ampiamente sotto questa soglia: oltre, la risposta non
/// è ciò che ci aspettiamo e viene interrotta invece di riempire la memoria.
const MAX_APK_BYTES: usize = 512 * 1024 * 1024;
const APK_FILE_NAME: &str = "baia-aggiornamento.apk";
const INSTALL_MIME: &str = "application/vnd.android.package-archive";
const FLAG_GRANT_READ_URI_PERMISSION: i32 = 0x0000_0001;
const FLAG_ACTIVITY_NEW_TASK: i32 = 0x1000_0000;

#[derive(Debug, Deserialize)]
struct AndroidRelease {
    version: String,
    #[serde(default)]
    notes: Option<String>,
    #[serde(default)]
    pub_date: Option<String>,
    url: String,
    signature: String,
}

/// Endpoint del manifesto Android e chiave pubblica, entrambi presi dalla
/// configurazione dell'updater: restano un'unica fonte per desktop e mobile.
fn updater_settings(app: &AppHandle) -> Result<(Url, String), String> {
    let updater = app
        .config()
        .plugins
        .0
        .get("updater")
        .ok_or("Configurazione dell'updater assente.")?;
    let endpoint = updater
        .get("endpoints")
        .and_then(|value| value.as_array())
        .and_then(|list| list.first())
        .and_then(|value| value.as_str())
        .ok_or("Endpoint degli aggiornamenti assente.")?;
    let public_key = updater
        .get("pubkey")
        .and_then(|value| value.as_str())
        .ok_or("Chiave pubblica degli aggiornamenti assente.")?;

    let manifest = Url::parse(endpoint)
        .map_err(|error| error.to_string())?
        .join(MANIFEST_FILE)
        .map_err(|error| error.to_string())?;
    if manifest.scheme() != "https" {
        return Err("Gli aggiornamenti si scaricano solo via HTTPS.".to_string());
    }
    Ok((manifest, public_key.to_string()))
}

/// Client HTTPS con radici incluse nel binario: su Android il verificatore di
/// piattaforma richiederebbe un componente Kotlin aggiuntivo, e questo client
/// parla solo con l'endpoint delle release.
fn https_client(timeout: Duration) -> Result<reqwest::Client, String> {
    let provider = rustls::crypto::aws_lc_rs::default_provider();
    let roots = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    let tls = rustls::ClientConfig::builder_with_provider(Arc::new(provider))
        .with_safe_default_protocol_versions()
        .map_err(|error| error.to_string())?
        .with_root_certificates(roots)
        .with_no_client_auth();

    reqwest::Client::builder()
        .use_preconfigured_tls(tls)
        .timeout(timeout)
        .build()
        .map_err(|error| error.to_string())
}

async fn fetch_release(app: &AppHandle) -> Result<(AndroidRelease, String), String> {
    let (manifest_url, public_key) = updater_settings(app)?;
    let response = https_client(MANIFEST_TIMEOUT)?
        .get(manifest_url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "Il server delle release ha risposto {}.",
            response.status().as_u16()
        ));
    }

    let body = response.bytes().await.map_err(|error| error.to_string())?;
    if body.len() > MAX_MANIFEST_BYTES {
        return Err("Manifesto degli aggiornamenti troppo grande.".to_string());
    }
    let release: AndroidRelease =
        serde_json::from_slice(&body).map_err(|error| error.to_string())?;

    // L'URL del pacchetto arriva da un manifesto remoto: deve restare HTTPS.
    let url = Url::parse(&release.url).map_err(|error| error.to_string())?;
    if url.scheme() != "https" {
        return Err("Il pacchetto di aggiornamento non è servito via HTTPS.".to_string());
    }
    Ok((release, public_key))
}

/// `true` quando la versione remota è successiva a quella installata.
fn is_newer(remote: &str, current: &str) -> Result<bool, String> {
    let remote = semver::Version::parse(remote.trim_start_matches('v'))
        .map_err(|error| format!("Versione remota non valida: {error}"))?;
    let current = semver::Version::parse(current)
        .map_err(|error| format!("Versione locale non valida: {error}"))?;
    Ok(remote > current)
}

fn verify_signature(data: &[u8], signature: &str, public_key: &str) -> Result<(), String> {
    let decode = |value: &str| -> Result<String, String> {
        let raw = STANDARD
            .decode(value)
            .map_err(|error| format!("Firma o chiave non decodificabili: {error}"))?;
        String::from_utf8(raw).map_err(|error| error.to_string())
    };
    let public_key =
        PublicKey::decode(&decode(public_key)?).map_err(|error| error.to_string())?;
    let signature = Signature::decode(&decode(signature)?).map_err(|error| error.to_string())?;
    public_key
        .verify(data, &signature, true)
        .map_err(|_| "Firma del pacchetto di aggiornamento non valida.".to_string())
}

async fn download_apk(
    url: &str,
    on_progress: &Channel<UpdateProgress>,
) -> Result<Vec<u8>, String> {
    let response = https_client(DOWNLOAD_TIMEOUT)?
        .get(url)
        .header(reqwest::header::ACCEPT, "application/octet-stream")
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "Download non riuscito: HTTP {}.",
            response.status().as_u16()
        ));
    }

    let total = response.content_length();
    if total.is_some_and(|value| value > MAX_APK_BYTES as u64) {
        return Err("Pacchetto di aggiornamento più grande del previsto.".to_string());
    }

    let mut response = response;
    let mut bytes: Vec<u8> = Vec::with_capacity(total.unwrap_or(0).min(64 * 1024 * 1024) as usize);
    let mut last_sent_at = Instant::now();
    let _ = on_progress.send(UpdateProgress {
        phase: "download",
        downloaded: 0,
        total,
    });

    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        if bytes.len() + chunk.len() > MAX_APK_BYTES {
            return Err("Pacchetto di aggiornamento più grande del previsto.".to_string());
        }
        bytes.extend_from_slice(&chunk);
        let now = Instant::now();
        if now.duration_since(last_sent_at) >= PROGRESS_INTERVAL {
            last_sent_at = now;
            let _ = on_progress.send(UpdateProgress {
                phase: "download",
                downloaded: bytes.len() as u64,
                total,
            });
        }
    }
    Ok(bytes)
}

/// Consegna l'APK verificato al package installer di sistema. L'installazione
/// vera la esegue Android dopo conferma esplicita dell'utente.
fn start_system_installer(app: &AppHandle, apk_path: &std::path::Path) -> Result<(), String> {
    let path = apk_path
        .to_str()
        .ok_or("Percorso del pacchetto non rappresentabile.")?
        .to_string();
    let window = app
        .get_webview_window("main")
        .ok_or("Finestra principale non disponibile.")?;

    // La chiamata JNI viene eseguita sul thread della WebView: aspettiamo il suo
    // esito per poter riportare un errore al posto di un silenzioso nulla di fatto.
    let (sender, receiver) = mpsc::channel::<Result<(), String>>();
    window
        .with_webview(move |webview| {
            webview.jni_handle().exec(move |env, activity, _webview| {
                let _ = sender.send(launch_install_intent(env, activity, &path));
            });
        })
        .map_err(|error| error.to_string())?;

    receiver
        .recv_timeout(Duration::from_secs(30))
        .map_err(|_| "Il sistema non ha risposto alla richiesta di installazione.".to_string())?
}

fn launch_install_intent(
    env: &mut jni::JNIEnv<'_>,
    activity: &jni::objects::JObject<'_>,
    apk_path: &str,
) -> Result<(), String> {
    use jni::objects::JValue;

    let jni_error = |context: &str| move |error: jni::errors::Error| format!("{context}: {error}");

    let package_name = env
        .call_method(activity, "getPackageName", "()Ljava/lang/String;", &[])
        .and_then(|value| value.l())
        .map_err(jni_error("nome del pacchetto non leggibile"))?;
    let package_name = jni::objects::JString::from(package_name);
    let package_name: String = env
        .get_string(&package_name)
        .map_err(jni_error("nome del pacchetto non convertibile"))?
        .into();

    let path = env
        .new_string(apk_path)
        .map_err(jni_error("percorso non convertibile"))?;
    let file = env
        .new_object(
            "java/io/File",
            "(Ljava/lang/String;)V",
            &[JValue::Object(&path)],
        )
        .map_err(jni_error("file non creabile"))?;

    // Il provider è già dichiarato nel manifest generato da Tauri: senza un
    // content URI Android rifiuta il file con FileUriExposedException.
    let authority = env
        .new_string(format!("{package_name}.fileprovider"))
        .map_err(jni_error("authority non convertibile"))?;
    let uri = env
        .call_static_method(
            "androidx/core/content/FileProvider",
            "getUriForFile",
            "(Landroid/content/Context;Ljava/lang/String;Ljava/io/File;)Landroid/net/Uri;",
            &[
                JValue::Object(activity),
                JValue::Object(&authority),
                JValue::Object(&file),
            ],
        )
        .and_then(|value| value.l())
        .map_err(jni_error("URI del pacchetto non ottenibile"))?;

    let action = env
        .new_string("android.intent.action.VIEW")
        .map_err(jni_error("azione non convertibile"))?;
    let intent = env
        .new_object(
            "android/content/Intent",
            "(Ljava/lang/String;)V",
            &[JValue::Object(&action)],
        )
        .map_err(jni_error("intent non creabile"))?;
    let mime = env
        .new_string(INSTALL_MIME)
        .map_err(jni_error("tipo MIME non convertibile"))?;
    env.call_method(
        &intent,
        "setDataAndType",
        "(Landroid/net/Uri;Ljava/lang/String;)Landroid/content/Intent;",
        &[JValue::Object(&uri), JValue::Object(&mime)],
    )
    .map_err(jni_error("intent non configurabile"))?;
    env.call_method(
        &intent,
        "addFlags",
        "(I)Landroid/content/Intent;",
        &[JValue::Int(
            FLAG_GRANT_READ_URI_PERMISSION | FLAG_ACTIVITY_NEW_TASK,
        )],
    )
    .map_err(jni_error("permessi dell'intent non impostabili"))?;

    env.call_method(
        activity,
        "startActivity",
        "(Landroid/content/Intent;)V",
        &[JValue::Object(&intent)],
    )
    .map_err(jni_error("installer di sistema non avviabile"))?;
    Ok(())
}

pub(super) async fn status(app: AppHandle) -> Result<UpdateStatus, String> {
    let (release, _) = fetch_release(&app).await?;
    if !is_newer(&release.version, CURRENT_VERSION)? {
        return Ok(UpdateStatus::up_to_date());
    }
    Ok(UpdateStatus::available(
        release.version,
        release.notes,
        release.pub_date,
    ))
}

pub(super) async fn install(
    app: AppHandle,
    on_progress: Channel<UpdateProgress>,
) -> Result<UpdateInstallReport, String> {
    let (release, public_key) = fetch_release(&app).await?;
    if !is_newer(&release.version, CURRENT_VERSION)? {
        return Err("Nessun aggiornamento disponibile per questo client.".to_string());
    }

    let bytes = download_apk(&release.url, &on_progress).await?;
    let _ = on_progress.send(UpdateProgress {
        phase: "install",
        downloaded: bytes.len() as u64,
        total: Some(bytes.len() as u64),
    });
    verify_signature(&bytes, &release.signature, &public_key)?;

    // La cache dell'app è l'unica directory già dichiarata nel FileProvider.
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Cache dell'app non disponibile: {error}"))?;
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let apk_path = directory.join(APK_FILE_NAME);
    std::fs::write(&apk_path, &bytes).map_err(|error| error.to_string())?;
    drop(bytes);

    start_system_installer(&app, &apk_path)?;
    Ok(UpdateInstallReport {
        installed_version: release.version,
        // Il riavvio lo decide Android al termine dell'installazione.
        restarting: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confronta_le_versioni_ignorando_la_v_iniziale() {
        assert!(is_newer("0.7.0", "0.6.0").unwrap());
        assert!(is_newer("v0.7.0", "0.6.0").unwrap());
        assert!(!is_newer("0.6.0", "0.6.0").unwrap());
        assert!(!is_newer("0.5.9", "0.6.0").unwrap());
        assert!(is_newer("1.0.0", "0.9.9").unwrap());
    }

    #[test]
    fn versioni_non_semver_sono_un_errore_esplicito() {
        assert!(is_newer("ultima", "0.6.0").is_err());
        assert!(is_newer("0.7", "0.6.0").is_err());
    }

    #[test]
    fn il_manifesto_richiede_url_e_firma() {
        let completo = serde_json::json!({
            "version": "0.7.0",
            "url": "https://example.invalid/app.apk",
            "signature": "firma"
        });
        assert!(serde_json::from_value::<AndroidRelease>(completo).is_ok());

        let senza_firma = serde_json::json!({
            "version": "0.7.0",
            "url": "https://example.invalid/app.apk"
        });
        assert!(serde_json::from_value::<AndroidRelease>(senza_firma).is_err());
    }

    #[test]
    fn una_firma_non_valida_viene_rifiutata() {
        let errore = verify_signature(b"dati", "non-base64!", "nemmeno-questa");
        assert!(errore.is_err());
    }
}
