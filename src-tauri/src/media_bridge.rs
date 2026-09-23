use crate::{
    auth,
    connector_tls,
    core::CoreState,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use reqwest::{blocking::Client, Method};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, ErrorKind, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{sync_channel, Receiver, SyncSender},
        Arc, Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::State;
use uuid::Uuid;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const PROTOCOL_VERSION: u16 = 1;
const MAX_REQUEST_LINE_BYTES: usize = 4096;
const MAX_HEADER_LINE_BYTES: usize = 8192;
const MAX_HEADER_COUNT: usize = 64;
const KEEP_ALIVE_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_REQUESTS_PER_CONNECTION: usize = 200;
const CONNECTOR_MEDIA_CHUNK_BYTES: u64 = 8 * 1024 * 1024;
const VIDEO_PIPE_BUFFER_BYTES: usize = 256 * 1024;
const VIDEO_PIPE_BUFFER_SLOTS: usize = 16;
const BRIDGE_HEADER: &str = "X-Baia-Media-Bridge";
const BRIDGE_HEADER_VALUE: &str = "media-v1";
// Tauri's webview origin differs by platform: Windows and Android serve the
// frontend from http://tauri.localhost, while Linux (and macOS/iOS) use the
// tauri://localhost custom scheme directly. This must match whatever Origin
// header the webview's fetch() actually sends, or the browser rejects the
// response due to a CORS mismatch even though the HTTP request itself
// succeeds (visible as "Origin ... is not allowed by Access-Control-Allow-Origin"
// in the console, despite a 200 status).
#[cfg(any(target_os = "windows", target_os = "android"))]
const BRIDGE_CORS_ORIGIN: &str = "http://tauri.localhost";
#[cfg(not(any(target_os = "windows", target_os = "android")))]
const BRIDGE_CORS_ORIGIN: &str = "tauri://localhost";
const BRIDGE_EXPOSE_HEADERS: &str = "Accept-Ranges, Content-Length, Content-Range, Content-Type, ETag, Last-Modified";

struct CachedMediaConnectorClient {
    fingerprint: String,
    client: Client,
}

struct VideoStreamCoordinator {
    generations: Mutex<HashMap<String, u64>>,
}

impl VideoStreamCoordinator {
    fn new() -> Self {
        Self {
            generations: Mutex::new(HashMap::new()),
        }
    }

    fn begin(self: &Arc<Self>, media_key: &str) -> Result<VideoStreamTicket, String> {
        let mut generations = self
            .generations
            .lock()
            .map_err(|_| "Coordinatore video del Media Bridge non disponibile.".to_string())?;
        let generation = generations
            .entry(media_key.to_string())
            .and_modify(|value| *value = value.wrapping_add(1).max(1))
            .or_insert(1);
        Ok(VideoStreamTicket {
            coordinator: Arc::clone(self),
            media_key: media_key.to_string(),
            generation: *generation,
            range_id: Uuid::new_v4().to_string(),
        })
    }

    fn is_current(&self, media_key: &str, generation: u64) -> bool {
        self.generations
            .lock()
            .ok()
            .and_then(|generations| generations.get(media_key).copied())
            == Some(generation)
    }
}

#[derive(Clone)]
struct VideoStreamTicket {
    coordinator: Arc<VideoStreamCoordinator>,
    media_key: String,
    generation: u64,
    range_id: String,
}

impl VideoStreamTicket {
    fn is_current(&self) -> bool {
        self.coordinator
            .is_current(&self.media_key, self.generation)
    }
}

#[derive(Default)]
struct VideoTransferStats {
    bytes_from_connector: AtomicU64,
    bytes_to_webview: AtomicU64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VideoStreamOutcome {
    Complete,
    Superseded,
    ClientDisconnected,
}

#[derive(Clone)]
struct BridgeRoute {
    path: String,
    authorization: auth::MediaAuthorization,
    access_grant: String,
    connector_url: String,
    connector_client: Client,
    video_coordinator: Arc<VideoStreamCoordinator>,
    expires: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectorMediaRequest {
    protocol_version: u16,
    request_id: String,
    method: String,
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    range: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    if_range: Option<String>,
    access_grant: String,
    device_auth: auth::MediaAuthorization,
}

pub struct MediaBridge {
    address: SocketAddr,
    routes: Arc<Mutex<HashMap<String, BridgeRoute>>>,
    connector_client: Mutex<Option<CachedMediaConnectorClient>>,
    video_coordinator: Arc<VideoStreamCoordinator>,
    shutdown: Arc<AtomicBool>,
}

impl MediaBridge {
    pub fn new() -> Result<Self, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|error| format!("Impossibile avviare il ponte media locale: {error}"))?;
        let address = listener
            .local_addr()
            .map_err(|error| format!("Impossibile leggere la porta del ponte media: {error}"))?;
        let routes = Arc::new(Mutex::new(HashMap::new()));
        let video_coordinator = Arc::new(VideoStreamCoordinator::new());
        let shutdown = Arc::new(AtomicBool::new(false));
        let worker_routes = Arc::clone(&routes);
        let worker_shutdown = Arc::clone(&shutdown);

        thread::Builder::new()
            .name("baia-media-bridge".to_string())
            .spawn(move || run_bridge(listener, worker_routes, worker_shutdown))
            .map_err(|error| format!("Impossibile avviare il thread del ponte media: {error}"))?;

        Ok(Self {
            address,
            routes,
            connector_client: Mutex::new(None),
            video_coordinator,
            shutdown,
        })
    }

    fn client_for(&self, server_fingerprint: &str) -> Result<Client, String> {
        let mut guard = self
            .connector_client
            .lock()
            .map_err(|_| "Cache TLS del Media Bridge non disponibile.".to_string())?;
        if let Some(cached) = guard.as_ref() {
            if cached.fingerprint == server_fingerprint {
                return Ok(cached.client.clone());
            }
        }

        let client = connector_tls::blocking_client(
            server_fingerprint,
            CONNECT_TIMEOUT,
            None,
        )
        .map_err(|error| format!("Impossibile inizializzare il trasporto media TLS: {error}"))?;
        *guard = Some(CachedMediaConnectorClient {
            fingerprint: server_fingerprint.to_string(),
            client: client.clone(),
        });
        Ok(client)
    }

    fn register_media_stream(&self, path: &str, state: &CoreState) -> Result<String, String> {
        let path = normalize_media_stream_path(path)?;
        let (connector_endpoint, server_fingerprint) = state.connector_context()?;
        let connector_url =
            connector_tls::connector_url(&connector_endpoint, connector_tls::MEDIA_PATH)?;
        let connector_client = self.client_for(&server_fingerprint)?;
        let access_grant = state.transport_access_grant()?;
        let authorization = auth::authorize_media_path(&path, state)?;
        let expires = authorization.expires;
        let token = random_token()?;
        let now = unix_seconds();

        let mut routes = self
            .routes
            .lock()
            .map_err(|_| "Ponte media locale non disponibile.".to_string())?;
        routes.retain(|_, route| route.expires >= now);
        routes.insert(
            token.clone(),
            BridgeRoute {
                path,
                authorization,
                access_grant,
                connector_url,
                connector_client,
                video_coordinator: Arc::clone(&self.video_coordinator),
                expires,
            },
        );

        Ok(format!(
            "http://{}/media/{}?_baia_expires={}",
            self.address, token, expires
        ))
    }
}

impl Drop for MediaBridge {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect_timeout(&self.address, Duration::from_millis(150));
    }
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| format!("Impossibile generare il token del ponte media: {error}"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn is_uuid_path_segment(value: &str) -> bool {
    value.len() == 36
        && value.chars().enumerate().all(|(index, ch)| match index {
            8 | 13 | 18 | 23 => ch == '-',
            14 => matches!(ch.to_ascii_lowercase(), '1'..='8'),
            19 => matches!(ch.to_ascii_lowercase(), '8' | '9' | 'a' | 'b'),
            _ => ch.is_ascii_hexdigit(),
        })
}

fn normalize_media_stream_path(value: &str) -> Result<String, String> {
    let path = value.trim();
    if path.contains('?') || path.contains('#') || path.contains('\\') || path.starts_with("//") {
        return Err("Percorso media non valido per il ponte media.".to_string());
    }
    let segments: Vec<_> = path.trim_matches('/').split('/').collect();
    match segments.as_slice() {
        ["api", "movies", id, "stream"] if !id.is_empty() && id.chars().all(|ch| ch.is_ascii_digit()) => {
            Ok(format!("/api/movies/{id}/stream"))
        }
        ["api", "movies", id, "poster"] if !id.is_empty() && id.chars().all(|ch| ch.is_ascii_digit()) => {
            Ok(format!("/api/movies/{id}/poster"))
        }
        ["api", "series", series_id, "poster"] if is_uuid_path_segment(series_id) => {
            Ok(format!("/api/series/{series_id}/poster"))
        }
        ["api", "music", "tracks", track_id, "stream"] if is_uuid_path_segment(track_id) => {
            Ok(format!("/api/music/tracks/{track_id}/stream"))
        }
        ["api", "music", "albums", album_id, "cover"] if is_uuid_path_segment(album_id) => {
            Ok(format!("/api/music/albums/{album_id}/cover"))
        }
        ["api", "reading", id, "file"] if !id.is_empty() && id.chars().all(|ch| ch.is_ascii_digit()) => {
            Ok(format!("/api/reading/{id}/file"))
        }
        ["api", "reading", id, "cover"] if !id.is_empty() && id.chars().all(|ch| ch.is_ascii_digit()) => {
            Ok(format!("/api/reading/{id}/cover"))
        }
        ["api", "reading", id, "reader", "entry", entry_id]
            if !id.is_empty()
                && id.chars().all(|ch| ch.is_ascii_digit())
                && !entry_id.is_empty()
                && entry_id.chars().all(|ch| ch.is_ascii_digit()) =>
        {
            Ok(format!("/api/reading/{id}/reader/entry/{entry_id}"))
        }
        _ => Err("Il ponte media accetta soltanto risorse Film, Serie, Musica e Reading allowlistate.".to_string()),
    }
}

fn is_video_stream_path(path: &str) -> bool {
    let segments: Vec<_> = path.trim_matches('/').split('/').collect();
    matches!(
        segments.as_slice(),
        ["api", "movies", id, "stream"]
            if !id.is_empty() && id.chars().all(|ch| ch.is_ascii_digit())
    )
}

fn run_bridge(
    listener: TcpListener,
    routes: Arc<Mutex<HashMap<String, BridgeRoute>>>,
    shutdown: Arc<AtomicBool>,
) {
    while !shutdown.load(Ordering::SeqCst) {
        let (stream, _) = match listener.accept() {
            Ok(connection) => connection,
            Err(error) => {
                if !shutdown.load(Ordering::SeqCst) {
                    eprintln!("Errore accept ponte media Baia: {error}");
                }
                continue;
            }
        };
        if shutdown.load(Ordering::SeqCst) {
            break;
        }

        let routes = Arc::clone(&routes);
        let _ = thread::Builder::new()
            .name("baia-media-stream".to_string())
            .spawn(move || {
                if let Err(error) = handle_connection(stream, &routes) {
                    eprintln!("Errore ponte media Baia: {error}");
                }
            });
    }
}

fn handle_connection(
    mut stream: TcpStream,
    routes: &Arc<Mutex<HashMap<String, BridgeRoute>>>,
) -> Result<(), String> {
    let read_stream = stream
        .try_clone()
        .map_err(|error| format!("Impossibile leggere la richiesta locale: {error}"))?;
    let mut reader = BufReader::new(read_stream);

    for request_index in 1..=MAX_REQUESTS_PER_CONNECTION {
        let _ = stream.set_read_timeout(Some(if request_index == 1 {
            Duration::from_secs(15)
        } else {
            KEEP_ALIVE_IDLE_TIMEOUT
        }));
        let mut request_line = String::new();
        if let Err(error) = read_limited_line(&mut reader, &mut request_line, MAX_REQUEST_LINE_BYTES) {
            if request_index > 1 {
                return Ok(());
            }
            return Err(error);
        }
        let (method, target) = parse_request_line(&request_line)?;
        let http10 = request_line.trim_end().ends_with("HTTP/1.0");
        let mut range = None;
        let mut if_range = None;
        let mut connection_close = http10;
        let mut header_terminated = false;

        for _ in 0..MAX_HEADER_COUNT {
            let mut line = String::new();
            read_limited_line(&mut reader, &mut line, MAX_HEADER_LINE_BYTES)?;
            if line == "\r\n" || line == "\n" || line.is_empty() {
                header_terminated = true;
                break;
            }
            if let Some((name, value)) = line.split_once(':') {
                let name = name.trim().to_ascii_lowercase();
                let value = value.trim();
                if value.contains('\r') || value.contains('\n') {
                    return write_error(&mut stream, 400, "Bad Request");
                }
                match name.as_str() {
                    "range" => range = Some(value.to_string()),
                    "if-range" => if_range = Some(value.to_string()),
                    "connection" if value.eq_ignore_ascii_case("close") => connection_close = true,
                    _ => {}
                }
            } else {
                return write_error(&mut stream, 400, "Bad Request");
            }
        }
        if !header_terminated {
            return write_error(&mut stream, 400, "Bad Request");
        }

        if !matches!(method, Method::GET | Method::HEAD) {
            return write_error(&mut stream, 405, "Method Not Allowed");
        }

        let token = match bridge_token(target) {
            Ok(token) => token,
            Err(_) => return write_error(&mut stream, 404, "Not Found"),
        };
        let route = {
            let now = unix_seconds();
            let mut guard = routes
                .lock()
                .map_err(|_| "Registro ponte media non disponibile.".to_string())?;
            guard.retain(|_, route| route.expires >= now);
            guard.get(token).cloned()
        };
        let Some(route) = route else {
            return write_error(&mut stream, 410, "Gone");
        };

        let keep_alive = !connection_close && request_index < MAX_REQUESTS_PER_CONNECTION;
        let chunkable_range = if method == Method::GET && is_video_stream_path(&route.path) {
            range.as_deref().and_then(parse_chunkable_range)
        } else {
            None
        };

        if let Some(requested) = chunkable_range {
            // V6: a newly requested long Range for the same logical video
            // immediately supersedes the previous long Range. Small probe
            // ranges do not enter this coordinator and remain independent.
            let video_ticket = route.video_coordinator.begin(&route.path)?;
            eprintln!(
                "video_range_id={} event=begin requested_start={} requested_end={}",
                video_ticket.range_id,
                requested.start,
                requested
                    .end
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "open".to_string())
            );
            let first_end = requested
                .end
                .unwrap_or_else(|| requested.start.saturating_add(CONNECTOR_MEDIA_CHUNK_BYTES - 1))
                .min(requested.start.saturating_add(CONNECTOR_MEDIA_CHUNK_BYTES - 1));
            let first_range = format!("bytes={}-{}", requested.start, first_end);
            let mut response = match send_connector_media_request(
                &route,
                Method::GET,
                Some(first_range),
                if_range.clone(),
            ) {
                Ok(response) => response,
                Err(error) => {
                    eprintln!("Baia Host Connector media non raggiungibile: {error}");
                    return write_error(&mut stream, 502, "Bad Gateway");
                }
            };

            if response.status().as_u16() == 206 {
                let content_range = match response
                    .headers()
                    .get(reqwest::header::CONTENT_RANGE)
                    .and_then(|value| value.to_str().ok())
                    .and_then(parse_content_range)
                {
                    Some(value) => value,
                    None => return write_error(&mut stream, 502, "Bad Gateway"),
                };
                if content_range.start != requested.start {
                    return write_error(&mut stream, 502, "Bad Gateway");
                }
                let expected_first_end = first_end.min(content_range.total.saturating_sub(1));
                if content_range.end != expected_first_end {
                    return write_error(&mut stream, 502, "Bad Gateway");
                }

                let final_end = requested
                    .end
                    .unwrap_or_else(|| content_range.total.saturating_sub(1))
                    .min(content_range.total.saturating_sub(1));
                if final_end < requested.start {
                    return write_error(&mut stream, 502, "Bad Gateway");
                }

                match stream_segmented_video_response(
                    &mut stream,
                    &route,
                    response,
                    requested.start,
                    final_end,
                    content_range.total,
                    if_range.clone(),
                    keep_alive,
                    video_ticket,
                )? {
                    VideoStreamOutcome::Complete => {
                        stream.flush().ok();
                        if !keep_alive {
                            return Ok(());
                        }
                        continue;
                    }
                    VideoStreamOutcome::Superseded | VideoStreamOutcome::ClientDisconnected => {
                        // Drop the local socket with an incomplete body. The
                        // WebView has already moved on (seek) or disconnected.
                        return Ok(());
                    }
                }
            }

            // If If-Range does not match, HTTP semantics allow the upstream to
            // ignore Range and return the complete representation (200). Forward
            // that response unchanged instead of inventing segmented semantics.
            if response.status().is_redirection() {
                return write_error(&mut stream, 502, "Bad Gateway");
            }
            if !video_ticket.is_current() {
                return Ok(());
            }
            if let Err(error) = write_status_and_headers(&mut stream, &response, keep_alive) {
                if is_client_disconnect_message(&error) {
                    return Ok(());
                }
                return Err(error);
            }
            let stats = VideoTransferStats::default();
            let outcome = copy_video_response_cancelable(
                &mut response,
                &mut stream,
                &video_ticket,
                &stats,
            )?;
            log_video_transfer(
                &video_ticket,
                outcome,
                &stats,
                1,
                requested.start,
                requested.end,
            );
            match outcome {
                VideoStreamOutcome::Complete => {
                    stream.flush().ok();
                    if !keep_alive {
                        return Ok(());
                    }
                    continue;
                }
                VideoStreamOutcome::Superseded | VideoStreamOutcome::ClientDisconnected => {
                    return Ok(());
                }
            }
        }

        let mut response = match send_connector_media_request(
            &route,
            method.clone(),
            range,
            if_range,
        ) {
            Ok(response) => response,
            Err(error) => {
                eprintln!("Baia Host Connector media non raggiungibile: {error}");
                return write_error(&mut stream, 502, "Bad Gateway");
            }
        };

        if response.status().is_redirection() {
            return write_error(&mut stream, 502, "Bad Gateway");
        }

        if let Err(error) = write_status_and_headers(&mut stream, &response, keep_alive) {
            if is_client_disconnect_message(&error) {
                return Ok(());
            }
            return Err(error);
        }
        if method != Method::HEAD {
            if let Err(error) = std::io::copy(&mut response, &mut stream) {
                if !is_client_disconnect(&error) {
                    return Err(format!("Streaming dal ponte media interrotto: {error}"));
                }
                return Ok(());
            }
        }
        stream.flush().ok();
        if !keep_alive {
            return Ok(());
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ChunkableRange {
    start: u64,
    end: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ParsedContentRange {
    start: u64,
    end: u64,
    total: u64,
}

fn parse_chunkable_range(value: &str) -> Option<ChunkableRange> {
    let spec = value.trim().strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None;
    }
    let (start_text, end_text) = spec.split_once('-')?;
    if start_text.is_empty() {
        // Suffix ranges are left untouched; the browser uses them rarely and
        // their final start offset is not known until the upstream resolves it.
        return None;
    }
    let start = start_text.parse::<u64>().ok()?;
    let end = if end_text.is_empty() {
        None
    } else {
        let end = end_text.parse::<u64>().ok()?;
        if end < start {
            return None;
        }
        Some(end)
    };
    let should_chunk = end
        .map(|end| end.saturating_sub(start).saturating_add(1) > CONNECTOR_MEDIA_CHUNK_BYTES)
        .unwrap_or(true);
    should_chunk.then_some(ChunkableRange { start, end })
}

fn parse_content_range(value: &str) -> Option<ParsedContentRange> {
    let value = value.trim().strip_prefix("bytes ")?;
    let (range, total) = value.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    let start = start.parse::<u64>().ok()?;
    let end = end.parse::<u64>().ok()?;
    let total = total.parse::<u64>().ok()?;
    if total == 0 || start > end || end >= total {
        return None;
    }
    Some(ParsedContentRange { start, end, total })
}

fn send_connector_media_request(
    route: &BridgeRoute,
    method: Method,
    range: Option<String>,
    if_range: Option<String>,
) -> Result<reqwest::blocking::Response, String> {
    let frame = ConnectorMediaRequest {
        protocol_version: PROTOCOL_VERSION,
        request_id: Uuid::new_v4().to_string(),
        method: method.as_str().to_string(),
        path: route.path.clone(),
        range,
        if_range,
        access_grant: route.access_grant.clone(),
        device_auth: route.authorization.clone(),
    };
    let mut request = route
        .connector_client
        .post(&route.connector_url)
        .header(reqwest::header::ACCEPT, "*/*");
    if !is_video_stream_path(&route.path) {
        // Preserve the stable V3 behavior for posters/covers/music/reading:
        // only video participates in the remote persistent-connection pool.
        request = request.header(reqwest::header::CONNECTION, "close");
    }
    request
        .json(&frame)
        .send()
        .map_err(|error| format!("Richiesta media al Connector fallita: {error}"))
}

fn response_header_string(
    response: &reqwest::blocking::Response,
    name: reqwest::header::HeaderName,
) -> Option<String> {
    response
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

fn validate_segment_response(
    response: &reqwest::blocking::Response,
    start: u64,
    end: u64,
    total: u64,
    expected_etag: Option<&str>,
    expected_last_modified: Option<&str>,
) -> Result<(), String> {
    if response.status().as_u16() != 206 {
        return Err(format!(
            "Il Connector ha restituito status {} durante un Range segmentato.",
            response.status().as_u16()
        ));
    }
    let parsed = response
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_content_range)
        .ok_or_else(|| "Content-Range Connector non valido durante streaming segmentato.".to_string())?;
    if parsed.start != start || parsed.end != end || parsed.total != total {
        return Err("Content-Range Connector incoerente durante streaming segmentato.".to_string());
    }
    let expected_length = end - start + 1;
    let actual_length = response
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| "Content-Length Connector mancante durante streaming segmentato.".to_string())?;
    if actual_length != expected_length {
        return Err("Content-Length Connector incoerente durante streaming segmentato.".to_string());
    }
    if let Some(expected) = expected_etag {
        if response_header_string(response, reqwest::header::ETAG).as_deref() != Some(expected) {
            return Err("ETag cambiato durante streaming segmentato.".to_string());
        }
    }
    if let Some(expected) = expected_last_modified {
        if response_header_string(response, reqwest::header::LAST_MODIFIED).as_deref() != Some(expected) {
            return Err("Last-Modified cambiato durante streaming segmentato.".to_string());
        }
    }
    Ok(())
}

fn write_segmented_status_and_headers(
    stream: &mut TcpStream,
    response: &reqwest::blocking::Response,
    start: u64,
    end: u64,
    total: u64,
    keep_alive: bool,
) -> Result<(), String> {
    write!(stream, "HTTP/1.1 206 Partial Content\r\n")
        .map_err(|error| format!("Impossibile scrivere la risposta locale segmentata: {error}"))?;

    const FORWARDED: &[&str] = &[
        "content-type",
        "accept-ranges",
        "content-disposition",
        "cache-control",
        "etag",
        "last-modified",
    ];
    for name in FORWARDED {
        if let Some(value) = response.headers().get(*name).and_then(|value| value.to_str().ok()) {
            write!(stream, "{}: {}\r\n", canonical_header_name(name), value)
                .map_err(|error| format!("Impossibile scrivere gli header media segmentati: {error}"))?;
        }
    }
    write!(
        stream,
        "Content-Length: {}\r\nContent-Range: bytes {}-{}/{}\r\nAccess-Control-Allow-Origin: {}\r\nAccess-Control-Expose-Headers: {}\r\n{}: {}\r\nConnection: {}\r\n\r\n",
        end - start + 1,
        start,
        end,
        total,
        BRIDGE_CORS_ORIGIN,
        BRIDGE_EXPOSE_HEADERS,
        BRIDGE_HEADER,
        BRIDGE_HEADER_VALUE,
        if keep_alive { "keep-alive" } else { "close" }
    )
    .map_err(|error| format!("Impossibile finalizzare gli header media segmentati: {error}"))?;
    Ok(())
}

fn video_outcome_name(outcome: VideoStreamOutcome) -> &'static str {
    match outcome {
        VideoStreamOutcome::Complete => "complete",
        VideoStreamOutcome::Superseded => "superseded",
        VideoStreamOutcome::ClientDisconnected => "client_disconnected",
    }
}

fn log_video_transfer(
    ticket: &VideoStreamTicket,
    outcome: VideoStreamOutcome,
    stats: &VideoTransferStats,
    segment_count: u64,
    requested_start: u64,
    requested_end: Option<u64>,
) {
    let bytes_from_connector = stats.bytes_from_connector.load(Ordering::Relaxed);
    let bytes_to_webview = stats.bytes_to_webview.load(Ordering::Relaxed);
    let bytes_discarded = bytes_from_connector.saturating_sub(bytes_to_webview);
    eprintln!(
        "video_range_id={} event=end result={} requested_start={} requested_end={} segment_count={} bytes_from_connector={} bytes_to_webview={} bytes_discarded={}",
        ticket.range_id,
        video_outcome_name(outcome),
        requested_start,
        requested_end
            .map(|value| value.to_string())
            .unwrap_or_else(|| "open".to_string()),
        segment_count,
        bytes_from_connector,
        bytes_to_webview,
        bytes_discarded,
    );
}

fn copy_video_response_cancelable(
    response: &mut reqwest::blocking::Response,
    stream: &mut TcpStream,
    ticket: &VideoStreamTicket,
    stats: &VideoTransferStats,
) -> Result<VideoStreamOutcome, String> {
    loop {
        if !ticket.is_current() {
            return Ok(VideoStreamOutcome::Superseded);
        }
        let mut buffer = vec![0u8; VIDEO_PIPE_BUFFER_BYTES];
        let read = response
            .read(&mut buffer)
            .map_err(|error| format!("Lettura media dal Connector fallita: {error}"))?;
        if read == 0 {
            return Ok(VideoStreamOutcome::Complete);
        }
        stats
            .bytes_from_connector
            .fetch_add(read as u64, Ordering::Relaxed);
        if !ticket.is_current() {
            return Ok(VideoStreamOutcome::Superseded);
        }
        if let Err(error) = stream.write_all(&buffer[..read]) {
            if is_client_disconnect(&error) {
                return Ok(VideoStreamOutcome::ClientDisconnected);
            }
            return Err(format!("Streaming locale del video interrotto: {error}"));
        }
        stats
            .bytes_to_webview
            .fetch_add(read as u64, Ordering::Relaxed);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VideoProducerOutcome {
    Complete,
    Superseded,
    ReceiverClosed,
}

fn send_response_body_to_pipe(
    response: &mut reqwest::blocking::Response,
    sender: &SyncSender<Vec<u8>>,
    ticket: &VideoStreamTicket,
    stats: &VideoTransferStats,
) -> Result<VideoProducerOutcome, String> {
    loop {
        if !ticket.is_current() {
            return Ok(VideoProducerOutcome::Superseded);
        }
        let mut chunk = vec![0u8; VIDEO_PIPE_BUFFER_BYTES];
        let read = response
            .read(&mut chunk)
            .map_err(|error| format!("Lettura segmento media dal Connector fallita: {error}"))?;
        if read == 0 {
            return Ok(VideoProducerOutcome::Complete);
        }
        stats
            .bytes_from_connector
            .fetch_add(read as u64, Ordering::Relaxed);
        chunk.truncate(read);
        if !ticket.is_current() {
            return Ok(VideoProducerOutcome::Superseded);
        }
        if sender.send(chunk).is_err() {
            // The local writer has stopped because the request was superseded
            // or the WebView disconnected. Do not drain the remote response:
            // V6 prioritizes the new useful Range over preserving this TLS.
            return Ok(VideoProducerOutcome::ReceiverClosed);
        }
    }
}

fn write_video_pipe(
    mut stream: TcpStream,
    receiver: Receiver<Vec<u8>>,
    ticket: VideoStreamTicket,
    stats: Arc<VideoTransferStats>,
) -> Result<VideoStreamOutcome, String> {
    while let Ok(chunk) = receiver.recv() {
        if !ticket.is_current() {
            return Ok(VideoStreamOutcome::Superseded);
        }
        if let Err(error) = stream.write_all(&chunk) {
            if is_client_disconnect(&error) {
                return Ok(VideoStreamOutcome::ClientDisconnected);
            }
            return Err(format!("Streaming locale del video interrotto: {error}"));
        }
        stats
            .bytes_to_webview
            .fetch_add(chunk.len() as u64, Ordering::Relaxed);
    }
    if !ticket.is_current() {
        return Ok(VideoStreamOutcome::Superseded);
    }
    match stream.flush() {
        Ok(()) => Ok(VideoStreamOutcome::Complete),
        Err(error) if is_client_disconnect(&error) => Ok(VideoStreamOutcome::ClientDisconnected),
        Err(error) => Err(format!("Flush locale del video fallito: {error}")),
    }
}

fn stream_segmented_video_response(
    stream: &mut TcpStream,
    route: &BridgeRoute,
    mut first_response: reqwest::blocking::Response,
    start: u64,
    end: u64,
    total: u64,
    if_range: Option<String>,
    keep_alive: bool,
    ticket: VideoStreamTicket,
) -> Result<VideoStreamOutcome, String> {
    let stats = Arc::new(VideoTransferStats::default());
    let first_content_range = first_response
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_content_range)
        .ok_or_else(|| "Content-Range iniziale non valido durante streaming segmentato.".to_string())?;
    let etag = response_header_string(&first_response, reqwest::header::ETAG);
    let last_modified = response_header_string(&first_response, reqwest::header::LAST_MODIFIED);
    validate_segment_response(
        &first_response,
        first_content_range.start,
        first_content_range.end,
        total,
        etag.as_deref(),
        last_modified.as_deref(),
    )?;

    if !ticket.is_current() {
        let outcome = VideoStreamOutcome::Superseded;
        log_video_transfer(&ticket, outcome, &stats, 1, start, Some(end));
        return Ok(outcome);
    }
    if let Err(error) = write_segmented_status_and_headers(
        stream,
        &first_response,
        start,
        end,
        total,
        keep_alive,
    ) {
        if is_client_disconnect_message(&error) {
            let outcome = VideoStreamOutcome::ClientDisconnected;
            log_video_transfer(&ticket, outcome, &stats, 1, start, Some(end));
            return Ok(outcome);
        }
        return Err(error);
    }

    // Keep only a small bounded prefetch window. A newly requested long Range
    // for the same media invalidates this ticket; producer and writer both
    // observe that generation and stop without draining obsolete remote bytes.
    let writer_stream = stream
        .try_clone()
        .map_err(|error| format!("Impossibile clonare il socket locale video: {error}"))?;
    let (sender, receiver) = sync_channel::<Vec<u8>>(VIDEO_PIPE_BUFFER_SLOTS);
    let writer_ticket = ticket.clone();
    let writer_stats = Arc::clone(&stats);
    let writer = thread::Builder::new()
        .name("baia-media-video-writer".to_string())
        .spawn(move || write_video_pipe(writer_stream, receiver, writer_ticket, writer_stats))
        .map_err(|error| format!("Impossibile avviare il writer video locale: {error}"))?;

    let mut current_start = first_content_range.start;
    let mut current_end = first_content_range.end;
    let mut response = first_response;
    let mut segment_count = 1u64;
    let mut producer_error: Option<String> = None;
    let mut producer_outcome = VideoProducerOutcome::Complete;

    loop {
        if !ticket.is_current() {
            producer_outcome = VideoProducerOutcome::Superseded;
            break;
        }
        match send_response_body_to_pipe(&mut response, &sender, &ticket, &stats) {
            Ok(VideoProducerOutcome::Complete) => {}
            Ok(outcome @ VideoProducerOutcome::Superseded)
            | Ok(outcome @ VideoProducerOutcome::ReceiverClosed) => {
                producer_outcome = outcome;
                break;
            }
            Err(error) => {
                producer_error = Some(error);
                break;
            }
        }
        drop(response);

        if current_end >= end {
            break;
        }
        if !ticket.is_current() {
            producer_outcome = VideoProducerOutcome::Superseded;
            break;
        }
        current_start = current_end.saturating_add(1);
        current_end = end.min(current_start.saturating_add(CONNECTOR_MEDIA_CHUNK_BYTES - 1));
        let chunk_range = format!("bytes={current_start}-{current_end}");
        let next = match send_connector_media_request(
            route,
            Method::GET,
            Some(chunk_range),
            if_range.clone(),
        ) {
            Ok(response) => response,
            Err(error) => {
                producer_error = Some(format!(
                    "Richiesta segmento media al Connector fallita: {error}"
                ));
                break;
            }
        };
        segment_count = segment_count.saturating_add(1);
        if next.status().is_redirection() {
            producer_error = Some(
                "Redirect Connector non consentito durante streaming segmentato.".to_string(),
            );
            break;
        }
        if let Err(error) = validate_segment_response(
            &next,
            current_start,
            current_end,
            total,
            etag.as_deref(),
            last_modified.as_deref(),
        ) {
            producer_error = Some(error);
            break;
        }
        response = next;
    }

    // Let any unfinished response drop when this function returns. We do not
    // drain it: a superseded seek may sacrifice that one TLS connection, but
    // immediately releases bandwidth for the newest useful Range.
    drop(sender);
    let writer_result = writer
        .join()
        .map_err(|_| "Writer video locale terminato in modo inatteso.".to_string())?;

    let outcome = match writer_result {
        Ok(VideoStreamOutcome::Superseded) => VideoStreamOutcome::Superseded,
        Ok(VideoStreamOutcome::ClientDisconnected) => VideoStreamOutcome::ClientDisconnected,
        Ok(VideoStreamOutcome::Complete) => match producer_outcome {
            VideoProducerOutcome::Complete => VideoStreamOutcome::Complete,
            VideoProducerOutcome::Superseded => VideoStreamOutcome::Superseded,
            VideoProducerOutcome::ReceiverClosed => VideoStreamOutcome::ClientDisconnected,
        },
        Err(error) => {
            if let Some(producer_error) = producer_error.as_ref() {
                return Err(format!("{producer_error}; writer locale: {error}"));
            }
            return Err(error);
        }
    };

    log_video_transfer(&ticket, outcome, &stats, segment_count, start, Some(end));

    if let Some(error) = producer_error {
        if matches!(outcome, VideoStreamOutcome::Superseded | VideoStreamOutcome::ClientDisconnected) {
            return Ok(outcome);
        }
        return Err(error);
    }
    Ok(outcome)
}

fn read_limited_line<R: BufRead>(reader: &mut R, target: &mut String, limit: usize) -> Result<(), String> {
    let bytes = reader
        .read_line(target)
        .map_err(|error| format!("Richiesta HTTP locale non leggibile: {error}"))?;
    if bytes == 0 || bytes > limit || target.len() > limit {
        return Err("Richiesta HTTP locale non valida.".to_string());
    }
    Ok(())
}

fn parse_request_line(value: &str) -> Result<(Method, &str), String> {
    let mut parts = value.trim_end().split_whitespace();
    let method = match parts.next() {
        Some("GET") => Method::GET,
        Some("HEAD") => Method::HEAD,
        _ => return Err("Metodo HTTP ponte media non consentito.".to_string()),
    };
    let target = parts
        .next()
        .ok_or_else(|| "Destinazione HTTP ponte media mancante.".to_string())?;
    let version = parts
        .next()
        .ok_or_else(|| "Versione HTTP ponte media mancante.".to_string())?;
    if parts.next().is_some() || !matches!(version, "HTTP/1.1" | "HTTP/1.0") {
        return Err("Richiesta HTTP ponte media non valida.".to_string());
    }
    Ok((method, target))
}

fn bridge_token(target: &str) -> Result<&str, String> {
    let path = target.split('?').next().unwrap_or(target);
    let token = path
        .strip_prefix("/media/")
        .ok_or_else(|| "Percorso ponte media non valido.".to_string())?;
    if token.len() != 43
        || !token
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err("Token ponte media non valido.".to_string());
    }
    Ok(token)
}

fn is_client_disconnect(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        ErrorKind::BrokenPipe | ErrorKind::ConnectionAborted | ErrorKind::ConnectionReset
    )
}

fn is_client_disconnect_message(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    message.contains("os error 10053")
        || message.contains("os error 10054")
        || message.contains("broken pipe")
        || message.contains("connection reset")
        || message.contains("connection aborted")
}

fn write_status_and_headers(stream: &mut TcpStream, response: &reqwest::blocking::Response, keep_alive: bool) -> Result<(), String> {
    let status = response.status();
    let reason = reason_phrase(status.as_u16());
    write!(stream, "HTTP/1.1 {} {}\r\n", status.as_u16(), reason)
        .map_err(|error| format!("Impossibile scrivere la risposta locale: {error}"))?;

    const FORWARDED: &[&str] = &[
        "content-type",
        "content-length",
        "content-range",
        "accept-ranges",
        "content-disposition",
        "cache-control",
        "etag",
        "last-modified",
    ];
    for name in FORWARDED {
        if let Some(value) = response.headers().get(*name).and_then(|value| value.to_str().ok()) {
            write!(stream, "{}: {}\r\n", canonical_header_name(name), value)
                .map_err(|error| format!("Impossibile scrivere gli header media: {error}"))?;
        }
    }
    write!(
        stream,
        "Access-Control-Allow-Origin: {}\r\nAccess-Control-Expose-Headers: {}\r\n{}: {}\r\nConnection: {}\r\n\r\n",
        BRIDGE_CORS_ORIGIN,
        BRIDGE_EXPOSE_HEADERS,
        BRIDGE_HEADER,
        BRIDGE_HEADER_VALUE,
        if keep_alive { "keep-alive" } else { "close" }
    )
    .map_err(|error| format!("Impossibile finalizzare gli header media: {error}"))?;
    Ok(())
}

fn canonical_header_name(name: &str) -> &'static str {
    match name {
        "content-type" => "Content-Type",
        "content-length" => "Content-Length",
        "content-range" => "Content-Range",
        "accept-ranges" => "Accept-Ranges",
        "content-disposition" => "Content-Disposition",
        "cache-control" => "Cache-Control",
        "etag" => "ETag",
        "last-modified" => "Last-Modified",
        _ => "X-Baia-Ignored",
    }
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        206 => "Partial Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        410 => "Gone",
        416 => "Range Not Satisfiable",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "Response",
    }
}

