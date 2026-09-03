use crate::{
    auth,
    connector_tls,
    core::CoreState,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use reqwest::blocking::multipart;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{self, Read},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, AppHandle, State};
#[cfg(target_os = "android")]
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
#[cfg(target_os = "android")]
use tauri_plugin_fs::{FsExt, OpenOptions};
use uuid::Uuid;

const MAX_SELECTION_AGE: Duration = Duration::from_secs(60 * 60);
const MAX_POSTER_BYTES: u64 = 6 * 1024 * 1024;
const MAX_MULTI_FILES: usize = 100;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
const MAX_RESPONSE_BYTES: u64 = 1024 * 1024;
const CONNECTOR_PROTOCOL_VERSION: u16 = 1;

const VIDEO_EXTENSIONS: &[&str] = &["mp4", "m4v", "webm", "mov", "mkv", "avi", "mpeg", "mpg", "ogv"];
const MUSIC_EXTENSIONS: &[&str] = &["mp3", "flac", "wav"];
const POSTER_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp", "avif"];
const BOOK_EXTENSIONS: &[&str] = &["pdf", "epub"];
const COMIC_EXTENSIONS: &[&str] = &["pdf", "cbz"];

#[derive(Clone, Debug)]
struct SelectedFile {
    role: String,
    category: Option<String>,
    path: PathBuf,
    name: String,
    size: u64,
    created_at: Instant,
    temporary: bool,
}

