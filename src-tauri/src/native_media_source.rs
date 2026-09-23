use crate::{auth, connector_tls, core::CoreState};
use reqwest::blocking::{Client, Response};
use serde::Serialize;
use std::{
    collections::HashMap,
    ffi::{c_char, c_void, CStr},
    io::Read,
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use uuid::Uuid;

const PROTOCOL_VERSION: u16 = 1;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(45);
const DEFAULT_READ_AHEAD_BYTES: usize = 4 * 1024 * 1024;
const MIN_READ_AHEAD_BYTES: usize = 256 * 1024;
const MAX_READ_AHEAD_BYTES: usize = 16 * 1024 * 1024;
const READ_AHEAD_ENV: &str = "BAIA_NATIVE_READ_AHEAD_BYTES";
const PROTOCOL: &str = "baia";
const MPV_ERROR_LOADING_FAILED: i32 = -13;
const MPV_ERROR_GENERIC: i64 = -20;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NativeMediaSourceStats {
    pub remote_requests: u64,
    pub bytes_requested: u64,
    pub bytes_received: u64,
    pub bytes_served: u64,
    pub cache_hits: u64,
    pub cache_misses: u64,
    pub seeks: u64,
    pub errors: u64,
    pub last_range_start: Option<u64>,
    pub last_range_end: Option<u64>,
    pub last_range_elapsed_ms: Option<u64>,
    pub read_ahead_bytes: usize,
}

#[derive(Default)]
struct NativeMediaSourceMetrics {
    remote_requests: AtomicU64,
    bytes_requested: AtomicU64,
    bytes_received: AtomicU64,
    bytes_served: AtomicU64,
    cache_hits: AtomicU64,
    cache_misses: AtomicU64,
    seeks: AtomicU64,
    errors: AtomicU64,
    last_range_start: AtomicU64,
    last_range_end: AtomicU64,
    last_range_elapsed_ms: AtomicU64,
    has_last_range: AtomicBool,
}

impl NativeMediaSourceMetrics {
    fn snapshot(&self, read_ahead_bytes: usize) -> NativeMediaSourceStats {
        let has_last_range = self.has_last_range.load(Ordering::Relaxed);
        NativeMediaSourceStats {
            remote_requests: self.remote_requests.load(Ordering::Relaxed),
            bytes_requested: self.bytes_requested.load(Ordering::Relaxed),
            bytes_received: self.bytes_received.load(Ordering::Relaxed),
            bytes_served: self.bytes_served.load(Ordering::Relaxed),
            cache_hits: self.cache_hits.load(Ordering::Relaxed),
            cache_misses: self.cache_misses.load(Ordering::Relaxed),
            seeks: self.seeks.load(Ordering::Relaxed),
            errors: self.errors.load(Ordering::Relaxed),
            last_range_start: has_last_range.then(|| self.last_range_start.load(Ordering::Relaxed)),
            last_range_end: has_last_range.then(|| self.last_range_end.load(Ordering::Relaxed)),
            last_range_elapsed_ms: has_last_range
                .then(|| self.last_range_elapsed_ms.load(Ordering::Relaxed)),
            read_ahead_bytes,
        }
    }
}

#[derive(Clone)]
pub struct NativeMediaSourceTemplate {
    path: String,
    connector_url: String,
    connector_client: Client,
    access_grant: String,
    authorization: auth::MediaAuthorization,
    read_ahead_bytes: usize,
    metrics: Arc<NativeMediaSourceMetrics>,
}

impl NativeMediaSourceTemplate {
    pub fn for_movie(movie_id: u64, state: &CoreState) -> Result<Self, String> {
        if movie_id == 0 {
            return Err("movieId non valido per la sorgente media nativa.".to_string());
        }
        let path = format!("/api/movies/{movie_id}/stream");
        let (connector_endpoint, server_fingerprint) = state.connector_context()?;
        let connector_url =
            connector_tls::connector_url(&connector_endpoint, connector_tls::MEDIA_PATH)?;
        let connector_client = connector_tls::blocking_client(
            &server_fingerprint,
            CONNECT_TIMEOUT,
            Some(REQUEST_TIMEOUT),
        )?;
        let access_grant = state.transport_access_grant()?;
        let authorization = auth::authorize_media_path(&path, state)?;
        Ok(Self {
            path,
            connector_url,
            connector_client,
            access_grant,
            authorization,
            read_ahead_bytes: configured_read_ahead_bytes(),
            metrics: Arc::new(NativeMediaSourceMetrics::default()),
        })
    }

    fn stats(&self) -> NativeMediaSourceStats {
        self.metrics.snapshot(self.read_ahead_bytes)
    }
}

fn configured_read_ahead_bytes() -> usize {
    std::env::var(READ_AHEAD_ENV)
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(DEFAULT_READ_AHEAD_BYTES)
        .clamp(MIN_READ_AHEAD_BYTES, MAX_READ_AHEAD_BYTES)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectorMediaRequest<'a> {
    protocol_version: u16,
    request_id: String,
    method: &'a str,
    path: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    range: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    if_range: Option<String>,
    access_grant: &'a str,
    device_auth: &'a auth::MediaAuthorization,
}

#[derive(Debug, Clone, Copy)]
struct ParsedContentRange {
    start: u64,
    end: u64,
    total: u64,
}

fn parse_content_range(value: &str) -> Option<ParsedContentRange> {
    let value = value.trim().strip_prefix("bytes ")?;
    let (range, total) = value.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    let start = start.parse::<u64>().ok()?;
    let end = end.parse::<u64>().ok()?;
    let total = total.parse::<u64>().ok()?;
    (total > 0 && start <= end && end < total).then_some(ParsedContentRange { start, end, total })
}

struct SourceMetadata {
    size: u64,
    if_range: Option<String>,
}

fn response_header(response: &Response, name: reqwest::header::HeaderName) -> Option<String> {
    response
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

fn request_media(
    template: &NativeMediaSourceTemplate,
    method: &str,
    range: Option<String>,
    if_range: Option<String>,
) -> Result<Response, String> {
    let frame = ConnectorMediaRequest {
        protocol_version: PROTOCOL_VERSION,
        request_id: Uuid::new_v4().to_string(),
        method,
        path: &template.path,
        range,
        if_range,
        access_grant: &template.access_grant,
        device_auth: &template.authorization,
    };
    let mut request = template
        .connector_client
        .post(&template.connector_url)
        .header(reqwest::header::ACCEPT, "*/*");
    // Il protocollo Connector incapsula HEAD dentro un POST. Chiudiamo soltanto
    // questa connessione di metadata per evitare che l'HTTP client provi a
    // riusare una risposta senza body ma con Content-Length del file. I Range
    // GET successivi restano keep-alive e riusano il pool TLS.
    if method == "HEAD" {
        request = request.header(reqwest::header::CONNECTION, "close");
    }
    request
        .json(&frame)
        .send()
        .map_err(|error| format!("Richiesta NativeMediaSource al Connector fallita: {error}"))
}

fn resolve_metadata(template: &NativeMediaSourceTemplate) -> Result<SourceMetadata, String> {
    let response = request_media(template, "HEAD", None, None)?;
    if response.status().is_redirection() || !response.status().is_success() {
        return Err(format!(
            "Il Connector ha rifiutato l'apertura NativeMediaSource con status {}.",
            response.status().as_u16()
        ));
    }
    let size = response
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| "Content-Length media mancante o non valido.".to_string())?;
    let if_range = response_header(&response, reqwest::header::ETAG)
        .or_else(|| response_header(&response, reqwest::header::LAST_MODIFIED));
    Ok(SourceMetadata { size, if_range })
}

struct NativeMediaStream {
    template: NativeMediaSourceTemplate,
    position: u64,
    size: u64,
    if_range: Option<String>,
    cache_start: u64,
    cache: Vec<u8>,
}

impl NativeMediaStream {
    fn open(template: NativeMediaSourceTemplate) -> Result<Self, String> {
        let metadata = resolve_metadata(&template)?;
        eprintln!(
            "native_media_source event=open path={} size={} read_ahead_bytes={}",
            template.path, metadata.size, template.read_ahead_bytes
        );
        Ok(Self {
            template,
            position: 0,
            size: metadata.size,
            if_range: metadata.if_range,
            cache_start: 0,
            cache: Vec::new(),
        })
    }

    fn cached_offset(&self) -> Option<usize> {
        if self.cache.is_empty() || self.position < self.cache_start {
            return None;
        }
        let offset = self.position.saturating_sub(self.cache_start) as usize;
        (offset < self.cache.len()).then_some(offset)
    }

    fn fetch_range(&mut self) -> Result<(), String> {
        if self.position >= self.size {
            self.cache.clear();
            return Ok(());
        }
        let start = self.position;
        let end = start
            .saturating_add(self.template.read_ahead_bytes as u64)
            .saturating_sub(1)
            .min(self.size - 1);
        let expected = end - start + 1;
        let range = format!("bytes={start}-{end}");
        let started = Instant::now();
        self.template
            .metrics
            .remote_requests
            .fetch_add(1, Ordering::Relaxed);
        self.template
            .metrics
            .bytes_requested
            .fetch_add(expected, Ordering::Relaxed);
        self.template.metrics.cache_misses.fetch_add(1, Ordering::Relaxed);

        let response = request_media(
            &self.template,
            "GET",
            Some(range),
            self.if_range.clone(),
        );
        let mut response = match response {
            Ok(value) => value,
            Err(error) => {
                self.template.metrics.errors.fetch_add(1, Ordering::Relaxed);
                return Err(error);
            }
        };

        if response.status().as_u16() != 206 {
            self.template.metrics.errors.fetch_add(1, Ordering::Relaxed);
            return Err(format!(
                "Range NativeMediaSource {}-{} rifiutato: status {}.",
                start,
                end,
                response.status().as_u16()
            ));
        }
        let parsed = response
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|value| value.to_str().ok())
            .and_then(parse_content_range)
            .ok_or_else(|| "Content-Range NativeMediaSource non valido.".to_string())?;
        if parsed.start != start || parsed.end != end || parsed.total != self.size {
            self.template.metrics.errors.fetch_add(1, Ordering::Relaxed);
            return Err(format!(
                "Content-Range NativeMediaSource incoerente: ricevuto {}-{}/{}, atteso {}-{}/{}.",
                parsed.start, parsed.end, parsed.total, start, end, self.size
            ));
        }
        let content_length = response
            .headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .ok_or_else(|| "Content-Length Range NativeMediaSource mancante.".to_string())?;
        if content_length != expected {
            self.template.metrics.errors.fetch_add(1, Ordering::Relaxed);
            return Err(format!(
                "Content-Length NativeMediaSource incoerente: {content_length}, atteso {expected}."
            ));
        }

        let mut bytes = Vec::with_capacity(expected as usize);
        response
            .take(expected.saturating_add(1))
            .read_to_end(&mut bytes)
            .map_err(|error| format!("Lettura Range NativeMediaSource fallita: {error}"))?;
        if bytes.len() as u64 != expected {
            self.template.metrics.errors.fetch_add(1, Ordering::Relaxed);
            return Err(format!(
                "Body Range NativeMediaSource incompleto: {} byte, attesi {expected}.",
                bytes.len()
            ));
        }

        let elapsed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
        self.template
            .metrics
            .bytes_received
            .fetch_add(expected, Ordering::Relaxed);
        self.template.metrics.last_range_start.store(start, Ordering::Relaxed);
        self.template.metrics.last_range_end.store(end, Ordering::Relaxed);
        self.template
            .metrics
            .last_range_elapsed_ms
            .store(elapsed_ms, Ordering::Relaxed);
        self.template.metrics.has_last_range.store(true, Ordering::Relaxed);
        eprintln!(
            "native_media_source event=range start={} end={} bytes={} elapsed_ms={}",
            start, end, expected, elapsed_ms
        );
        self.cache_start = start;
        self.cache = bytes;
        Ok(())
    }

    fn read_into(&mut self, target: &mut [u8], cancelled: &AtomicBool) -> Result<usize, String> {
        if target.is_empty() || self.position >= self.size {
            return Ok(0);
        }
        if cancelled.load(Ordering::Relaxed) {
            return Err("NativeMediaSource cancellata.".to_string());
        }
        if self.cached_offset().is_none() {
            self.fetch_range()?;
        } else {
            self.template.metrics.cache_hits.fetch_add(1, Ordering::Relaxed);
        }
        if cancelled.load(Ordering::Relaxed) {
            return Err("NativeMediaSource cancellata.".to_string());
        }
        let Some(offset) = self.cached_offset() else {
            return Ok(0);
        };
        let available = self.cache.len().saturating_sub(offset);
        let remaining = self.size.saturating_sub(self.position) as usize;
        let count = target.len().min(available).min(remaining);
        target[..count].copy_from_slice(&self.cache[offset..offset + count]);
        self.position = self.position.saturating_add(count as u64);
        self.template
            .metrics
            .bytes_served
            .fetch_add(count as u64, Ordering::Relaxed);
        Ok(count)
    }

    fn seek(&mut self, offset: i64, cancelled: &AtomicBool) -> Result<i64, String> {
        if cancelled.load(Ordering::Relaxed) {
            return Err("NativeMediaSource cancellata.".to_string());
        }
        if offset < 0 || offset as u64 > self.size {
            return Err("Seek NativeMediaSource fuori dal file.".to_string());
        }
        self.position = offset as u64;
        self.template.metrics.seeks.fetch_add(1, Ordering::Relaxed);
        eprintln!("native_media_source event=seek offset={offset}");
        Ok(offset)
    }
}

