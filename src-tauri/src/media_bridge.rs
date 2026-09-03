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
    io::{BufRead, BufReader, ErrorKind, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
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
const BRIDGE_HEADER: &str = "X-Baia-Media-Bridge";
const BRIDGE_HEADER_VALUE: &str = "media-v1";
const BRIDGE_CORS_ORIGIN: &str = "http://tauri.localhost";
const BRIDGE_EXPOSE_HEADERS: &str = "Accept-Ranges, Content-Length, Content-Range, Content-Type, ETag, Last-Modified";

#[derive(Clone)]
struct BridgeRoute {
    path: String,
    authorization: auth::MediaAuthorization,
    access_grant: String,
    connector_url: String,
    connector_client: Client,
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
            shutdown,
        })
    }

    fn register_media_stream(&self, path: &str, state: &CoreState) -> Result<String, String> {
        let path = normalize_media_stream_path(path)?;
        let (connector_endpoint, server_fingerprint) = state.connector_context()?;
        let connector_url =
            connector_tls::connector_url(&connector_endpoint, connector_tls::MEDIA_PATH)?;
        let connector_client = connector_tls::blocking_client(
            &server_fingerprint,
            CONNECT_TIMEOUT,
            None,
        )
        .map_err(|error| format!("Impossibile inizializzare il trasporto media TLS: {error}"))?;
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
    let _ = stream.set_read_timeout(Some(Duration::from_secs(15)));
    let read_stream = stream
        .try_clone()
        .map_err(|error| format!("Impossibile leggere la richiesta locale: {error}"))?;
    let mut reader = BufReader::new(read_stream);

    let mut request_line = String::new();
    read_limited_line(&mut reader, &mut request_line, MAX_REQUEST_LINE_BYTES)?;
    let (method, target) = parse_request_line(&request_line)?;
    let mut range = None;
    let mut if_range = None;

    for _ in 0..MAX_HEADER_COUNT {
        let mut line = String::new();
        read_limited_line(&mut reader, &mut line, MAX_HEADER_LINE_BYTES)?;
        if line == "\r\n" || line == "\n" || line.is_empty() {
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
                _ => {}
            }
        }
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

    let BridgeRoute {
        path,
        authorization,
        access_grant,
        connector_url,
        connector_client,
        ..
    } = route;
    let frame = ConnectorMediaRequest {
        protocol_version: PROTOCOL_VERSION,
        request_id: Uuid::new_v4().to_string(),
        method: method.as_str().to_string(),
        path,
        range,
        if_range,
        access_grant,
        device_auth: authorization,
    };

    let mut response = match connector_client
        .post(&connector_url)
        .header(reqwest::header::ACCEPT, "*/*")
        .json(&frame)
        .send()
    {
        Ok(response) => response,
        Err(error) => {
            eprintln!("Baia Host Connector media non raggiungibile: {error}");
            return write_error(&mut stream, 502, "Bad Gateway");
        }
    };

    if response.status().is_redirection() {
        return write_error(&mut stream, 502, "Bad Gateway");
    }

    if let Err(error) = write_status_and_headers(&mut stream, &response) {
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
        }
    }
    stream.flush().ok();
    Ok(())
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
    message.contains("os error 10053")
        || message.contains("os error 10054")
        || message.contains("broken pipe")
        || message.contains("connection reset")
        || message.contains("connection aborted")
}

fn write_status_and_headers(stream: &mut TcpStream, response: &reqwest::blocking::Response) -> Result<(), String> {
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
        "Access-Control-Allow-Origin: {}\r\nAccess-Control-Expose-Headers: {}\r\n{}: {}\r\nConnection: close\r\n\r\n",
        BRIDGE_CORS_ORIGIN,
        BRIDGE_EXPOSE_HEADERS,
        BRIDGE_HEADER,
        BRIDGE_HEADER_VALUE
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
    use super::{bridge_token, normalize_media_stream_path, parse_request_line};
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
}