#[derive(Default)]
pub struct NativeUploadState {
    selections: Mutex<HashMap<String, SelectedFile>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeUploadSelection {
    token: String,
    role: String,
    name: String,
    size: u64,
    preview_data_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeUploadFiles {
    #[serde(default)]
    video: Option<String>,
    #[serde(default)]
    videos: Vec<String>,
    #[serde(default)]
    document: Option<String>,
    #[serde(default)]
    audio: Vec<String>,
    #[serde(default)]
    poster: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeUploadRequest {
    kind: String,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    fields: HashMap<String, String>,
    files: NativeUploadFiles,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeUploadProgress {
    phase: &'static str,
    loaded: u64,
    total: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeUploadResponse {
    status: u16,
    ok: bool,
    payload: Value,
}

struct PickerSpec {
    title: &'static str,
    extensions: &'static [&'static str],
    multiple: bool,
    max_count: usize,
    category: Option<String>,
}

#[derive(Clone)]
struct UploadPlan {
    endpoint_path: String,
    fields: Vec<(String, String)>,
    files: Vec<(String, SelectedFile)>,
    used_tokens: Vec<String>,
}

struct ProgressState {
    loaded: u64,
    total: u64,
    last_sent_at: Instant,
}

struct ProgressReader<R> {
    inner: R,
    progress: Arc<Mutex<ProgressState>>,
    channel: Channel<NativeUploadProgress>,
}

impl<R: Read> Read for ProgressReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let count = self.inner.read(buffer)?;
        if count == 0 {
            return Ok(0);
        }

        if let Ok(mut progress) = self.progress.lock() {
            progress.loaded = progress.loaded.saturating_add(count as u64).min(progress.total);
            let now = Instant::now();
            if progress.loaded >= progress.total
                || now.duration_since(progress.last_sent_at) >= PROGRESS_INTERVAL
            {
                progress.last_sent_at = now;
                let _ = self.channel.send(NativeUploadProgress {
                    phase: "uploading",
                    loaded: progress.loaded,
                    total: progress.total,
                });
            }
        }
        Ok(count)
    }
}

fn cleanup_selected_file(item: &SelectedFile) {
    if item.temporary {
        let _ = fs::remove_file(&item.path);
    }
}

impl NativeUploadState {
    fn cleanup_stale(&self) -> Result<(), String> {
        let mut selections = self
            .selections
            .lock()
            .map_err(|_| "Selezioni upload native non disponibili.".to_string())?;
        selections.retain(|_, item| {
            let keep = item.created_at.elapsed() <= MAX_SELECTION_AGE;
            if !keep {
                cleanup_selected_file(item);
            }
            keep
        });
        Ok(())
    }

    fn insert(&self, item: SelectedFile) -> Result<String, String> {
        self.cleanup_stale()?;
        let token = Uuid::new_v4().to_string();
        self.selections
            .lock()
            .map_err(|_| "Selezioni upload native non disponibili.".to_string())?
            .insert(token.clone(), item);
        Ok(token)
    }

    fn get(&self, token: &str) -> Result<SelectedFile, String> {
        self.cleanup_stale()?;
        self.selections
            .lock()
            .map_err(|_| "Selezioni upload native non disponibili.".to_string())?
            .get(token)
            .cloned()
            .ok_or_else(|| "La selezione del file è scaduta. Seleziona nuovamente il file.".to_string())
    }

    fn release(&self, tokens: &[String]) -> Result<(), String> {
        let mut selections = self
            .selections
            .lock()
            .map_err(|_| "Selezioni upload native non disponibili.".to_string())?;
        for token in tokens {
            if let Some(item) = selections.remove(token) {
                cleanup_selected_file(&item);
            }
        }
        Ok(())
    }
}

fn normalized_category(value: Option<&str>) -> Result<Option<String>, String> {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        None => Ok(None),
        Some(value @ ("books" | "comics" | "manga")) => Ok(Some(value.to_string())),
        Some(_) => Err("Categoria di lettura non valida.".to_string()),
    }
}

fn picker_spec(role: &str, category: Option<&str>) -> Result<PickerSpec, String> {
    match role.trim() {
        "movie-video" => Ok(PickerSpec {
            title: "Seleziona il film",
            extensions: VIDEO_EXTENSIONS,
            multiple: false,
            max_count: 1,
            category: None,
        }),
        "series-videos" => Ok(PickerSpec {
            title: "Seleziona gli episodi",
            extensions: VIDEO_EXTENSIONS,
            multiple: true,
            max_count: MAX_MULTI_FILES,
            category: None,
        }),
        "music-audio" => Ok(PickerSpec {
            title: "Seleziona i brani",
            extensions: MUSIC_EXTENSIONS,
            multiple: true,
            max_count: MAX_MULTI_FILES,
            category: None,
        }),
        "poster" => Ok(PickerSpec {
            title: "Seleziona la copertina",
            extensions: POSTER_EXTENSIONS,
            multiple: false,
            max_count: 1,
            category: None,
        }),
        "reading-document" => {
            let category = normalized_category(category)?
                .ok_or_else(|| "Categoria di lettura richiesta.".to_string())?;
            let extensions = if category == "books" {
                BOOK_EXTENSIONS
            } else {
                COMIC_EXTENSIONS
            };
            Ok(PickerSpec {
                title: "Seleziona il file di lettura",
                extensions,
                multiple: false,
                max_count: 1,
                category: Some(category),
            })
        }
        _ => Err("Tipo di selezione upload non consentito.".to_string()),
    }
}

fn extension_of(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default()
}

fn extension_allowed(path: &Path, allowed: &[&str]) -> bool {
    let extension = extension_of(path);
    allowed.iter().any(|candidate| extension == *candidate)
}

fn mime_for_path(path: &Path) -> &'static str {
    match extension_of(path).as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "mp3" => "audio/mpeg",
        "flac" => "audio/flac",
        "wav" => "audio/wav",
        "pdf" => "application/pdf",
        "epub" => "application/epub+zip",
        "cbz" => "application/vnd.comicbook+zip",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mpeg" | "mpg" => "video/mpeg",
        "ogv" => "video/ogg",
        _ => "application/octet-stream",
    }
}