fn write_error(stream: &mut TcpStream, status: u16, reason: &str) -> Result<(), String> {
    let body = format!("{status} {reason}\n");
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: {}\r\nAccess-Control-Expose-Headers: {}\r\n{}: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        BRIDGE_CORS_ORIGIN,
        BRIDGE_EXPOSE_HEADERS,
        BRIDGE_HEADER,
        BRIDGE_HEADER_VALUE,
        body
    )
    .map_err(|error| format!("Impossibile scrivere l'errore del ponte media: {error}"))?;
    stream.flush().ok();
    Ok(())
}

#[tauri::command]
pub fn baia_core_media_bridge_url(
    path: String,
    core_state: State<'_, CoreState>,
    bridge: State<'_, MediaBridge>,
) -> Result<String, String> {
    bridge.register_media_stream(&path, &core_state)
}

#[cfg(test)]
mod tests {
    use super::{
        bridge_token, normalize_media_stream_path, parse_chunkable_range, parse_content_range,
        parse_request_line, ChunkableRange, ParsedContentRange, VideoStreamCoordinator,
        CONNECTOR_MEDIA_CHUNK_BYTES,
    };
    use reqwest::Method;

    #[test]
    fn bridge_accepts_only_allowlisted_stream_paths() {
        assert_eq!(
            normalize_media_stream_path("/api/movies/12/stream").unwrap(),
            "/api/movies/12/stream"
        );
        assert_eq!(
            normalize_media_stream_path("/api/music/tracks/123e4567-e89b-42d3-a456-426614174000/stream").unwrap(),
            "/api/music/tracks/123e4567-e89b-42d3-a456-426614174000/stream"
        );
        assert_eq!(
            normalize_media_stream_path("/api/reading/21/file").unwrap(),
            "/api/reading/21/file"
        );
        assert_eq!(
            normalize_media_stream_path("/api/reading/21/reader/entry/0").unwrap(),
            "/api/reading/21/reader/entry/0"
        );
        assert_eq!(
            normalize_media_stream_path("/api/movies/12/poster").unwrap(),
            "/api/movies/12/poster"
        );
        assert_eq!(
            normalize_media_stream_path("/api/series/123e4567-e89b-42d3-a456-426614174000/poster").unwrap(),
            "/api/series/123e4567-e89b-42d3-a456-426614174000/poster"
        );
        assert_eq!(
            normalize_media_stream_path("/api/music/albums/223e4567-e89b-42d3-a456-426614174000/cover").unwrap(),
            "/api/music/albums/223e4567-e89b-42d3-a456-426614174000/cover"
        );
        assert_eq!(
            normalize_media_stream_path("/api/reading/21/cover").unwrap(),
            "/api/reading/21/cover"
        );
        assert!(normalize_media_stream_path("/api/series/12/stream").is_err());
        assert!(normalize_media_stream_path("/api/series/not-a-uuid/poster").is_err());
        assert!(normalize_media_stream_path("/api/music/tracks/not-a-uuid/stream").is_err());
        assert!(normalize_media_stream_path("/api/music/tracks/123e4567-e89b-42d3-a456-426614174000/file").is_err());
        assert!(normalize_media_stream_path("/api/music/albums/not-a-uuid/cover").is_err());
        assert!(normalize_media_stream_path("/api/reading/21/reader/manifest").is_err());
        assert!(normalize_media_stream_path("/api/reading/21/reader/entry/not-a-number").is_err());
        assert!(normalize_media_stream_path("https://evil.invalid/api/movies/12/stream").is_err());
        assert!(normalize_media_stream_path("/api/movies/../stream").is_err());
        assert!(normalize_media_stream_path("/api/movies/12/stream?x=1").is_err());
        assert!(normalize_media_stream_path("/api/movies/12/poster?v=1").is_err());
    }

