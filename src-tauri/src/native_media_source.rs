use crate::{auth, connector_tls, core::CoreState};
use reqwest::blocking::{Client, Response};
use serde::Serialize;
use std::{
    collections::{HashMap, VecDeque},
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

// La NativeMediaSource non deve diventare un secondo player. Questi valori
// servono soltanto ad aggregare i piccoli read() del demuxer in Range bounded.
const INITIAL_RANGE_BYTES: usize = 1 * 1024 * 1024;
const MID_RANGE_BYTES: usize = 2 * 1024 * 1024;
const DEFAULT_MAX_RANGE_BYTES: usize = 4 * 1024 * 1024;
const ABSOLUTE_MAX_RANGE_BYTES: usize = 4 * 1024 * 1024;
const DEFAULT_WINDOW_BYTES: usize = 16 * 1024 * 1024;
const MIN_WINDOW_BYTES: usize = 8 * 1024 * 1024;
const MAX_WINDOW_BYTES: usize = 32 * 1024 * 1024;
const MAX_STREAM_READ_BYTES: usize = 16 * 1024 * 1024;
const MEDIA_POOL_SIZE: usize = 2;

// Manteniamo il nome Phase 3 per compatibilità con eventuali env già impostate:
// ora rappresenta il CAP massimo del Range adattivo, non la dimensione fissa.
const MAX_RANGE_ENV: &str = "BAIA_NATIVE_READ_AHEAD_BYTES";
const WINDOW_ENV: &str = "BAIA_NATIVE_WINDOW_BYTES";
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
    pub cache_seek_hits: u64,
    pub seeks: u64,
    pub errors: u64,
    pub last_range_start: Option<u64>,
    pub last_range_end: Option<u64>,
    pub last_range_elapsed_ms: Option<u64>,
    pub last_range_bytes: Option<u64>,
    pub current_range_bytes: u64,
    pub max_range_bytes: usize,
    pub window_bytes: usize,
    pub current_window_bytes: u64,
    pub generation: u64,
    pub sequential_fetches: u64,
    pub pool_slot_0_requests: u64,
    pub pool_slot_1_requests: u64,
    pub metadata_elapsed_ms: u64,
    pub blocking_fetches: u64,
    pub blocking_fetch_ms_total: u64,
    pub blocking_fetch_ms_max: u64,
    pub range_headers_ms_total: u64,
    pub range_headers_ms_max: u64,
    pub range_body_ms_total: u64,
    pub range_body_ms_max: u64,
    pub range_elapsed_ms_total: u64,
    pub range_elapsed_ms_max: u64,
    pub first_range_headers_ms: u64,
    pub first_range_body_ms: u64,
    pub first_range_elapsed_ms: u64,
    pub slow_ranges_250ms: u64,
    pub slow_ranges_500ms: u64,
    pub slow_ranges_1000ms: u64,
    pub seek_distance_bytes_total: u64,
    pub seek_distance_bytes_max: u64,
}

#[derive(Default)]
struct NativeMediaSourceMetrics {
    remote_requests: AtomicU64,
    bytes_requested: AtomicU64,
    bytes_received: AtomicU64,
    bytes_served: AtomicU64,
    cache_hits: AtomicU64,
    cache_misses: AtomicU64,
    cache_seek_hits: AtomicU64,
    seeks: AtomicU64,
    errors: AtomicU64,
    last_range_start: AtomicU64,
    last_range_end: AtomicU64,
    last_range_elapsed_ms: AtomicU64,
    last_range_bytes: AtomicU64,
    current_range_bytes: AtomicU64,
    current_window_bytes: AtomicU64,
    generation: AtomicU64,
    sequential_fetches: AtomicU64,
    pool_slot_0_requests: AtomicU64,
    pool_slot_1_requests: AtomicU64,
    metadata_elapsed_ms: AtomicU64,
    blocking_fetches: AtomicU64,
    blocking_fetch_ms_total: AtomicU64,
    blocking_fetch_ms_max: AtomicU64,
    range_headers_ms_total: AtomicU64,
    range_headers_ms_max: AtomicU64,
    range_body_ms_total: AtomicU64,
    range_body_ms_max: AtomicU64,
    range_elapsed_ms_total: AtomicU64,
    range_elapsed_ms_max: AtomicU64,
    first_range_headers_ms: AtomicU64,
    first_range_body_ms: AtomicU64,
    first_range_elapsed_ms: AtomicU64,
    slow_ranges_250ms: AtomicU64,
    slow_ranges_500ms: AtomicU64,
    slow_ranges_1000ms: AtomicU64,
    seek_distance_bytes_total: AtomicU64,
    seek_distance_bytes_max: AtomicU64,
    has_last_range: AtomicBool,
}