fn poster_preview(path: &Path, size: u64) -> Result<Option<String>, String> {
    if size > MAX_POSTER_BYTES {
        return Err("La copertina deve avere dimensione massima di 6 MB.".to_string());
    }
    let contents = fs::read(path)
        .map_err(|error| format!("Impossibile leggere la copertina selezionata: {error}"))?;
    Ok(Some(format!(
        "data:{};base64,{}",
        mime_for_path(path),
        STANDARD.encode(contents)
    )))
}

fn prepare_selected_file(
    state: &NativeUploadState,
    role: &str,
    category: Option<String>,
    path: PathBuf,
    allowed_extensions: &[&str],
    name_override: Option<String>,
    temporary: bool,
) -> Result<NativeUploadSelection, String> {
    let path = fs::canonicalize(path)
        .map_err(|error| format!("Impossibile accedere al file selezionato: {error}"))?;
    let metadata = fs::metadata(&path)
        .map_err(|error| format!("Impossibile leggere i dati del file selezionato: {error}"))?;
    if !metadata.is_file() {
        return Err("La selezione non è un file valido.".to_string());
    }
    if metadata.len() == 0 {
        return Err("Il file selezionato è vuoto.".to_string());
    }
    let name = match name_override {
        Some(value) => value,
        None => path
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "Nome del file selezionato non valido.".to_string())?,
    };
    if name.trim().is_empty() {
        return Err("Nome del file selezionato non valido.".to_string());
    }
    if !extension_allowed(Path::new(&name), allowed_extensions) {
        return Err("Formato del file non supportato per questo upload.".to_string());
    }
    let size = metadata.len();
    let preview_data_url = if role == "poster" {
        poster_preview(&path, size)?
    } else {
        None
    };
    let token = state.insert(SelectedFile {
        role: role.to_string(),
        category,
        path,
        name: name.clone(),
        size,
        created_at: Instant::now(),
        temporary,
    })?;

    Ok(NativeUploadSelection {
        token,
        role: role.to_string(),
        name,
        size,
        preview_data_url,
    })
}

#[cfg(target_os = "android")]
fn prepare_android_selected_file(
    app: &AppHandle,
    state: &NativeUploadState,
    role: &str,
    category: Option<String>,
    file_path: tauri_plugin_dialog::FilePath,
    allowed_extensions: &[&str],
) -> Result<NativeUploadSelection, String> {
    let display_path = file_path.to_string();
    let name = app
        .path()
        .file_name(&display_path)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Nome del file selezionato non valido.".to_string())?;
    if !extension_allowed(Path::new(&name), allowed_extensions) {
        return Err("Formato del file non supportato per questo upload.".to_string());
    }

    let extension = extension_of(Path::new(&name));
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Impossibile individuare la cache privata dell’app: {error}"))?
        .join("native-upload");
    fs::create_dir_all(&cache_dir)
        .map_err(|error| format!("Impossibile preparare la cache upload privata: {error}"))?;
    let temp_path = cache_dir.join(format!("{}.{}", Uuid::new_v4(), extension));

    let mut options = OpenOptions::new();
    options.read(true);
    let mut source = app
        .fs()
        .open(file_path, options)
        .map_err(|error| format!("Impossibile leggere il file selezionato da Android: {error}"))?;
    let mut destination = File::create(&temp_path)
        .map_err(|error| format!("Impossibile creare la copia temporanea del file selezionato: {error}"))?;

    if let Err(error) = io::copy(&mut source, &mut destination) {
        let _ = fs::remove_file(&temp_path);
        return Err(format!(
            "Impossibile copiare il file selezionato nella cache privata dell’app: {error}"
        ));
    }
    drop(destination);

    let result = prepare_selected_file(
        state,
        role,
        category,
        temp_path.clone(),
        allowed_extensions,
        Some(name),
        true,
    );
    if result.is_err() {
        let _ = fs::remove_file(temp_path);
    }
    result
}

fn validate_field_value(name: &str, value: &str) -> Result<(), String> {
    if value.len() > 64 * 1024 {
        return Err(format!("Il campo {name} supera la dimensione consentita."));
    }
    Ok(())
}