struct StreamCookie {
    stream: Mutex<NativeMediaStream>,
    cancelled: AtomicBool,
}

#[repr(C)]
pub struct MpvStreamCbInfo {
    cookie: *mut c_void,
    read_fn: Option<unsafe extern "C" fn(*mut c_void, *mut c_char, u64) -> i64>,
    seek_fn: Option<unsafe extern "C" fn(*mut c_void, i64) -> i64>,
    size_fn: Option<unsafe extern "C" fn(*mut c_void) -> i64>,
    close_fn: Option<unsafe extern "C" fn(*mut c_void)>,
    cancel_fn: Option<unsafe extern "C" fn(*mut c_void)>,
}

pub type MpvStreamOpenFn = unsafe extern "C" fn(
    *mut c_void,
    *mut c_char,
    *mut MpvStreamCbInfo,
) -> i32;

pub struct NativeMediaSourceRegistry {
    sources: Mutex<HashMap<String, NativeMediaSourceTemplate>>,
    current_token: Mutex<Option<String>>,
}

impl NativeMediaSourceRegistry {
    pub fn new() -> Self {
        Self {
            sources: Mutex::new(HashMap::new()),
            current_token: Mutex::new(None),
        }
    }

    pub fn register(&self, template: NativeMediaSourceTemplate) -> Result<String, String> {
        let token = Uuid::new_v4().simple().to_string();
        let mut sources = self
            .sources
            .lock()
            .map_err(|_| "Registro NativeMediaSource non disponibile.".to_string())?;
        sources.clear();
        sources.insert(token.clone(), template);
        *self
            .current_token
            .lock()
            .map_err(|_| "Registro NativeMediaSource non disponibile.".to_string())? = Some(token.clone());
        Ok(format!("{PROTOCOL}://movie/{token}"))
    }