impl NativeMediaSourceMetrics {
    fn snapshot(&self, max_range_bytes: usize, window_bytes: usize) -> NativeMediaSourceStats {
        let has_last_range = self.has_last_range.load(Ordering::Relaxed);
        NativeMediaSourceStats {
            remote_requests: self.remote_requests.load(Ordering::Relaxed),
            bytes_requested: self.bytes_requested.load(Ordering::Relaxed),
            bytes_received: self.bytes_received.load(Ordering::Relaxed),
            bytes_served: self.bytes_served.load(Ordering::Relaxed),
            cache_hits: self.cache_hits.load(Ordering::Relaxed),
            cache_misses: self.cache_misses.load(Ordering::Relaxed),
            cache_seek_hits: self.cache_seek_hits.load(Ordering::Relaxed),
            seeks: self.seeks.load(Ordering::Relaxed),
            errors: self.errors.load(Ordering::Relaxed),
            last_range_start: has_last_range.then(|| self.last_range_start.load(Ordering::Relaxed)),
            last_range_end: has_last_range.then(|| self.last_range_end.load(Ordering::Relaxed)),
            last_range_elapsed_ms: has_last_range
                .then(|| self.last_range_elapsed_ms.load(Ordering::Relaxed)),
            last_range_bytes: has_last_range.then(|| self.last_range_bytes.load(Ordering::Relaxed)),
            current_range_bytes: self.current_range_bytes.load(Ordering::Relaxed),
            max_range_bytes,
            window_bytes,
            current_window_bytes: self.current_window_bytes.load(Ordering::Relaxed),
            generation: self.generation.load(Ordering::Relaxed),
            sequential_fetches: self.sequential_fetches.load(Ordering::Relaxed),
            pool_slot_0_requests: self.pool_slot_0_requests.load(Ordering::Relaxed),
            pool_slot_1_requests: self.pool_slot_1_requests.load(Ordering::Relaxed),
            metadata_elapsed_ms: self.metadata_elapsed_ms.load(Ordering::Relaxed),
            blocking_fetches: self.blocking_fetches.load(Ordering::Relaxed),
            blocking_fetch_ms_total: self.blocking_fetch_ms_total.load(Ordering::Relaxed),
            blocking_fetch_ms_max: self.blocking_fetch_ms_max.load(Ordering::Relaxed),
            range_headers_ms_total: self.range_headers_ms_total.load(Ordering::Relaxed),
            range_headers_ms_max: self.range_headers_ms_max.load(Ordering::Relaxed),
            range_body_ms_total: self.range_body_ms_total.load(Ordering::Relaxed),
            range_body_ms_max: self.range_body_ms_max.load(Ordering::Relaxed),
            range_elapsed_ms_total: self.range_elapsed_ms_total.load(Ordering::Relaxed),
            range_elapsed_ms_max: self.range_elapsed_ms_max.load(Ordering::Relaxed),
            first_range_headers_ms: self.first_range_headers_ms.load(Ordering::Relaxed),
            first_range_body_ms: self.first_range_body_ms.load(Ordering::Relaxed),
            first_range_elapsed_ms: self.first_range_elapsed_ms.load(Ordering::Relaxed),
            slow_ranges_250ms: self.slow_ranges_250ms.load(Ordering::Relaxed),
            slow_ranges_500ms: self.slow_ranges_500ms.load(Ordering::Relaxed),
            slow_ranges_1000ms: self.slow_ranges_1000ms.load(Ordering::Relaxed),
            seek_distance_bytes_total: self.seek_distance_bytes_total.load(Ordering::Relaxed),
            seek_distance_bytes_max: self.seek_distance_bytes_max.load(Ordering::Relaxed),
        }
    }
}

#[derive(Clone)]
pub struct NativeMediaSourceTemplate {
    path: String,
    connector_url: String,
    metadata_client: Client,
    media_clients: [Client; MEDIA_POOL_SIZE],
    access_grant: String,
    authorization: auth::MediaAuthorization,
    max_range_bytes: usize,
    window_bytes: usize,
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