fn collect_fields(
    fields: &HashMap<String, String>,
    allowed: &[&str],
    required: &[&str],
) -> Result<Vec<(String, String)>, String> {
    let allowed_set: HashSet<&str> = allowed.iter().copied().collect();
    for key in fields.keys() {
        if !allowed_set.contains(key.as_str()) {
            return Err(format!("Campo upload non consentito: {key}."));
        }
    }
    for key in required {
        if fields.get(*key).map(|value| value.trim()).unwrap_or_default().is_empty() {
            return Err(format!("Campo upload obbligatorio mancante: {key}."));
        }
    }

    let mut result = Vec::with_capacity(fields.len());
    for key in allowed {
        if let Some(value) = fields.get(*key) {
            validate_field_value(key, value)?;
            result.push(((*key).to_string(), value.clone()));
        }
    }
    Ok(result)
}

fn selection_for_token(
    state: &NativeUploadState,
    token: &str,
    expected_role: &str,
    expected_category: Option<&str>,
) -> Result<SelectedFile, String> {
    let selection = state.get(token)?;
    if selection.role != expected_role {
        return Err("Il file selezionato non è valido per questo tipo di upload.".to_string());
    }
    if selection.category.as_deref() != expected_category {
        return Err("Il file selezionato appartiene a una categoria diversa.".to_string());
    }
    Ok(selection)
}

fn single_token(value: &Option<String>, label: &str) -> Result<String, String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| format!("Seleziona {label}."))
}

fn optional_selection(
    state: &NativeUploadState,
    token: &Option<String>,
    role: &str,
) -> Result<Option<(String, SelectedFile)>, String> {
    match token.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        Some(token) => Ok(Some((
            token.to_string(),
            selection_for_token(state, token, role, None)?,
        ))),
        None => Ok(None),
    }
}

fn upload_plan(state: &NativeUploadState, request: &NativeUploadRequest) -> Result<UploadPlan, String> {
    let kind = request.kind.trim();
    let mut used_tokens = Vec::new();
    let mut files = Vec::new();

    let (endpoint_path, fields) = match kind {
        "movie" => {
            let video_token = single_token(&request.files.video, "il film")?;
            let poster_token = single_token(&request.files.poster, "la copertina")?;
            let video = selection_for_token(state, &video_token, "movie-video", None)?;
            let poster = selection_for_token(state, &poster_token, "poster", None)?;
            used_tokens.extend([video_token, poster_token]);
            files.push(("video".to_string(), video));
            files.push(("poster".to_string(), poster));
            (
                "/api/uploads/movies".to_string(),
                collect_fields(
                    &request.fields,
                    &["title", "year", "director", "genre"],
                    &["title", "year", "director", "genre"],
                )?,
            )
        }
        "series" => {
            if request.files.videos.is_empty() || request.files.videos.len() > MAX_MULTI_FILES {
                return Err("Seleziona da 1 a 100 episodi.".to_string());
            }
            let mut seen = HashSet::new();
            for token in &request.files.videos {
                if !seen.insert(token) {
                    return Err("La selezione contiene episodi duplicati.".to_string());
                }
                files.push((
                    "videos".to_string(),
                    selection_for_token(state, token, "series-videos", None)?,
                ));
                used_tokens.push(token.clone());
            }
            if let Some((token, poster)) = optional_selection(state, &request.files.poster, "poster")? {
                files.push(("poster".to_string(), poster));
                used_tokens.push(token);
            }
            (
                "/api/uploads/series".to_string(),
                collect_fields(
                    &request.fields,
                    &["episodes", "title", "year", "genre", "seriesUuid"],
                    &["episodes", "title", "year", "genre"],
                )?,
            )
        }
        "reading" => {
            let category = normalized_category(request.category.as_deref())?
                .ok_or_else(|| "Categoria di lettura richiesta.".to_string())?;
            let document_token = single_token(&request.files.document, "il file di lettura")?;
            let poster_token = single_token(&request.files.poster, "la copertina")?;
            let document = selection_for_token(
                state,
                &document_token,
                "reading-document",
                Some(&category),
            )?;
            let poster = selection_for_token(state, &poster_token, "poster", None)?;
            used_tokens.extend([document_token, poster_token]);
            files.push(("document".to_string(), document));
            files.push(("poster".to_string(), poster));
            (
                format!("/api/uploads/reading/{category}"),
                collect_fields(
                    &request.fields,
                    &["title", "year", "author", "genre"],
                    &["title", "year", "author", "genre"],
                )?,
            )
        }
        "music" => {
            if request.files.audio.is_empty() || request.files.audio.len() > MAX_MULTI_FILES {
                return Err("Seleziona da 1 a 100 brani.".to_string());
            }
            let mut seen = HashSet::new();
            for token in &request.files.audio {
                if !seen.insert(token) {
                    return Err("La selezione contiene brani duplicati.".to_string());
                }
                files.push((
                    "audio".to_string(),
                    selection_for_token(state, token, "music-audio", None)?,
                ));
                used_tokens.push(token.clone());
            }
            if !request.fields.is_empty() {
                return Err("L’upload musicale iniziale non accetta campi aggiuntivi.".to_string());
            }
            ("/api/uploads/music/sessions".to_string(), Vec::new())
        }
        _ => return Err("Tipo di upload nativo non consentito.".to_string()),
    };

    Ok(UploadPlan {
        endpoint_path,
        fields,
        files,
        used_tokens,
    })
}