    pub fn current_stats(&self) -> Option<NativeMediaSourceStats> {
        let token = self.current_token.lock().ok()?.clone()?;
        let sources = self.sources.lock().ok()?;
        sources.get(&token).map(NativeMediaSourceTemplate::stats)
    }

    fn template_for_uri(&self, uri: &str) -> Option<NativeMediaSourceTemplate> {
        let prefix = format!("{PROTOCOL}://movie/");
        let token = uri.strip_prefix(&prefix)?;
        if token.is_empty()
            || token.len() > 64
            || token.contains('/')
            || token.contains('?')
            || token.contains('#')
            || !token.chars().all(|ch| ch.is_ascii_hexdigit())
        {
            return None;
        }
        self.sources.lock().ok()?.get(token).cloned()
    }
}

impl Default for NativeMediaSourceRegistry {
    fn default() -> Self {
        Self::new()
    }
}

pub fn protocol_name() -> &'static [u8] {
    b"baia\0"
}

pub unsafe extern "C" fn stream_open_callback(
    user_data: *mut c_void,
    uri: *mut c_char,
    info: *mut MpvStreamCbInfo,
) -> i32 {
    let result = catch_unwind(AssertUnwindSafe(|| -> Result<(), String> {
        if user_data.is_null() || uri.is_null() || info.is_null() {
            return Err("Parametri stream callback libmpv non validi.".to_string());
        }
        let registry = &*(user_data as *const NativeMediaSourceRegistry);
        let uri = CStr::from_ptr(uri)
            .to_str()
            .map_err(|_| "URI NativeMediaSource non UTF-8.".to_string())?;
        let template = registry
            .template_for_uri(uri)
            .ok_or_else(|| "URI NativeMediaSource non autorizzata.".to_string())?;
        let stream = NativeMediaStream::open(template)?;
        let cookie = Box::new(StreamCookie {
            stream: Mutex::new(stream),
            cancelled: AtomicBool::new(false),
        });
        (*info).cookie = Box::into_raw(cookie).cast::<c_void>();
        (*info).read_fn = Some(stream_read_callback);
        (*info).seek_fn = Some(stream_seek_callback);
        (*info).size_fn = Some(stream_size_callback);
        (*info).close_fn = Some(stream_close_callback);
        (*info).cancel_fn = Some(stream_cancel_callback);
        Ok(())
    }));
    match result {
        Ok(Ok(())) => 0,
        Ok(Err(error)) => {
            eprintln!("native_media_source event=open_error error={error}");
            MPV_ERROR_LOADING_FAILED
        }
        Err(_) => MPV_ERROR_LOADING_FAILED,
    }
}