        // Metadata e body non condividono il pool: la HEAD usa Connection: close,
        // mentre i due client media conservano una TLS persistente ciascuno.
        let metadata_client = connector_tls::blocking_client(
            &server_fingerprint,
            CONNECT_TIMEOUT,
            Some(REQUEST_TIMEOUT),
        )?;
        let media_clients = [
            connector_tls::blocking_media_client(
                &server_fingerprint,
                CONNECT_TIMEOUT,
                Some(REQUEST_TIMEOUT),
            )?,
            connector_tls::blocking_media_client(
                &server_fingerprint,
                CONNECT_TIMEOUT,
                Some(REQUEST_TIMEOUT),
            )?,
        ];
        let access_grant = state.transport_access_grant()?;
        let authorization = auth::authorize_media_path(&path, state)?;
        Ok(Self {
            path,
            connector_url,
            metadata_client,
            media_clients,
            access_grant,
            authorization,
            max_range_bytes: configured_max_range_bytes(),
            window_bytes: configured_window_bytes(),
            metrics: Arc::new(NativeMediaSourceMetrics::default()),
        })
    }

    fn stats(&self) -> NativeMediaSourceStats {
        self.metrics
            .snapshot(self.max_range_bytes, self.window_bytes)
    }
}

fn configured_max_range_bytes() -> usize {
    std::env::var(MAX_RANGE_ENV)
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(DEFAULT_MAX_RANGE_BYTES)
        .clamp(INITIAL_RANGE_BYTES, ABSOLUTE_MAX_RANGE_BYTES)
}

fn configured_window_bytes() -> usize {
    std::env::var(WINDOW_ENV)
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(DEFAULT_WINDOW_BYTES)
        .clamp(MIN_WINDOW_BYTES, MAX_WINDOW_BYTES)
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
    client: &Client,
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
    let mut request = client
        .post(&template.connector_url)
        .header(reqwest::header::ACCEPT, "*/*");
    if method == "HEAD" {
        request = request.header(reqwest::header::CONNECTION, "close");
    }
    request
        .json(&frame)
        .send()
        .map_err(|error| format!("Richiesta NativeMediaSource al Connector fallita: {error}"))
}

fn resolve_metadata(template: &NativeMediaSourceTemplate) -> Result<SourceMetadata, String> {
    let started = Instant::now();
    let response = request_media(template, &template.metadata_client, "HEAD", None, None)?;
    let elapsed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    template
        .metrics
        .metadata_elapsed_ms
        .store(elapsed_ms, Ordering::Relaxed);
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
    cache: VecDeque<u8>,
    generation: u64,
    sequential_fetches: u64,
    next_pool_slot: usize,
}

impl NativeMediaStream {
    fn open(template: NativeMediaSourceTemplate) -> Result<Self, String> {
        let metadata = resolve_metadata(&template)?;
        eprintln!(
            "native_media_source event=open path={} size={} initial_range_bytes={} max_range_bytes={} window_bytes={} pool_size={}",
            template.path,
            metadata.size,
            INITIAL_RANGE_BYTES,
            template.max_range_bytes,
            template.window_bytes,
            MEDIA_POOL_SIZE,
        );
        template
            .metrics
            .current_range_bytes
            .store(INITIAL_RANGE_BYTES as u64, Ordering::Relaxed);
        Ok(Self {
            template,
            position: 0,
            size: metadata.size,
            if_range: metadata.if_range,
            cache_start: 0,
            cache: VecDeque::new(),
            generation: 0,
            sequential_fetches: 0,
            next_pool_slot: 0,
        })
    }

    fn cache_end(&self) -> u64 {
        self.cache_start.saturating_add(self.cache.len() as u64)
    }

    fn cached_offset(&self) -> Option<usize> {
        if self.cache.is_empty() || self.position < self.cache_start || self.position >= self.cache_end() {
            return None;
        }
        Some(self.position.saturating_sub(self.cache_start) as usize)
    }

    fn offset_is_cached(&self, offset: u64) -> bool {
        !self.cache.is_empty() && offset >= self.cache_start && offset < self.cache_end()
    }

    fn next_range_bytes(&self) -> usize {
        let wanted = match self.sequential_fetches {
            0 => INITIAL_RANGE_BYTES,
            1 => MID_RANGE_BYTES,
            _ => self.template.max_range_bytes,
        };
        wanted.min(self.template.max_range_bytes)
    }