fn multipart_part(
    selected: SelectedFile,
    progress: Arc<Mutex<ProgressState>>,
    channel: Channel<NativeUploadProgress>,
) -> Result<multipart::Part, String> {
    let file = File::open(&selected.path)
        .map_err(|error| format!("Impossibile aprire “{}”: {error}", selected.name))?;
    multipart::Part::reader_with_length(
        ProgressReader {
            inner: file,
            progress,
            channel,
        },
        selected.size,
    )
    .file_name(selected.name)
    .mime_str(mime_for_path(&selected.path))
    .map_err(|error| format!("Tipo MIME upload non valido: {error}"))
}

fn execute_upload(
    connector_endpoint: String,
    server_fingerprint: String,
    endpoint_path: String,
    access_grant: String,
    authorization: auth::RequestAuthorization,
    plan: UploadPlan,
    on_progress: Channel<NativeUploadProgress>,
) -> Result<NativeUploadResponse, String> {
    let total = plan.files.iter().map(|(_, file)| file.size).sum();
    let progress = Arc::new(Mutex::new(ProgressState {
        loaded: 0,
        total,
        last_sent_at: Instant::now(),
    }));
    let _ = on_progress.send(NativeUploadProgress {
        phase: "starting",
        loaded: 0,
        total,
    });

    let mut form = multipart::Form::new();
    for (name, value) in plan.fields {
        form = form.text(name, value);
    }
    for (field_name, selected) in plan.files {
        let part = multipart_part(selected, Arc::clone(&progress), on_progress.clone())?;
        form = form.part(field_name, part);
    }

    let client = connector_tls::blocking_client(
        &server_fingerprint,
        Duration::from_secs(15),
        None,
    )
    .map_err(|error| format!("Impossibile inizializzare il trasporto upload TLS: {error}"))?;
    let connector_url =
        connector_tls::connector_url(&connector_endpoint, connector_tls::UPLOAD_PATH)?;
    let request_id = Uuid::new_v4().to_string();
    let mut response = client
        .post(&connector_url)
        .header("X-Baia-Protocol-Version", CONNECTOR_PROTOCOL_VERSION.to_string())
        .header("X-Baia-Request-Id", request_id)
        .header("X-Baia-Upload-Path", endpoint_path)
        .header("X-Baia-Access-Grant", access_grant)
        .header("X-Baia-Device-Id", authorization.device_id)
        .header("X-Baia-Timestamp", authorization.timestamp.to_string())
        .header("X-Baia-Nonce", authorization.nonce)
        .header("X-Baia-Signature", authorization.signature)
        .multipart(form)
        .send()
        .map_err(|error| {
            format!(
                "Baia Host Connector TLS non raggiungibile o identita server rifiutata su {connector_endpoint} durante l’upload: {error}"
            )
        })?;

    let status = response.status();
    let mut body = Vec::new();
    response
        .by_ref()
        .take(MAX_RESPONSE_BYTES + 1)
        .read_to_end(&mut body)
        .map_err(|error| format!("Impossibile leggere la risposta del server: {error}"))?;
    if body.len() as u64 > MAX_RESPONSE_BYTES {
        return Err("La risposta del server all’upload è troppo grande.".to_string());
    }
    let payload = serde_json::from_slice(&body).unwrap_or_else(|_| {
        if status.is_success() {
            Value::Null
        } else {
            json!({ "error": format!("Errore HTTP {}", status.as_u16()) })
        }
    });
    let _ = on_progress.send(NativeUploadProgress {
        phase: if status.is_success() { "processing" } else { "failed" },
        loaded: total,
        total,
    });

    Ok(NativeUploadResponse {
        status: status.as_u16(),
        ok: status.is_success(),
        payload,
    })
}