unsafe extern "C" fn stream_read_callback(
    cookie: *mut c_void,
    buffer: *mut c_char,
    nbytes: u64,
) -> i64 {
    let result = catch_unwind(AssertUnwindSafe(|| -> Result<i64, String> {
        if cookie.is_null() || (buffer.is_null() && nbytes > 0) {
            return Err("Buffer NativeMediaSource non valido.".to_string());
        }
        let cookie = &*(cookie as *const StreamCookie);
        let length = usize::try_from(nbytes)
            .unwrap_or(usize::MAX)
            .min(MAX_READ_AHEAD_BYTES);
        if length == 0 {
            return Ok(0);
        }
        let target = std::slice::from_raw_parts_mut(buffer.cast::<u8>(), length);
        let mut stream = cookie
            .stream
            .lock()
            .map_err(|_| "Stream NativeMediaSource non disponibile.".to_string())?;
        stream
            .read_into(target, &cookie.cancelled)
            .map(|count| count as i64)
    }));
    match result {
        Ok(Ok(count)) => count,
        Ok(Err(error)) => {
            eprintln!("native_media_source event=read_error error={error}");
            -1
        }
        Err(_) => -1,
    }
}

unsafe extern "C" fn stream_seek_callback(cookie: *mut c_void, offset: i64) -> i64 {
    let result = catch_unwind(AssertUnwindSafe(|| -> Result<i64, String> {
        if cookie.is_null() {
            return Err("Cookie NativeMediaSource non valido.".to_string());
        }
        let cookie = &*(cookie as *const StreamCookie);
        let mut stream = cookie
            .stream
            .lock()
            .map_err(|_| "Stream NativeMediaSource non disponibile.".to_string())?;
        stream.seek(offset, &cookie.cancelled)
    }));
    match result {
        Ok(Ok(offset)) => offset,
        Ok(Err(error)) => {
            eprintln!("native_media_source event=seek_error error={error}");
            MPV_ERROR_GENERIC
        }
        Err(_) => MPV_ERROR_GENERIC,
    }
}