    fn replace_or_append_cache(&mut self, start: u64, bytes: Vec<u8>) {
        if self.cache.is_empty() || start != self.cache_end() {
            self.cache.clear();
            self.cache_start = start;
        }
        self.cache.extend(bytes);

        if self.cache.len() > self.template.window_bytes {
            let excess = self.cache.len() - self.template.window_bytes;
            // Durante un fill sequenziale position coincide col vecchio cache_end,
            // quindi tutti i byte prima di position sono sacrificabili. Non
            // eliminiamo mai il byte corrente/futuro necessario a libmpv.
            let safely_droppable = self.position.saturating_sub(self.cache_start) as usize;
            let drop_count = excess.min(safely_droppable);
            if drop_count > 0 {
                drop(self.cache.drain(..drop_count));
                self.cache_start = self.cache_start.saturating_add(drop_count as u64);
            }
        }
        self.template
            .metrics
            .current_window_bytes
            .store(self.cache.len() as u64, Ordering::Relaxed);
    }

    fn fetch_range(&mut self) -> Result<(), String> {
        if self.position >= self.size {
            self.cache.clear();
            self.template
                .metrics
                .current_window_bytes
                .store(0, Ordering::Relaxed);
            return Ok(());
        }

        let start = self.position;
        let range_bytes = self.next_range_bytes();
        let end = start
            .saturating_add(range_bytes as u64)
            .saturating_sub(1)
            .min(self.size - 1);
        let expected = end - start + 1;
        let range = format!("bytes={start}-{end}");
        let pool_slot = self.next_pool_slot;
        self.next_pool_slot = (self.next_pool_slot + 1) % MEDIA_POOL_SIZE;
        let started = Instant::now();

        let request_index = self
            .template
            .metrics
            .remote_requests
            .fetch_add(1, Ordering::Relaxed)
            .saturating_add(1);
        self.template
            .metrics
            .bytes_requested
            .fetch_add(expected, Ordering::Relaxed);
        self.template.metrics.cache_misses.fetch_add(1, Ordering::Relaxed);
        self.template
            .metrics
            .current_range_bytes
            .store(expected, Ordering::Relaxed);
        match pool_slot {
            0 => {
                self.template
                    .metrics
                    .pool_slot_0_requests
                    .fetch_add(1, Ordering::Relaxed);
            }
            _ => {
                self.template
                    .metrics
                    .pool_slot_1_requests
                    .fetch_add(1, Ordering::Relaxed);
            }
        }

        let client = self.template.media_clients[pool_slot].clone();
        let response = request_media(
            &self.template,
            &client,
            "GET",
            Some(range),
            self.if_range.clone(),
        );
        let headers_elapsed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
        self.template
            .metrics
            .range_headers_ms_total
            .fetch_add(headers_elapsed_ms, Ordering::Relaxed);
        self.template
            .metrics
            .range_headers_ms_max
            .fetch_max(headers_elapsed_ms, Ordering::Relaxed);
        let response = match response {
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

        // Importante: consumiamo SEMPRE interamente il Range bounded. In questo
        // modo la connessione HTTP/TLS può tornare nel pool e non viene abortita
        // quando mpv cambia posizione. Il seek successivo partirà da 1 MiB.
        let mut bytes = Vec::with_capacity(expected as usize);
        let body_started = Instant::now();
        response
            .take(expected.saturating_add(1))
            .read_to_end(&mut bytes)
            .map_err(|error| format!("Lettura Range NativeMediaSource fallita: {error}"))?;
        let body_elapsed_ms = body_started.elapsed().as_millis().min(u64::MAX as u128) as u64;
        self.template
            .metrics
            .range_body_ms_total
            .fetch_add(body_elapsed_ms, Ordering::Relaxed);
        self.template
            .metrics
            .range_body_ms_max
            .fetch_max(body_elapsed_ms, Ordering::Relaxed);
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
            .range_elapsed_ms_total
            .fetch_add(elapsed_ms, Ordering::Relaxed);
        self.template
            .metrics
            .range_elapsed_ms_max
            .fetch_max(elapsed_ms, Ordering::Relaxed);
        if request_index == 1 {
            self.template
                .metrics
                .first_range_headers_ms
                .store(headers_elapsed_ms, Ordering::Relaxed);
            self.template
                .metrics
                .first_range_body_ms
                .store(body_elapsed_ms, Ordering::Relaxed);
            self.template
                .metrics
                .first_range_elapsed_ms
                .store(elapsed_ms, Ordering::Relaxed);
        }
        if elapsed_ms >= 250 {
            self.template.metrics.slow_ranges_250ms.fetch_add(1, Ordering::Relaxed);
        }
        if elapsed_ms >= 500 {
            self.template.metrics.slow_ranges_500ms.fetch_add(1, Ordering::Relaxed);
        }
        if elapsed_ms >= 1000 {
            self.template.metrics.slow_ranges_1000ms.fetch_add(1, Ordering::Relaxed);
        }
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
        self.template
            .metrics
            .last_range_bytes
            .store(expected, Ordering::Relaxed);
        self.template.metrics.has_last_range.store(true, Ordering::Relaxed);

        self.replace_or_append_cache(start, bytes);
        self.sequential_fetches = self.sequential_fetches.saturating_add(1);
        self.template
            .metrics
            .sequential_fetches
            .store(self.sequential_fetches, Ordering::Relaxed);

        eprintln!(
            "native_media_source event=range generation={} pool_slot={} requested_start={} requested_end={} requested_bytes={} bytes_received={} headers_ms={} body_ms={} elapsed_ms={} throughput_mib_s={:.2} sequential_fetches={} cache_start={} cache_end={} cache_window_bytes={}",
            self.generation,
            pool_slot,
            start,
            end,
            expected,
            expected,
            headers_elapsed_ms,
            body_elapsed_ms,
            elapsed_ms,
            if elapsed_ms > 0 {
                (expected as f64 / (1024.0 * 1024.0)) / (elapsed_ms as f64 / 1000.0)
            } else {
                0.0
            },
            self.sequential_fetches,
            self.cache_start,
            self.cache_end(),
            self.cache.len(),
        );
        Ok(())
    }

    fn read_into(&mut self, target: &mut [u8]) -> Result<usize, String> {
        if target.is_empty() || self.position >= self.size {
            return Ok(0);
        }
        if self.cached_offset().is_none() {
            let blocked_started = Instant::now();
            self.fetch_range()?;
            let blocked_ms = blocked_started.elapsed().as_millis().min(u64::MAX as u128) as u64;
            self.template.metrics.blocking_fetches.fetch_add(1, Ordering::Relaxed);
            self.template
                .metrics
                .blocking_fetch_ms_total
                .fetch_add(blocked_ms, Ordering::Relaxed);
            self.template
                .metrics
                .blocking_fetch_ms_max
                .fetch_max(blocked_ms, Ordering::Relaxed);
        } else {
            self.template.metrics.cache_hits.fetch_add(1, Ordering::Relaxed);
        }

        let Some(offset) = self.cached_offset() else {
            return Ok(0);
        };
        let available = self.cache.len().saturating_sub(offset);
        let remaining = self.size.saturating_sub(self.position) as usize;
        let count = target.len().min(available).min(remaining);
        let contiguous = self.cache.make_contiguous();
        target[..count].copy_from_slice(&contiguous[offset..offset + count]);
        self.position = self.position.saturating_add(count as u64);
        self.template
            .metrics
            .bytes_served
            .fetch_add(count as u64, Ordering::Relaxed);
        Ok(count)
    }

    fn seek(&mut self, offset: i64) -> Result<i64, String> {
        if offset < 0 || offset as u64 > self.size {
            return Err("Seek NativeMediaSource fuori dal file.".to_string());
        }
        let offset = offset as u64;
        let previous_position = self.position;
        let seek_distance = if offset >= previous_position {
            offset - previous_position
        } else {
            previous_position - offset
        };
        let cache_hit = self.offset_is_cached(offset);
        self.position = offset;
        self.template.metrics.seeks.fetch_add(1, Ordering::Relaxed);
        self.template
            .metrics
            .seek_distance_bytes_total
            .fetch_add(seek_distance, Ordering::Relaxed);
        self.template
            .metrics
            .seek_distance_bytes_max
            .fetch_max(seek_distance, Ordering::Relaxed);

        if cache_hit {
            self.template
                .metrics
                .cache_seek_hits
                .fetch_add(1, Ordering::Relaxed);
        } else {
            self.generation = self.generation.saturating_add(1);
            self.sequential_fetches = 0;
            self.cache.clear();
            self.cache_start = offset;
            self.template
                .metrics
                .generation
                .store(self.generation, Ordering::Relaxed);
            self.template
                .metrics
                .sequential_fetches
                .store(0, Ordering::Relaxed);
            self.template
                .metrics
                .current_range_bytes
                .store(INITIAL_RANGE_BYTES as u64, Ordering::Relaxed);
            self.template
                .metrics
                .current_window_bytes
                .store(0, Ordering::Relaxed);
        }
        eprintln!(
            "native_media_source event=seek offset={} cache_hit={} generation={} next_range_bytes={}",
            offset,
            cache_hit,
            self.generation,
            self.next_range_bytes(),
        );
        Ok(offset as i64)
    }
}

struct StreamCookie {
    stream: Mutex<NativeMediaStream>,
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
        });
        (*info).cookie = Box::into_raw(cookie).cast::<c_void>();
        (*info).read_fn = Some(stream_read_callback);
        (*info).seek_fn = Some(stream_seek_callback);
        (*info).size_fn = Some(stream_size_callback);
        (*info).close_fn = Some(stream_close_callback);

        // Deliberatamente NULL: secondo la stream_cb API di mpv cancel_fn deve
        // interrompere letture/seek correnti E futuri. Per i nostri Range
        // bounded usarlo come "latest seek wins" ricreerebbe il churn V6.
        (*info).cancel_fn = None;
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
            .min(MAX_STREAM_READ_BYTES);
        if length == 0 {
            return Ok(0);
        }
        let target = std::slice::from_raw_parts_mut(buffer.cast::<u8>(), length);
        let mut stream = cookie
            .stream
            .lock()
            .map_err(|_| "Stream NativeMediaSource non disponibile.".to_string())?;
        stream.read_into(target).map(|count| count as i64)
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
        stream.seek(offset)
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