#[tauri::command]
pub async fn baia_core_pick_upload_files(
    role: String,
    category: Option<String>,
    app: AppHandle,
    state: State<'_, NativeUploadState>,
) -> Result<Vec<NativeUploadSelection>, String> {
    let spec = picker_spec(&role, category.as_deref())?;
    let dialog = app
        .dialog()
        .file()
        .set_title(spec.title)
        .add_filter(spec.title, spec.extensions);
    let selected = if spec.multiple {
        dialog.blocking_pick_files().unwrap_or_default()
    } else {
        dialog.blocking_pick_file().into_iter().collect()
    };
    if selected.len() > spec.max_count {
        return Err(format!("Puoi selezionare al massimo {} file.", spec.max_count));
    }

    let mut prepared = Vec::with_capacity(selected.len());
    for file_path in selected {
        #[cfg(target_os = "android")]
        let result = prepare_android_selected_file(
            &app,
            &state,
            &role,
            spec.category.clone(),
            file_path,
            spec.extensions,
        );

        #[cfg(not(target_os = "android"))]
        let result = file_path
            .simplified()
            .into_path()
            .map_err(|_| {
                "Questo tipo di file non è ancora leggibile dal Core su questa piattaforma.".to_string()
            })
            .and_then(|path| {
                prepare_selected_file(
                    &state,
                    &role,
                    spec.category.clone(),
                    path,
                    spec.extensions,
                    None,
                    false,
                )
            });

        match result {
            Ok(selection) => prepared.push(selection),
            Err(error) => {
                let tokens: Vec<String> = prepared.iter().map(|item| item.token.clone()).collect();
                let _ = state.release(&tokens);
                return Err(error);
            }
        }
    }
    Ok(prepared)
}

#[tauri::command]
pub fn baia_core_release_upload_files(
    tokens: Vec<String>,
    state: State<'_, NativeUploadState>,
) -> Result<(), String> {
    state.release(&tokens)
}