    #[test]
    fn bridge_route_exposes_only_an_opaque_token() {
        let token = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq";
        assert_eq!(token.len(), 43);
        assert_eq!(bridge_token(&format!("/media/{token}?_baia_expires=123")).unwrap(), token);
        assert!(bridge_token("/api/movies/12/stream").is_err());
        assert!(bridge_token("/media/not-valid").is_err());
    }

    #[test]
    fn bridge_http_contract_is_get_or_head_only() {
        let (method, target) = parse_request_line("GET /media/token HTTP/1.1\r\n").unwrap();
        assert_eq!(method, Method::GET);
        assert_eq!(target, "/media/token");
        assert_eq!(parse_request_line("HEAD /media/token HTTP/1.1\r\n").unwrap().0, Method::HEAD);
        assert!(parse_request_line("POST /media/token HTTP/1.1\r\n").is_err());
    }

    #[test]
    fn bridge_route_remains_media_only() {
        assert_eq!(crate::connector_tls::MEDIA_PATH, "/baia/v1/media");
        assert!(crate::connector_tls::connector_url(
            "https://192.168.1.50:43127",
            crate::connector_tls::MEDIA_PATH,
        )
        .is_ok());
    }
    #[test]
    fn bridge_chunks_only_large_forward_video_ranges() {
        assert_eq!(
            parse_chunkable_range("bytes=0-"),
            Some(ChunkableRange { start: 0, end: None })
        );
        assert_eq!(
            parse_chunkable_range(&format!("bytes=100-{}", 100 + CONNECTOR_MEDIA_CHUNK_BYTES)),
            Some(ChunkableRange {
                start: 100,
                end: Some(100 + CONNECTOR_MEDIA_CHUNK_BYTES),
            })
        );
        assert_eq!(parse_chunkable_range("bytes=0-1023"), None);
        assert_eq!(parse_chunkable_range("bytes=-1024"), None);
        assert_eq!(parse_chunkable_range("bytes=0-10,20-30"), None);
        assert_eq!(parse_chunkable_range("bytes=20-10"), None);
    }


    #[test]
    fn latest_long_video_range_supersedes_only_the_same_media() {
        let coordinator = std::sync::Arc::new(VideoStreamCoordinator::new());
        let first = coordinator.begin("/api/movies/12/stream").unwrap();
        let other = coordinator.begin("/api/movies/13/stream").unwrap();
        assert!(first.is_current());
        assert!(other.is_current());

        let second = coordinator.begin("/api/movies/12/stream").unwrap();
        assert!(!first.is_current());
        assert!(second.is_current());
        assert!(other.is_current());
    }

    #[test]
    fn bridge_parses_connector_content_range_strictly() {
        assert_eq!(
            parse_content_range("bytes 100-199/1000"),
            Some(ParsedContentRange {
                start: 100,
                end: 199,
                total: 1000,
            })
        );
        assert_eq!(parse_content_range("bytes */1000"), None);
        assert_eq!(parse_content_range("bytes 200-199/1000"), None);
        assert_eq!(parse_content_range("bytes 0-1000/1000"), None);
    }

}