unsafe extern "C" fn stream_close_callback(cookie: *mut c_void) {
    if cookie.is_null() {
        return;
    }
    let _ = catch_unwind(AssertUnwindSafe(|| {
        let cookie = Box::from_raw(cookie as *mut StreamCookie);
        if let Ok(stream) = cookie.stream.lock() {
            let stats = stream.template.stats();
            eprintln!(
                "native_media_source event=close remote_requests={} bytes_requested={} bytes_received={} bytes_served_to_mpv={} cache_hits={} cache_misses={} cache_seek_hits={} seeks={} errors={} generation={} pool_slot_0_requests={} pool_slot_1_requests={} metadata_ms={} blocking_fetches={} blocking_fetch_ms_total={} blocking_fetch_ms_max={} range_headers_ms_total={} range_headers_ms_max={} range_body_ms_total={} range_body_ms_max={} range_elapsed_ms_total={} range_elapsed_ms_max={} first_range_headers_ms={} first_range_body_ms={} first_range_elapsed_ms={} slow_250={} slow_500={} slow_1000={} seek_distance_bytes_total={} seek_distance_bytes_max={}",
                stats.remote_requests,
                stats.bytes_requested,
                stats.bytes_received,
                stats.bytes_served,
                stats.cache_hits,
                stats.cache_misses,
                stats.cache_seek_hits,
                stats.seeks,
                stats.errors,
                stats.generation,
                stats.pool_slot_0_requests,
                stats.pool_slot_1_requests,
                stats.metadata_elapsed_ms,
                stats.blocking_fetches,
                stats.blocking_fetch_ms_total,
                stats.blocking_fetch_ms_max,
                stats.range_headers_ms_total,
                stats.range_headers_ms_max,
                stats.range_body_ms_total,
                stats.range_body_ms_max,
                stats.range_elapsed_ms_total,
                stats.range_elapsed_ms_max,
                stats.first_range_headers_ms,
                stats.first_range_body_ms,
                stats.first_range_elapsed_ms,
                stats.slow_ranges_250ms,
                stats.slow_ranges_500ms,
                stats.slow_ranges_1000ms,
                stats.seek_distance_bytes_total,
                stats.seek_distance_bytes_max,
            );
        }
        drop(cookie);
    }));
}

#[cfg(test)]
mod tests {
    use super::{
        configured_max_range_bytes, configured_window_bytes, parse_content_range,
        ABSOLUTE_MAX_RANGE_BYTES, INITIAL_RANGE_BYTES, MAX_WINDOW_BYTES, MIN_WINDOW_BYTES,
    };

    #[test]
    fn parses_content_range() {
        let parsed = parse_content_range("bytes 10-19/100").unwrap();
        assert_eq!((parsed.start, parsed.end, parsed.total), (10, 19, 100));
        assert!(parse_content_range("bytes 20-10/100").is_none());
    }

    #[test]
    fn adaptive_ranges_are_bounded() {
        let bytes = configured_max_range_bytes();
        assert!(bytes >= INITIAL_RANGE_BYTES);
        assert!(bytes <= ABSOLUTE_MAX_RANGE_BYTES);
    }

    #[test]
    fn sliding_window_is_bounded() {
        let bytes = configured_window_bytes();
        assert!(bytes >= MIN_WINDOW_BYTES);
        assert!(bytes <= MAX_WINDOW_BYTES);
    }
}