#[tauri::command]
pub async fn baia_core_upload_files(
    request: NativeUploadRequest,
    on_progress: Channel<NativeUploadProgress>,
    core_state: State<'_, CoreState>,
    upload_state: State<'_, NativeUploadState>,
) -> Result<NativeUploadResponse, String> {
    let plan = upload_plan(&upload_state, &request)?;
    let (connector_endpoint, server_fingerprint) = core_state.connector_context()?;
    let access_grant = core_state.transport_access_grant()?;
    let (base_url, _, _) = core_state.pairing_context()?;
    let node_target = format!("{base_url}{}", plan.endpoint_path);
    let authorization = auth::authorize_request("POST", &node_target, &core_state)?;
    let endpoint_path = plan.endpoint_path.clone();
    let used_tokens = plan.used_tokens.clone();

    let response = tauri::async_runtime::spawn_blocking(move || {
        execute_upload(
            connector_endpoint,
            server_fingerprint,
            endpoint_path,
            access_grant,
            authorization,
            plan,
            on_progress,
        )
    })
    .await
    .map_err(|error| format!("Il task di upload nativo è terminato in modo anomalo: {error}"))??;

    if response.ok {
        upload_state.release(&used_tokens)?;
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::{
        normalized_category, picker_spec, NativeUploadRequest, NativeUploadState, SelectedFile,
    };
    use std::{fs, time::Instant};
    use uuid::Uuid;

    #[test]
    fn picker_roles_are_allowlisted() {
        assert!(picker_spec("movie-video", None).is_ok());
        assert!(picker_spec("series-videos", None).unwrap().multiple);
        assert!(picker_spec("music-audio", None).unwrap().multiple);
        assert!(picker_spec("reading-document", Some("books")).is_ok());
        assert!(picker_spec("reading-document", Some("manga")).is_ok());
        assert!(picker_spec("arbitrary-path", None).is_err());
    }

    #[test]
    fn reading_categories_are_strict() {
        assert_eq!(normalized_category(Some("books")).unwrap().as_deref(), Some("books"));
        assert!(normalized_category(Some("../../../etc")).is_err());
    }


    #[test]
    fn release_deletes_only_materialized_picker_copies() {
        let temp = std::env::temp_dir();
        let transient_path = temp.join(format!("baia-upload-transient-{}.mp3", Uuid::new_v4()));
        let regular_path = temp.join(format!("baia-upload-regular-{}.mp3", Uuid::new_v4()));
        fs::write(&transient_path, b"temporary").unwrap();
        fs::write(&regular_path, b"regular").unwrap();

        let state = NativeUploadState::default();
        let transient_token = state
            .insert(SelectedFile {
                role: "music-audio".to_string(),
                category: None,
                path: transient_path.clone(),
                name: "temporary.mp3".to_string(),
                size: 9,
                created_at: Instant::now(),
                temporary: true,
            })
            .unwrap();
        let regular_token = state
            .insert(SelectedFile {
                role: "music-audio".to_string(),
                category: None,
                path: regular_path.clone(),
                name: "regular.mp3".to_string(),
                size: 7,
                created_at: Instant::now(),
                temporary: false,
            })
            .unwrap();

        state.release(&[transient_token, regular_token]).unwrap();

        assert!(!transient_path.exists());
        assert!(regular_path.exists());
        fs::remove_file(regular_path).unwrap();
    }

    #[test]
    fn phase4a4_upload_transport_uses_only_the_connector_upload_route() {
        assert_eq!(crate::connector_tls::UPLOAD_PATH, "/baia/v1/upload");
        assert!(crate::connector_tls::connector_url(
            "https://192.168.1.50:43127",
            crate::connector_tls::UPLOAD_PATH,
        )
        .is_ok());
    }

    #[test]
    fn upload_request_rejects_urls_paths_and_unknown_file_fields() {
        let top_level = serde_json::from_value::<NativeUploadRequest>(serde_json::json!({
            "kind": "movie",
            "url": "https://evil.invalid/upload",
            "fields": {},
            "files": { "video": "opaque", "poster": "opaque-2" }
        }));
        assert!(top_level.is_err());

        let file_path = serde_json::from_value::<NativeUploadRequest>(serde_json::json!({
            "kind": "movie",
            "fields": {},
            "files": {
                "video": "opaque",
                "poster": "opaque-2",
                "path": "C:\\\\secret.txt"
            }
        }));
        assert!(file_path.is_err());
    }
}