unsafe extern "C" fn stream_size_callback(cookie: *mut c_void) -> i64 {
    let result = catch_unwind(AssertUnwindSafe(|| -> Result<i64, String> {
        if cookie.is_null() {
            return Err("Cookie NativeMediaSource non valido.".to_string());
        }
        let cookie = &*(cookie as *const StreamCookie);
        let stream = cookie
            .stream
            .lock()
            .map_err(|_| "Stream NativeMediaSource non disponibile.".to_string())?;
        i64::try_from(stream.size).map_err(|_| "Media troppo grande per libmpv.".to_string())
    }));
    match result {
        Ok(Ok(size)) => size,
        _ => MPV_ERROR_GENERIC,
    }
}

unsafe extern "C" fn stream_cancel_callback(cookie: *mut c_void) {
    if cookie.is_null() {
        return;
    }
    let cookie = &*(cookie as *const StreamCookie);
    cookie.cancelled.store(true, Ordering::Relaxed);
}

unsafe extern "C" fn stream_close_callback(cookie: *mut c_void) {
    if cookie.is_null() {
        return;
    }
    let _ = catch_unwind(AssertUnwindSafe(|| {
        drop(Box::from_raw(cookie as *mut StreamCookie));
        eprintln!("native_media_source event=close");
    }));
}

#[cfg(test)]
mod tests {
    use super::{configured_read_ahead_bytes, parse_content_range};

    #[test]
    fn parses_content_range() {
        let parsed = parse_content_range("bytes 10-19/100").unwrap();
        assert_eq!((parsed.start, parsed.end, parsed.total), (10, 19, 100));
        assert!(parse_content_range("bytes 20-10/100").is_none());
    }

    #[test]
    fn default_read_ahead_is_bounded() {
        let bytes = configured_read_ahead_bytes();
        assert!(bytes >= 256 * 1024);
        assert!(bytes <= 16 * 1024 * 1024);
    }
}
