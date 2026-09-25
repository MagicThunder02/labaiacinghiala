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
        mpsc::{self, Receiver, RecvTimeoutError, Sender, TryRecvError},
        Arc, Mutex,
    },
    thread,
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
const DEFAULT_MAX_RANGE_BYTES: usize = 2 * 1024 * 1024;
const ABSOLUTE_MAX_RANGE_BYTES: usize = 4 * 1024 * 1024;
// Phase 6B.7.2: la vecchia "window" contigua diventa un budget per una cache
// sparsa multi-segmento. Il default da 64 MiB contiene comodamente piu regioni
// calde del demuxer senza buttare via tutto al primo seek fuori intervallo.
const DEFAULT_WINDOW_BYTES: usize = 64 * 1024 * 1024;
const MIN_WINDOW_BYTES: usize = 8 * 1024 * 1024;
const MAX_WINDOW_BYTES: usize = 128 * 1024 * 1024;
const MAX_STREAM_READ_BYTES: usize = 16 * 1024 * 1024;
const MEDIA_POOL_SIZE: usize = 2;
const FOREGROUND_POOL_SLOT: usize = 0;
const PREFETCH_POOL_SLOT: usize = 1;
// Phase 6B.7.1: il passaggio prefetch -> foreground non usa piu un timeout
// fisso che puo duplicare un Range ancora in download. Dopo il budget soft
// continuiamo ad aspettare solo se il prefetch sta facendo progresso reale;
// uno stall o il cap hard fanno invece scattare il fallback sul client #0.
const PREFETCH_WAIT_SOFT_BUDGET: Duration = Duration::from_millis(750);
const PREFETCH_WAIT_HARD_BUDGET: Duration = Duration::from_millis(3000);
const PREFETCH_WAIT_POLL: Duration = Duration::from_millis(100);
const PREFETCH_STALL_BUDGET: Duration = Duration::from_millis(500);
const PREFETCH_BODY_CHUNK_BYTES: usize = 64 * 1024;

// Phase 6B.7.3: il worker di prefetch resta rigorosamente seriale, ma non si
// ferma piu a un solo Range. Quando la profondita forward scende sotto il low
// water, riempie in sequenza fino all'high water senza sovrapporre download.
const DEFAULT_RESERVOIR_LOW_BYTES: usize = 8 * 1024 * 1024;
const DEFAULT_RESERVOIR_HIGH_BYTES: usize = 12 * 1024 * 1024;
const MAX_RESERVOIR_HIGH_BYTES: usize = 32 * 1024 * 1024;

// Manteniamo il nome Phase 3 per compatibilità con eventuali env già impostate:
// ora rappresenta il CAP massimo del Range adattivo, non la dimensione fissa.
const MAX_RANGE_ENV: &str = "BAIA_NATIVE_READ_AHEAD_BYTES";
const WINDOW_ENV: &str = "BAIA_NATIVE_WINDOW_BYTES";
const RESERVOIR_LOW_ENV: &str = "BAIA_NATIVE_RESERVOIR_LOW_BYTES";
const RESERVOIR_HIGH_ENV: &str = "BAIA_NATIVE_RESERVOIR_HIGH_BYTES";
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
    pub reservoir_low_bytes: usize,
    pub reservoir_high_bytes: usize,
    pub current_window_bytes: u64,
    pub reservoir_depth_bytes: u64,
    pub reservoir_depth_peak_bytes: u64,
    pub cache_peak_bytes: u64,
    pub cache_segments: u64,
    pub cache_peak_segments: u64,
    pub cache_evictions: u64,
    pub cache_evicted_bytes: u64,
    pub cache_preserved_miss_bytes: u64,
    pub cache_preserved_miss_segments: u64,
    pub seek_cache_misses: u64,
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
    pub prefetch_requests: u64,
    pub prefetch_hits: u64,
    pub prefetch_waits: u64,
    pub prefetch_wait_ms_total: u64,
    pub prefetch_wait_ms_max: u64,
    pub prefetch_wait_extensions: u64,
    pub prefetch_fallbacks: u64,
    pub prefetch_fallback_stalled: u64,
    pub prefetch_fallback_hard: u64,
    pub prefetch_cancelled: u64,
    pub prefetch_stale_results: u64,
    pub prefetch_errors: u64,
    pub prefetch_bytes_discarded: u64,
    pub reservoir_refills: u64,
    pub reservoir_ranges_scheduled: u64,
    pub reservoir_ranges_completed: u64,
    pub reservoir_bytes_completed: u64,
    pub read_calls: u64,
    pub true_eof_reads: u64,
    pub non_eof_zero_reads_prevented: u64,
    pub non_eof_zero_read_failures: u64,
    pub last_non_eof_zero_position: u64,
    pub last_non_eof_zero_remaining: u64,
    pub last_non_eof_zero_generation: u64,
    pub last_read_position: u64,
    pub last_read_requested: u64,
    pub last_read_returned: u64,
    pub last_read_remaining: u64,
    pub source_size: u64,
    pub seek_to_eof_count: u64,
    pub last_seek_offset: u64,
    pub last_seek_previous_position: u64,
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
    reservoir_depth_bytes: AtomicU64,
    reservoir_depth_peak_bytes: AtomicU64,
    cache_peak_bytes: AtomicU64,
    cache_segments: AtomicU64,
    cache_peak_segments: AtomicU64,
    cache_evictions: AtomicU64,
    cache_evicted_bytes: AtomicU64,
    cache_preserved_miss_bytes: AtomicU64,
    cache_preserved_miss_segments: AtomicU64,
    seek_cache_misses: AtomicU64,
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
    prefetch_requests: AtomicU64,
    prefetch_hits: AtomicU64,
    prefetch_waits: AtomicU64,
    prefetch_wait_ms_total: AtomicU64,
    prefetch_wait_ms_max: AtomicU64,
    prefetch_wait_extensions: AtomicU64,
    prefetch_fallbacks: AtomicU64,
    prefetch_fallback_stalled: AtomicU64,
    prefetch_fallback_hard: AtomicU64,
    prefetch_cancelled: AtomicU64,
    prefetch_stale_results: AtomicU64,
    prefetch_errors: AtomicU64,
    prefetch_bytes_discarded: AtomicU64,
    reservoir_refills: AtomicU64,
    reservoir_ranges_scheduled: AtomicU64,
    reservoir_ranges_completed: AtomicU64,
    reservoir_bytes_completed: AtomicU64,
    read_calls: AtomicU64,
    true_eof_reads: AtomicU64,
    non_eof_zero_reads_prevented: AtomicU64,
    non_eof_zero_read_failures: AtomicU64,
    last_non_eof_zero_position: AtomicU64,
    last_non_eof_zero_remaining: AtomicU64,
    last_non_eof_zero_generation: AtomicU64,
    last_read_position: AtomicU64,
    last_read_requested: AtomicU64,
    last_read_returned: AtomicU64,
    last_read_remaining: AtomicU64,
    source_size: AtomicU64,
    seek_to_eof_count: AtomicU64,
    last_seek_offset: AtomicU64,
    last_seek_previous_position: AtomicU64,
    has_last_range: AtomicBool,
}

impl NativeMediaSourceMetrics {
    fn snapshot(&self, max_range_bytes: usize, window_bytes: usize, reservoir_low_bytes: usize, reservoir_high_bytes: usize) -> NativeMediaSourceStats {
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
            reservoir_low_bytes,
            reservoir_high_bytes,
            current_window_bytes: self.current_window_bytes.load(Ordering::Relaxed),
            reservoir_depth_bytes: self.reservoir_depth_bytes.load(Ordering::Relaxed),
            reservoir_depth_peak_bytes: self.reservoir_depth_peak_bytes.load(Ordering::Relaxed),
            cache_peak_bytes: self.cache_peak_bytes.load(Ordering::Relaxed),
            cache_segments: self.cache_segments.load(Ordering::Relaxed),
            cache_peak_segments: self.cache_peak_segments.load(Ordering::Relaxed),
            cache_evictions: self.cache_evictions.load(Ordering::Relaxed),
            cache_evicted_bytes: self.cache_evicted_bytes.load(Ordering::Relaxed),
            cache_preserved_miss_bytes: self
                .cache_preserved_miss_bytes
                .load(Ordering::Relaxed),
            cache_preserved_miss_segments: self
                .cache_preserved_miss_segments
                .load(Ordering::Relaxed),
            seek_cache_misses: self.seek_cache_misses.load(Ordering::Relaxed),
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
            prefetch_requests: self.prefetch_requests.load(Ordering::Relaxed),
            prefetch_hits: self.prefetch_hits.load(Ordering::Relaxed),
            prefetch_waits: self.prefetch_waits.load(Ordering::Relaxed),
            prefetch_wait_ms_total: self.prefetch_wait_ms_total.load(Ordering::Relaxed),
            prefetch_wait_ms_max: self.prefetch_wait_ms_max.load(Ordering::Relaxed),
            prefetch_wait_extensions: self.prefetch_wait_extensions.load(Ordering::Relaxed),
            prefetch_fallbacks: self.prefetch_fallbacks.load(Ordering::Relaxed),
            prefetch_fallback_stalled: self
                .prefetch_fallback_stalled
                .load(Ordering::Relaxed),
            prefetch_fallback_hard: self.prefetch_fallback_hard.load(Ordering::Relaxed),
            prefetch_cancelled: self.prefetch_cancelled.load(Ordering::Relaxed),
            prefetch_stale_results: self.prefetch_stale_results.load(Ordering::Relaxed),
            prefetch_errors: self.prefetch_errors.load(Ordering::Relaxed),
            prefetch_bytes_discarded: self.prefetch_bytes_discarded.load(Ordering::Relaxed),
            reservoir_refills: self.reservoir_refills.load(Ordering::Relaxed),
            reservoir_ranges_scheduled: self.reservoir_ranges_scheduled.load(Ordering::Relaxed),
            reservoir_ranges_completed: self.reservoir_ranges_completed.load(Ordering::Relaxed),
            reservoir_bytes_completed: self.reservoir_bytes_completed.load(Ordering::Relaxed),
            read_calls: self.read_calls.load(Ordering::Relaxed),
            true_eof_reads: self.true_eof_reads.load(Ordering::Relaxed),
            non_eof_zero_reads_prevented: self
                .non_eof_zero_reads_prevented
                .load(Ordering::Relaxed),
            non_eof_zero_read_failures: self
                .non_eof_zero_read_failures
                .load(Ordering::Relaxed),
            last_non_eof_zero_position: self
                .last_non_eof_zero_position
                .load(Ordering::Relaxed),
            last_non_eof_zero_remaining: self
                .last_non_eof_zero_remaining
                .load(Ordering::Relaxed),
            last_non_eof_zero_generation: self
                .last_non_eof_zero_generation
                .load(Ordering::Relaxed),
            last_read_position: self.last_read_position.load(Ordering::Relaxed),
            last_read_requested: self.last_read_requested.load(Ordering::Relaxed),
            last_read_returned: self.last_read_returned.load(Ordering::Relaxed),
            last_read_remaining: self.last_read_remaining.load(Ordering::Relaxed),
            source_size: self.source_size.load(Ordering::Relaxed),
            seek_to_eof_count: self.seek_to_eof_count.load(Ordering::Relaxed),
            last_seek_offset: self.last_seek_offset.load(Ordering::Relaxed),
            last_seek_previous_position: self
                .last_seek_previous_position
                .load(Ordering::Relaxed),
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
    reservoir_low_bytes: usize,
    reservoir_high_bytes: usize,
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
        // mentre i due client media conservano una TLS persistente ciascuno:
        // slot 0 per i miss foreground, slot 1 dedicato al prefetch asincrono.
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
        let max_range_bytes = configured_max_range_bytes();
        let window_bytes = configured_window_bytes();
        let (reservoir_low_bytes, reservoir_high_bytes) =
            configured_reservoir_bytes(window_bytes, max_range_bytes);
        Ok(Self {
            path,
            connector_url,
            metadata_client,
            media_clients,
            access_grant,
            authorization,
            max_range_bytes,
            window_bytes,
            reservoir_low_bytes,
            reservoir_high_bytes,
            metrics: Arc::new(NativeMediaSourceMetrics::default()),
        })
    }

    fn stats(&self) -> NativeMediaSourceStats {
        self.metrics.snapshot(
            self.max_range_bytes,
            self.window_bytes,
            self.reservoir_low_bytes,
            self.reservoir_high_bytes,
        )
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

fn configured_reservoir_bytes(window_bytes: usize, max_range_bytes: usize) -> (usize, usize) {
    let max_high = MAX_RESERVOIR_HIGH_BYTES
        .min(window_bytes.saturating_div(2).max(max_range_bytes));
    let high = std::env::var(RESERVOIR_HIGH_ENV)
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(DEFAULT_RESERVOIR_HIGH_BYTES)
        .clamp(max_range_bytes, max_high.max(max_range_bytes));
    let low = std::env::var(RESERVOIR_LOW_ENV)
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(DEFAULT_RESERVOIR_LOW_BYTES)
        .clamp(max_range_bytes, high);
    (low, high)
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

#[derive(Debug)]
struct FetchedRange {
    start: u64,
    end: u64,
    bytes: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PrefetchKey {
    id: u64,
    generation: u64,
    start: u64,
}

#[derive(Debug, Clone, Copy)]
struct PrefetchSpan {
    start: u64,
    range_bytes: usize,
}

#[derive(Debug)]
struct PrefetchJob {
    id: u64,
    generation: u64,
    spans: Vec<PrefetchSpan>,
}

enum PrefetchCommand {
    Fetch(PrefetchJob),
    Stop,
}

enum PrefetchOutcome {
    Ready(FetchedRange),
    Cancelled,
    Error(String),
}

struct PrefetchResult {
    key: PrefetchKey,
    outcome: PrefetchOutcome,
    terminal: bool,
}

#[derive(Debug, Clone, Copy, Default)]
struct PrefetchProgressSnapshot {
    start: u64,
    headers_received: bool,
    bytes_received: u64,
    expected_bytes: u64,
}

#[derive(Default)]
struct PrefetchProgress {
    job_id: AtomicU64,
    start: AtomicU64,
    headers_received: AtomicBool,
    bytes_received: AtomicU64,
    expected_bytes: AtomicU64,
}

impl PrefetchProgress {
    fn reset(&self, job_id: u64, start: u64, expected_bytes: u64) {
        self.headers_received.store(false, Ordering::Relaxed);
        self.bytes_received.store(0, Ordering::Relaxed);
        self.expected_bytes.store(expected_bytes, Ordering::Relaxed);
        self.start.store(start, Ordering::Relaxed);
        self.job_id.store(job_id, Ordering::Release);
    }

    fn invalidate(&self) {
        self.job_id.store(0, Ordering::Release);
        self.start.store(0, Ordering::Relaxed);
        self.headers_received.store(false, Ordering::Relaxed);
        self.bytes_received.store(0, Ordering::Relaxed);
        self.expected_bytes.store(0, Ordering::Relaxed);
    }

    fn mark_headers(&self, job_id: u64, expected_bytes: u64) {
        if self.job_id.load(Ordering::Acquire) != job_id {
            return;
        }
        self.expected_bytes.store(expected_bytes, Ordering::Relaxed);
        self.headers_received.store(true, Ordering::Release);
    }

    fn update_bytes(&self, job_id: u64, bytes_received: u64) {
        if self.job_id.load(Ordering::Acquire) == job_id {
            self.bytes_received.store(bytes_received, Ordering::Release);
        }
    }

    fn snapshot(&self, job_id: u64) -> Option<PrefetchProgressSnapshot> {
        if self.job_id.load(Ordering::Acquire) != job_id {
            return None;
        }
        Some(PrefetchProgressSnapshot {
            start: self.start.load(Ordering::Acquire),
            headers_received: self.headers_received.load(Ordering::Acquire),
            bytes_received: self.bytes_received.load(Ordering::Acquire),
            expected_bytes: self.expected_bytes.load(Ordering::Relaxed),
        })
    }
}

enum PrefetchWaitOutcome {
    Ready(Result<FetchedRange, String>),
    Cancelled,
    Stalled(PrefetchProgressSnapshot),
    HardTimeout(PrefetchProgressSnapshot),
}

fn range_bounds(start: u64, range_bytes: usize, size: u64) -> Option<(u64, u64)> {
    if start >= size || range_bytes == 0 {
        return None;
    }
    let end = start
        .saturating_add(range_bytes as u64)
        .saturating_sub(1)
        .min(size - 1);
    Some((end, end - start + 1))
}

fn fetch_range_bytes(
    template: &NativeMediaSourceTemplate,
    client: &Client,
    pool_slot: usize,
    start: u64,
    range_bytes: usize,
    size: u64,
    if_range: Option<String>,
    generation: u64,
    kind: &'static str,
    should_cancel: &dyn Fn() -> bool,
    prefetch_progress: Option<(&PrefetchProgress, u64)>,
) -> Result<Option<FetchedRange>, String> {
    let Some((end, expected)) = range_bounds(start, range_bytes, size) else {
        return Ok(Some(FetchedRange {
            start,
            end: start,
            bytes: Vec::new(),
        }));
    };
    if should_cancel() {
        return Ok(None);
    }

    let range = format!("bytes={start}-{end}");
    let started = Instant::now();
    let request_index = template
        .metrics
        .remote_requests
        .fetch_add(1, Ordering::Relaxed)
        .saturating_add(1);
    template
        .metrics
        .bytes_requested
        .fetch_add(expected, Ordering::Relaxed);
    template
        .metrics
        .current_range_bytes
        .store(expected, Ordering::Relaxed);
    match pool_slot {
        FOREGROUND_POOL_SLOT => {
            template
                .metrics
                .pool_slot_0_requests
                .fetch_add(1, Ordering::Relaxed);
        }
        _ => {
            template
                .metrics
                .pool_slot_1_requests
                .fetch_add(1, Ordering::Relaxed);
        }
    }

    let response = request_media(template, client, "GET", Some(range), if_range);
    let headers_elapsed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    template
        .metrics
        .range_headers_ms_total
        .fetch_add(headers_elapsed_ms, Ordering::Relaxed);
    template
        .metrics
        .range_headers_ms_max
        .fetch_max(headers_elapsed_ms, Ordering::Relaxed);
    let response = match response {
        Ok(value) => value,
        Err(error) => {
            template.metrics.errors.fetch_add(1, Ordering::Relaxed);
            return Err(error);
        }
    };

    if should_cancel() {
        eprintln!(
            "native_media_source event=range_cancelled kind={} generation={} pool_slot={} requested_start={} requested_end={} stage=headers",
            kind, generation, pool_slot, start, end
        );
        return Ok(None);
    }
    if response.status().as_u16() != 206 {
        template.metrics.errors.fetch_add(1, Ordering::Relaxed);
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
    if parsed.start != start || parsed.end != end || parsed.total != size {
        template.metrics.errors.fetch_add(1, Ordering::Relaxed);
        return Err(format!(
            "Content-Range NativeMediaSource incoerente: ricevuto {}-{}/{}, atteso {}-{}/{}.",
            parsed.start, parsed.end, parsed.total, start, end, size
        ));
    }
    let content_length = response
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| "Content-Length Range NativeMediaSource mancante.".to_string())?;
    if content_length != expected {
        template.metrics.errors.fetch_add(1, Ordering::Relaxed);
        return Err(format!(
            "Content-Length NativeMediaSource incoerente: {content_length}, atteso {expected}."
        ));
    }
    if let Some((progress, job_id)) = prefetch_progress {
        progress.mark_headers(job_id, expected);
    }

    let mut reader = response.take(expected.saturating_add(1));
    let mut bytes = Vec::with_capacity(expected as usize);
    let mut scratch = vec![0u8; PREFETCH_BODY_CHUNK_BYTES.min(expected as usize).max(1)];
    let body_started = Instant::now();
    let mut cancelled = false;
    while bytes.len() < expected as usize {
        if should_cancel() {
            cancelled = true;
            break;
        }
        let remaining = expected as usize - bytes.len();
        let wanted = remaining.min(scratch.len());
        let read = reader
            .read(&mut scratch[..wanted])
            .map_err(|error| format!("Lettura Range NativeMediaSource fallita: {error}"))?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&scratch[..read]);
        if let Some((progress, job_id)) = prefetch_progress {
            progress.update_bytes(job_id, bytes.len() as u64);
        }
    }
    let body_elapsed_ms = body_started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    let elapsed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;

    template
        .metrics
        .bytes_received
        .fetch_add(bytes.len() as u64, Ordering::Relaxed);
    template
        .metrics
        .range_body_ms_total
        .fetch_add(body_elapsed_ms, Ordering::Relaxed);
    template
        .metrics
        .range_body_ms_max
        .fetch_max(body_elapsed_ms, Ordering::Relaxed);
    template
        .metrics
        .range_elapsed_ms_total
        .fetch_add(elapsed_ms, Ordering::Relaxed);
    template
        .metrics
        .range_elapsed_ms_max
        .fetch_max(elapsed_ms, Ordering::Relaxed);
    if request_index == 1 {
        template
            .metrics
            .first_range_headers_ms
            .store(headers_elapsed_ms, Ordering::Relaxed);
        template
            .metrics
            .first_range_body_ms
            .store(body_elapsed_ms, Ordering::Relaxed);
        template
            .metrics
            .first_range_elapsed_ms
            .store(elapsed_ms, Ordering::Relaxed);
    }
    if elapsed_ms >= 250 {
        template.metrics.slow_ranges_250ms.fetch_add(1, Ordering::Relaxed);
    }
    if elapsed_ms >= 500 {
        template.metrics.slow_ranges_500ms.fetch_add(1, Ordering::Relaxed);
    }
    if elapsed_ms >= 1000 {
        template.metrics.slow_ranges_1000ms.fetch_add(1, Ordering::Relaxed);
    }

    if cancelled || should_cancel() {
        if kind == "prefetch" {
            template
                .metrics
                .prefetch_bytes_discarded
                .fetch_add(bytes.len() as u64, Ordering::Relaxed);
        }
        eprintln!(
            "native_media_source event=range_cancelled kind={} generation={} pool_slot={} requested_start={} requested_end={} bytes_received={} headers_ms={} body_ms={} elapsed_ms={} stage=body",
            kind,
            generation,
            pool_slot,
            start,
            end,
            bytes.len(),
            headers_elapsed_ms,
            body_elapsed_ms,
            elapsed_ms,
        );
        return Ok(None);
    }
    if bytes.len() as u64 != expected {
        template.metrics.errors.fetch_add(1, Ordering::Relaxed);
        return Err(format!(
            "Body Range NativeMediaSource incompleto: {} byte, attesi {expected}.",
            bytes.len()
        ));
    }

    template.metrics.last_range_start.store(start, Ordering::Relaxed);
    template.metrics.last_range_end.store(end, Ordering::Relaxed);
    template
        .metrics
        .last_range_elapsed_ms
        .store(elapsed_ms, Ordering::Relaxed);
    template
        .metrics
        .last_range_bytes
        .store(expected, Ordering::Relaxed);
    template.metrics.has_last_range.store(true, Ordering::Relaxed);

    eprintln!(
        "native_media_source event=range kind={} generation={} pool_slot={} requested_start={} requested_end={} requested_bytes={} bytes_received={} headers_ms={} body_ms={} elapsed_ms={} throughput_mib_s={:.2}",
        kind,
        generation,
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
    );

    Ok(Some(FetchedRange { start, end, bytes }))
}

struct PrefetchCoordinator {
    command_tx: Sender<PrefetchCommand>,
    result_rx: Receiver<PrefetchResult>,
    active_job_id: Arc<AtomicU64>,
    progress: Arc<PrefetchProgress>,
    shutdown: Arc<AtomicBool>,
    metrics: Arc<NativeMediaSourceMetrics>,
    size: u64,
    next_job_id: u64,
    expected: Vec<PrefetchKey>,
    ready: VecDeque<PrefetchResult>,
}

impl PrefetchCoordinator {
    fn new(
        template: NativeMediaSourceTemplate,
        size: u64,
        if_range: Option<String>,
    ) -> Result<Self, String> {
        let (command_tx, command_rx) = mpsc::channel::<PrefetchCommand>();
        let (result_tx, result_rx) = mpsc::channel::<PrefetchResult>();
        let active_job_id = Arc::new(AtomicU64::new(0));
        let progress = Arc::new(PrefetchProgress::default());
        let shutdown = Arc::new(AtomicBool::new(false));
        let worker_active_job_id = active_job_id.clone();
        let worker_progress = progress.clone();
        let worker_shutdown = shutdown.clone();
        let metrics = template.metrics.clone();

        thread::Builder::new()
            .name("baia-native-prefetch".to_string())
            .spawn(move || {
                let client = template.media_clients[PREFETCH_POOL_SLOT].clone();
                loop {
                    let mut command = match command_rx.recv() {
                        Ok(value) => value,
                        Err(_) => break,
                    };
                    while let Ok(next) = command_rx.try_recv() {
                        command = next;
                    }
                    let PrefetchCommand::Fetch(job) = command else {
                        break;
                    };
                    if worker_shutdown.load(Ordering::Acquire)
                        || worker_active_job_id.load(Ordering::Acquire) != job.id
                        || template.metrics.generation.load(Ordering::Acquire) != job.generation
                    {
                        continue;
                    }

                    let span_count = job.spans.len();
                    for (index, span) in job.spans.into_iter().enumerate() {
                        if worker_shutdown.load(Ordering::Acquire)
                            || worker_active_job_id.load(Ordering::Acquire) != job.id
                            || template.metrics.generation.load(Ordering::Acquire) != job.generation
                        {
                            break;
                        }
                        let key = PrefetchKey {
                            id: job.id,
                            generation: job.generation,
                            start: span.start,
                        };
                        let expected_bytes = range_bounds(span.start, span.range_bytes, size)
                            .map(|(_, expected)| expected)
                            .unwrap_or(0);
                        worker_progress.reset(job.id, span.start, expected_bytes);
                        template
                            .metrics
                            .prefetch_requests
                            .fetch_add(1, Ordering::Relaxed);
                        let should_cancel = || {
                            worker_shutdown.load(Ordering::Acquire)
                                || worker_active_job_id.load(Ordering::Acquire) != job.id
                                || template.metrics.generation.load(Ordering::Acquire)
                                    != job.generation
                        };
                        let outcome = match fetch_range_bytes(
                            &template,
                            &client,
                            PREFETCH_POOL_SLOT,
                            span.start,
                            span.range_bytes,
                            size,
                            if_range.clone(),
                            job.generation,
                            "prefetch",
                            &should_cancel,
                            Some((worker_progress.as_ref(), job.id)),
                        ) {
                            Ok(Some(range)) => {
                                template
                                    .metrics
                                    .reservoir_ranges_completed
                                    .fetch_add(1, Ordering::Relaxed);
                                template
                                    .metrics
                                    .reservoir_bytes_completed
                                    .fetch_add(range.bytes.len() as u64, Ordering::Relaxed);
                                PrefetchOutcome::Ready(range)
                            }
                            Ok(None) => {
                                template
                                    .metrics
                                    .prefetch_cancelled
                                    .fetch_add(1, Ordering::Relaxed);
                                PrefetchOutcome::Cancelled
                            }
                            Err(error) => {
                                template
                                    .metrics
                                    .prefetch_errors
                                    .fetch_add(1, Ordering::Relaxed);
                                PrefetchOutcome::Error(error)
                            }
                        };
                        let success = matches!(&outcome, PrefetchOutcome::Ready(_));
                        let terminal = index + 1 == span_count || !success;
                        if result_tx
                            .send(PrefetchResult {
                                key,
                                outcome,
                                terminal,
                            })
                            .is_err()
                        {
                            return;
                        }
                        if terminal {
                            break;
                        }
                    }
                    if worker_active_job_id.load(Ordering::Acquire) == job.id {
                        worker_progress.invalidate();
                    }
                }
            })
            .map_err(|error| format!("Impossibile avviare il prefetch NativeMediaSource: {error}"))?;

        Ok(Self {
            command_tx,
            result_rx,
            active_job_id,
            progress,
            shutdown,
            metrics,
            size,
            next_job_id: 0,
            expected: Vec::new(),
            ready: VecDeque::new(),
        })
    }

    fn has_pending(&self) -> bool {
        !self.expected.is_empty()
    }

    fn schedule(&mut self, generation: u64, spans: Vec<PrefetchSpan>) -> bool {
        if spans.is_empty() || self.has_pending() {
            return false;
        }
        self.next_job_id = self.next_job_id.saturating_add(1).max(1);
        let job_id = self.next_job_id;
        let expected = spans
            .iter()
            .map(|span| PrefetchKey {
                id: job_id,
                generation,
                start: span.start,
            })
            .collect::<Vec<_>>();
        let scheduled_bytes = spans
            .iter()
            .filter_map(|span| range_bounds(span.start, span.range_bytes, self.size))
            .map(|(_, bytes)| bytes)
            .sum::<u64>();
        let first_start = spans.first().map(|span| span.start).unwrap_or(0);
        let first_expected = spans
            .first()
            .and_then(|span| range_bounds(span.start, span.range_bytes, self.size))
            .map(|(_, bytes)| bytes)
            .unwrap_or(0);
        self.active_job_id.store(job_id, Ordering::Release);
        self.progress.reset(job_id, first_start, first_expected);
        self.expected = expected;
        let span_count = spans.len() as u64;
        if self
            .command_tx
            .send(PrefetchCommand::Fetch(PrefetchJob {
                id: job_id,
                generation,
                spans,
            }))
            .is_err()
        {
            self.progress.invalidate();
            self.expected.clear();
            return false;
        }
        self.metrics
            .reservoir_refills
            .fetch_add(1, Ordering::Relaxed);
        self.metrics
            .reservoir_ranges_scheduled
            .fetch_add(span_count, Ordering::Relaxed);
        eprintln!(
            "native_media_source event=prefetch_schedule_chain generation={} job_id={} spans={} scheduled_bytes={} first_start={}",
            generation, job_id, span_count, scheduled_bytes, first_start
        );
        true
    }

    fn key_matches(key: PrefetchKey, generation: u64, start: u64) -> bool {
        key.generation == generation && key.start == start
    }

    fn expected_for(&self, generation: u64, start: u64) -> bool {
        // Solo il primo span ancora pendente e un handoff attendibile. Se mpv
        // salta direttamente a uno span pianificato piu avanti, quel seek e
        // urgente: la normale generation invalidation deve poter riprioritizzare
        // il worker invece di aspettare tutti i Range precedenti della catena.
        self.expected
            .first()
            .is_some_and(|key| Self::key_matches(*key, generation, start))
    }

    fn expected_contains(&self, key: PrefetchKey) -> bool {
        self.expected.iter().any(|expected| *expected == key)
    }

    fn result_success(result: &PrefetchResult) -> bool {
        matches!(&result.outcome, PrefetchOutcome::Ready(_))
    }

    fn prune_after_terminal_failure(&mut self, result: &PrefetchResult) {
        if result.terminal && !Self::result_success(result) {
            self.expected
                .retain(|key| key.id != result.key.id || *key == result.key);
        }
    }

    fn complete_result(&mut self, result: &PrefetchResult) {
        self.expected.retain(|key| *key != result.key);
        if result.terminal && !Self::result_success(result) {
            self.expected.retain(|key| key.id != result.key.id);
        }
        if !self.expected.iter().any(|key| key.id == result.key.id) {
            self.progress.invalidate();
        }
    }

    fn invalidate(&mut self) {
        self.active_job_id.fetch_add(1, Ordering::AcqRel);
        self.progress.invalidate();
        self.expected.clear();
        while let Some(result) = self.ready.pop_front() {
            self.account_stale_result(result);
        }
        self.drain_stale_results();
    }

    fn account_stale_result(&self, result: PrefetchResult) {
        self.metrics
            .prefetch_stale_results
            .fetch_add(1, Ordering::Relaxed);
        if let PrefetchOutcome::Ready(range) = result.outcome {
            self.metrics
                .prefetch_bytes_discarded
                .fetch_add(range.bytes.len() as u64, Ordering::Relaxed);
        }
    }

    fn buffer_result(&mut self, result: PrefetchResult) {
        if self.expected_contains(result.key) {
            self.prune_after_terminal_failure(&result);
            self.ready.push_back(result);
        } else {
            self.account_stale_result(result);
        }
    }

    fn collect_available(&mut self) {
        loop {
            match self.result_rx.try_recv() {
                Ok(result) => self.buffer_result(result),
                Err(TryRecvError::Empty | TryRecvError::Disconnected) => break,
            }
        }
    }

    fn drain_stale_results(&mut self) {
        loop {
            match self.result_rx.try_recv() {
                Ok(result) => self.account_stale_result(result),
                Err(TryRecvError::Empty | TryRecvError::Disconnected) => break,
            }
        }
    }

    fn take_buffered_result(&mut self, generation: u64, start: u64) -> Option<PrefetchResult> {
        let index = self
            .ready
            .iter()
            .position(|result| Self::key_matches(result.key, generation, start))?;
        self.ready.remove(index)
    }

    fn result_to_wait_outcome(result: PrefetchResult) -> PrefetchWaitOutcome {
        match result.outcome {
            PrefetchOutcome::Ready(range) => PrefetchWaitOutcome::Ready(Ok(range)),
            PrefetchOutcome::Cancelled => PrefetchWaitOutcome::Cancelled,
            PrefetchOutcome::Error(error) => PrefetchWaitOutcome::Ready(Err(error)),
        }
    }

    fn take_ready(
        &mut self,
        generation: u64,
        start: u64,
    ) -> Option<Result<FetchedRange, String>> {
        self.collect_available();
        let result = self.take_buffered_result(generation, start)?;
        self.complete_result(&result);
        match result.outcome {
            PrefetchOutcome::Ready(range) => Some(Ok(range)),
            PrefetchOutcome::Cancelled => None,
            PrefetchOutcome::Error(error) => Some(Err(error)),
        }
    }

    fn drain_ready(&mut self, generation: u64) -> Vec<PrefetchResult> {
        self.collect_available();
        let mut drained = Vec::new();
        let mut retained = VecDeque::new();
        while let Some(result) = self.ready.pop_front() {
            if result.key.generation == generation {
                self.complete_result(&result);
                drained.push(result);
            } else {
                retained.push_back(result);
            }
        }
        self.ready = retained;
        drained
    }

    fn wait_ready_adaptive(&mut self, generation: u64, start: u64) -> PrefetchWaitOutcome {
        self.collect_available();
        if let Some(result) = self.take_buffered_result(generation, start) {
            self.complete_result(&result);
            return Self::result_to_wait_outcome(result);
        }
        let Some(key) = self
            .expected
            .iter()
            .copied()
            .find(|key| Self::key_matches(*key, generation, start))
        else {
            return PrefetchWaitOutcome::Cancelled;
        };
        let wait_started = Instant::now();
        let soft_deadline = wait_started + PREFETCH_WAIT_SOFT_BUDGET;
        let hard_deadline = wait_started + PREFETCH_WAIT_HARD_BUDGET;
        let mut last_progress_at = wait_started;
        let mut last_progress = self.progress.snapshot(key.id).unwrap_or_default();
        let mut extension_accounted = false;

        loop {
            let now = Instant::now();
            if now >= hard_deadline {
                let snapshot = self.progress.snapshot(key.id).unwrap_or(last_progress);
                return PrefetchWaitOutcome::HardTimeout(snapshot);
            }
            let wait_slice = PREFETCH_WAIT_POLL.min(hard_deadline.saturating_duration_since(now));
            match self.result_rx.recv_timeout(wait_slice) {
                Ok(result) => {
                    if Self::key_matches(result.key, generation, start) {
                        self.prune_after_terminal_failure(&result);
                        self.complete_result(&result);
                        return Self::result_to_wait_outcome(result);
                    }
                    self.buffer_result(result);
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return PrefetchWaitOutcome::Cancelled,
            }

            let now = Instant::now();
            let snapshot = self.progress.snapshot(key.id).unwrap_or(last_progress);
            if snapshot.start != last_progress.start
                || snapshot.headers_received != last_progress.headers_received
                || snapshot.bytes_received > last_progress.bytes_received
            {
                last_progress_at = now;
            }
            last_progress = snapshot;

            if now >= soft_deadline {
                let incomplete = snapshot.expected_bytes == 0
                    || snapshot.bytes_received < snapshot.expected_bytes;
                if incomplete
                    && now.saturating_duration_since(last_progress_at) >= PREFETCH_STALL_BUDGET
                {
                    return PrefetchWaitOutcome::Stalled(snapshot);
                }
                if !extension_accounted {
                    extension_accounted = true;
                    self.metrics
                        .prefetch_wait_extensions
                        .fetch_add(1, Ordering::Relaxed);
                    let progress_permille = if snapshot.expected_bytes > 0 {
                        snapshot
                            .bytes_received
                            .saturating_mul(1000)
                            .checked_div(snapshot.expected_bytes)
                            .unwrap_or(0)
                            .min(1000)
                    } else {
                        0
                    };
                    eprintln!(
                        "native_media_source event=prefetch_wait_extend generation={} start={} worker_start={} wait_ms={} headers_received={} bytes_received={} expected_bytes={} progress_permille={}",
                        generation,
                        start,
                        snapshot.start,
                        wait_started.elapsed().as_millis(),
                        snapshot.headers_received,
                        snapshot.bytes_received,
                        snapshot.expected_bytes,
                        progress_permille,
                    );
                }
            }
        }
    }

    fn shutdown(&mut self) {
        if self.shutdown.swap(true, Ordering::AcqRel) {
            return;
        }
        self.invalidate();
        let _ = self.command_tx.send(PrefetchCommand::Stop);
    }
}

impl Drop for PrefetchCoordinator {
    fn drop(&mut self) {
        self.shutdown();
    }
}


#[derive(Debug)]
struct CacheSegment {
    start: u64,
    bytes: Vec<u8>,
    last_touch: u64,
}

impl CacheSegment {
    fn end(&self) -> u64 {
        self.start.saturating_add(self.bytes.len() as u64)
    }

    fn contains(&self, offset: u64) -> bool {
        !self.bytes.is_empty() && offset >= self.start && offset < self.end()
    }
}

#[derive(Debug, Default)]
struct CacheInsertReport {
    inserted_bytes: u64,
    evicted_segments: u64,
    evicted_bytes: u64,
}

// Cache sparsa LRU: i Range restano in segmenti indipendenti. Un miss remoto non
// azzera piu i dati gia residenti; l'eviction avviene soltanto quando il budget
// complessivo viene superato. Questo evita il ping-pong distruttivo osservato
// con file ad alto bitrate/interleaving ampio.
struct SparseRangeCache {
    segments: Vec<CacheSegment>,
    budget_bytes: usize,
    resident_bytes: usize,
    touch_clock: u64,
}

impl SparseRangeCache {
    fn new(budget_bytes: usize) -> Self {
        Self {
            segments: Vec::new(),
            budget_bytes,
            resident_bytes: 0,
            touch_clock: 0,
        }
    }

    fn resident_bytes(&self) -> usize {
        self.resident_bytes
    }

    fn segment_count(&self) -> usize {
        self.segments.len()
    }

    fn is_empty(&self) -> bool {
        self.segments.is_empty()
    }

    fn contains(&self, offset: u64) -> bool {
        self.segments.iter().any(|segment| segment.contains(offset))
    }

    fn segment_bounds_at(&self, offset: u64) -> Option<(u64, u64)> {
        self.segments
            .iter()
            .find(|segment| segment.contains(offset))
            .map(|segment| (segment.start, segment.end()))
    }

    fn next_cached_start_after(&self, offset: u64) -> Option<u64> {
        self.segments
            .iter()
            .filter(|segment| segment.start > offset)
            .map(|segment| segment.start)
            .min()
    }

    fn contiguous_end_from(&self, offset: u64) -> Option<u64> {
        let mut end = self
            .segments
            .iter()
            .find(|segment| segment.contains(offset))?
            .end();
        loop {
            let next_end = self
                .segments
                .iter()
                .filter(|segment| segment.start <= end && segment.end() > end)
                .map(CacheSegment::end)
                .max();
            match next_end {
                Some(value) if value > end => end = value,
                _ => return Some(end),
            }
        }
    }

    fn fetch_bytes_until_cached(&self, start: u64, wanted: usize, size: u64) -> usize {
        if start >= size || wanted == 0 {
            return 0;
        }
        let wanted_end = start.saturating_add(wanted as u64).min(size);
        let bounded_end = self
            .next_cached_start_after(start)
            .map(|next| next.min(wanted_end))
            .unwrap_or(wanted_end);
        bounded_end.saturating_sub(start) as usize
    }

    fn next_touch(&mut self) -> u64 {
        self.touch_clock = self.touch_clock.saturating_add(1).max(1);
        self.touch_clock
    }

    fn read_into(&mut self, position: u64, target: &mut [u8]) -> usize {
        let mut cursor = position;
        let mut written = 0usize;
        while written < target.len() {
            let Some(index) = self
                .segments
                .iter()
                .position(|segment| segment.contains(cursor))
            else {
                break;
            };
            let touch = self.next_touch();
            let segment = &mut self.segments[index];
            segment.last_touch = touch;
            let offset = cursor.saturating_sub(segment.start) as usize;
            let available = segment.bytes.len().saturating_sub(offset);
            if available == 0 {
                break;
            }
            let count = (target.len() - written).min(available);
            target[written..written + count]
                .copy_from_slice(&segment.bytes[offset..offset + count]);
            written += count;
            cursor = cursor.saturating_add(count as u64);
        }
        written
    }

    fn insert(&mut self, start: u64, bytes: Vec<u8>, protected_offset: u64) -> CacheInsertReport {
        if bytes.is_empty() {
            return CacheInsertReport::default();
        }
        let end = start.saturating_add(bytes.len() as u64);
        let overlaps = self
            .segments
            .iter()
            .any(|segment| segment.start < end && segment.end() > start);
        let mut report = CacheInsertReport::default();
        let touch = self.next_touch();

        if !overlaps {
            report.inserted_bytes = bytes.len() as u64;
            self.resident_bytes = self.resident_bytes.saturating_add(bytes.len());
            self.segments.push(CacheSegment {
                start,
                bytes,
                last_touch: touch,
            });
        } else {
            // Conserva i byte gia residenti e inserisce soltanto i gap del Range
            // appena scaricato. In questo modo segmenti vecchi e nuovi possono
            // convivere senza duplicare memoria.
            let mut covered = self
                .segments
                .iter()
                .filter(|segment| segment.start < end && segment.end() > start)
                .map(|segment| (segment.start.max(start), segment.end().min(end)))
                .collect::<Vec<_>>();
            covered.sort_unstable_by_key(|span| span.0);
            let mut cursor = start;
            for (covered_start, covered_end) in covered {
                if covered_start > cursor {
                    let piece_end = covered_start.min(end);
                    let from = cursor.saturating_sub(start) as usize;
                    let to = piece_end.saturating_sub(start) as usize;
                    if to > from {
                        let piece = bytes[from..to].to_vec();
                        report.inserted_bytes = report
                            .inserted_bytes
                            .saturating_add(piece.len() as u64);
                        self.resident_bytes = self.resident_bytes.saturating_add(piece.len());
                        self.segments.push(CacheSegment {
                            start: cursor,
                            bytes: piece,
                            last_touch: touch,
                        });
                    }
                }
                cursor = cursor.max(covered_end);
                if cursor >= end {
                    break;
                }
            }
            if cursor < end {
                let from = cursor.saturating_sub(start) as usize;
                let piece = bytes[from..].to_vec();
                report.inserted_bytes = report
                    .inserted_bytes
                    .saturating_add(piece.len() as u64);
                self.resident_bytes = self.resident_bytes.saturating_add(piece.len());
                self.segments.push(CacheSegment {
                    start: cursor,
                    bytes: piece,
                    last_touch: touch,
                });
            }
        }

        self.segments.sort_unstable_by_key(|segment| segment.start);
        while self.resident_bytes > self.budget_bytes {
            let candidate = self
                .segments
                .iter()
                .enumerate()
                .filter(|(_, segment)| {
                    !segment.contains(protected_offset) && !segment.contains(end)
                })
                .min_by_key(|(_, segment)| segment.last_touch)
                .map(|(index, _)| index);
            let Some(index) = candidate else {
                break;
            };
            let removed = self.segments.remove(index);
            self.resident_bytes = self.resident_bytes.saturating_sub(removed.bytes.len());
            report.evicted_segments = report.evicted_segments.saturating_add(1);
            report.evicted_bytes = report
                .evicted_bytes
                .saturating_add(removed.bytes.len() as u64);
        }
        report
    }
}

struct NativeMediaStream {
    template: NativeMediaSourceTemplate,
    position: u64,
    size: u64,
    if_range: Option<String>,
    cache: SparseRangeCache,
    generation: u64,
    sequential_fetches: u64,
    prefetch: PrefetchCoordinator,
}

impl NativeMediaStream {
    fn open(template: NativeMediaSourceTemplate) -> Result<Self, String> {
        let metadata = resolve_metadata(&template)?;
        eprintln!(
            "native_media_source event=open path={} size={} initial_range_bytes={} max_range_bytes={} window_bytes={} cache_policy=sparse_lru pool_size={} prefetch=true reservoir_policy=serial_low_high reservoir_low_bytes={} reservoir_high_bytes={} foreground_pool_slot={} prefetch_pool_slot={}",
            template.path,
            metadata.size,
            INITIAL_RANGE_BYTES,
            template.max_range_bytes,
            template.window_bytes,
            MEDIA_POOL_SIZE,
            template.reservoir_low_bytes,
            template.reservoir_high_bytes,
            FOREGROUND_POOL_SLOT,
            PREFETCH_POOL_SLOT,
        );
        template
            .metrics
            .source_size
            .store(metadata.size, Ordering::Relaxed);
        template
            .metrics
            .current_range_bytes
            .store(INITIAL_RANGE_BYTES as u64, Ordering::Relaxed);
        let prefetch = PrefetchCoordinator::new(
            template.clone(),
            metadata.size,
            metadata.if_range.clone(),
        )?;
        let cache_budget = template.window_bytes;
        Ok(Self {
            template,
            position: 0,
            size: metadata.size,
            if_range: metadata.if_range,
            cache: SparseRangeCache::new(cache_budget),
            generation: 0,
            sequential_fetches: 0,
            prefetch,
        })
    }

    fn offset_is_cached(&self, offset: u64) -> bool {
        self.cache.contains(offset)
    }

    fn next_range_bytes(&self) -> usize {
        let wanted = match self.sequential_fetches {
            0 => INITIAL_RANGE_BYTES,
            1 => MID_RANGE_BYTES,
            _ => self.template.max_range_bytes,
        };
        wanted.min(self.template.max_range_bytes)
    }

    fn current_forward_depth(&self) -> u64 {
        self.cache
            .contiguous_end_from(self.position)
            .unwrap_or(self.position)
            .saturating_sub(self.position)
    }

    fn publish_cache_metrics(&self) {
        let resident = self.cache.resident_bytes() as u64;
        let segments = self.cache.segment_count() as u64;
        let forward_depth = self.current_forward_depth();
        self.template
            .metrics
            .current_window_bytes
            .store(resident, Ordering::Relaxed);
        self.template
            .metrics
            .cache_peak_bytes
            .fetch_max(resident, Ordering::Relaxed);
        self.template
            .metrics
            .cache_segments
            .store(segments, Ordering::Relaxed);
        self.template
            .metrics
            .cache_peak_segments
            .fetch_max(segments, Ordering::Relaxed);
        self.template
            .metrics
            .reservoir_depth_bytes
            .store(forward_depth, Ordering::Relaxed);
        self.template
            .metrics
            .reservoir_depth_peak_bytes
            .fetch_max(forward_depth, Ordering::Relaxed);
    }

    fn accept_range(&mut self, range: FetchedRange) {
        let range_start = range.start;
        let range_end = range.end;
        let report = self.cache.insert(range_start, range.bytes, self.position);
        if report.evicted_segments > 0 {
            self.template
                .metrics
                .cache_evictions
                .fetch_add(report.evicted_segments, Ordering::Relaxed);
            self.template
                .metrics
                .cache_evicted_bytes
                .fetch_add(report.evicted_bytes, Ordering::Relaxed);
        }
        self.publish_cache_metrics();
        self.sequential_fetches = self.sequential_fetches.saturating_add(1);
        self.template
            .metrics
            .sequential_fetches
            .store(self.sequential_fetches, Ordering::Relaxed);
        let (active_start, active_end) = self
            .cache
            .segment_bounds_at(self.position)
            .unwrap_or((self.position, self.position));
        eprintln!(
            "native_media_source event=range_accept generation={} start={} end={} inserted_bytes={} sequential_fetches={} active_segment_start={} active_segment_end={} cache_resident_bytes={} cache_segments={} reservoir_depth_bytes={} evicted_segments={} evicted_bytes={}",
            self.generation,
            range_start,
            range_end,
            report.inserted_bytes,
            self.sequential_fetches,
            active_start,
            active_end,
            self.cache.resident_bytes(),
            self.cache.segment_count(),
            self.current_forward_depth(),
            report.evicted_segments,
            report.evicted_bytes,
        );
    }

    fn build_reservoir_spans(&self) -> Vec<PrefetchSpan> {
        if self.position >= self.size {
            return Vec::new();
        }
        let target_end = self
            .position
            .saturating_add(self.template.reservoir_high_bytes as u64)
            .min(self.size);
        let mut cursor = self
            .cache
            .contiguous_end_from(self.position)
            .unwrap_or(self.position);
        let mut spans = Vec::new();

        while cursor < target_end {
            if self.cache.contains(cursor) {
                let Some(next) = self.cache.contiguous_end_from(cursor) else {
                    break;
                };
                if next <= cursor {
                    break;
                }
                cursor = next.min(target_end);
                continue;
            }
            let wanted = (target_end.saturating_sub(cursor) as usize)
                .min(self.template.max_range_bytes);
            let range_bytes = self
                .cache
                .fetch_bytes_until_cached(cursor, wanted, self.size);
            if range_bytes == 0 {
                break;
            }
            spans.push(PrefetchSpan {
                start: cursor,
                range_bytes,
            });
            cursor = cursor.saturating_add(range_bytes as u64);
        }
        spans
    }

    fn harvest_prefetch_ready(&mut self) {
        let ready = self.prefetch.drain_ready(self.generation);
        for result in ready {
            match result.outcome {
                PrefetchOutcome::Ready(range) => {
                    let start = range.start;
                    let bytes = range.bytes.len();
                    self.accept_range(range);
                    eprintln!(
                        "native_media_source event=reservoir_harvest generation={} start={} bytes={} cache_resident_bytes={} reservoir_depth_bytes={}",
                        self.generation,
                        start,
                        bytes,
                        self.cache.resident_bytes(),
                        self.current_forward_depth(),
                    );
                }
                PrefetchOutcome::Cancelled => {
                    eprintln!(
                        "native_media_source event=reservoir_chain_cancelled generation={} start={}",
                        self.generation, result.key.start
                    );
                }
                PrefetchOutcome::Error(error) => {
                    eprintln!(
                        "native_media_source event=reservoir_chain_error generation={} start={} error={}",
                        self.generation, result.key.start, error
                    );
                }
            }
        }
        self.publish_cache_metrics();
    }

    fn ensure_forward_reservoir(&mut self) {
        if self.position >= self.size || self.prefetch.has_pending() {
            self.publish_cache_metrics();
            return;
        }
        let depth = self.current_forward_depth();
        self.publish_cache_metrics();
        if depth >= self.template.reservoir_low_bytes as u64 {
            return;
        }
        let spans = self.build_reservoir_spans();
        if spans.is_empty() {
            return;
        }
        let scheduled_bytes = spans
            .iter()
            .map(|span| span.range_bytes as u64)
            .sum::<u64>();
        let span_count = spans.len();
        eprintln!(
            "native_media_source event=reservoir_refill generation={} position={} depth_bytes={} low_bytes={} high_bytes={} spans={} scheduled_bytes={}",
            self.generation,
            self.position,
            depth,
            self.template.reservoir_low_bytes,
            self.template.reservoir_high_bytes,
            span_count,
            scheduled_bytes,
        );
        let _ = self.prefetch.schedule(self.generation, spans);
    }

    fn fetch_foreground(&mut self) -> Result<(), String> {
        if self.position >= self.size {
            return Ok(());
        }
        let start = self.position;
        let wanted = self.next_range_bytes();
        let range_bytes = self.cache.fetch_bytes_until_cached(start, wanted, self.size);
        if range_bytes == 0 {
            return Ok(());
        }
        let client = self.template.media_clients[FOREGROUND_POOL_SLOT].clone();
        let never_cancel = || false;
        let range = fetch_range_bytes(
            &self.template,
            &client,
            FOREGROUND_POOL_SLOT,
            start,
            range_bytes,
            self.size,
            self.if_range.clone(),
            self.generation,
            "foreground",
            &never_cancel,
            None,
        )?
        .ok_or_else(|| "Range foreground NativeMediaSource annullato inaspettatamente.".to_string())?;
        self.accept_range(range);
        Ok(())
    }

    fn fill_missing_range(&mut self) -> Result<bool, String> {
        let start = self.position;
        if let Some(result) = self.prefetch.take_ready(self.generation, start) {
            match result {
                Ok(range) => {
                    self.template
                        .metrics
                        .prefetch_hits
                        .fetch_add(1, Ordering::Relaxed);
                    self.accept_range(range);
                    return Ok(false);
                }
                Err(error) => {
                    eprintln!(
                        "native_media_source event=prefetch_error generation={} start={} fallback=foreground error={}",
                        self.generation, start, error
                    );
                }
            }
        }

        if self.prefetch.expected_for(self.generation, start) {
            self.template
                .metrics
                .prefetch_waits
                .fetch_add(1, Ordering::Relaxed);
            let wait_started = Instant::now();
            let waited = self
                .prefetch
                .wait_ready_adaptive(self.generation, start);
            let wait_ms = wait_started.elapsed().as_millis().min(u64::MAX as u128) as u64;
            self.template
                .metrics
                .prefetch_wait_ms_total
                .fetch_add(wait_ms, Ordering::Relaxed);
            self.template
                .metrics
                .prefetch_wait_ms_max
                .fetch_max(wait_ms, Ordering::Relaxed);
            match waited {
                PrefetchWaitOutcome::Ready(result) => match result {
                    Ok(range) => {
                        self.template
                            .metrics
                            .prefetch_hits
                            .fetch_add(1, Ordering::Relaxed);
                        self.accept_range(range);
                        return Ok(true);
                    }
                    Err(error) => {
                        eprintln!(
                            "native_media_source event=prefetch_error generation={} start={} fallback=foreground error={}",
                            self.generation, start, error
                        );
                    }
                },
                PrefetchWaitOutcome::Cancelled => {
                    eprintln!(
                        "native_media_source event=prefetch_cancelled_before_handoff generation={} start={} wait_ms={} fallback=foreground",
                        self.generation, start, wait_ms
                    );
                }
                PrefetchWaitOutcome::Stalled(progress) => {
                    self.prefetch.invalidate();
                    self.template
                        .metrics
                        .prefetch_fallbacks
                        .fetch_add(1, Ordering::Relaxed);
                    self.template
                        .metrics
                        .prefetch_fallback_stalled
                        .fetch_add(1, Ordering::Relaxed);
                    eprintln!(
                        "native_media_source event=prefetch_timeout reason=stalled generation={} start={} wait_ms={} headers_received={} bytes_received={} expected_bytes={} fallback=foreground",
                        self.generation,
                        start,
                        wait_ms,
                        progress.headers_received,
                        progress.bytes_received,
                        progress.expected_bytes,
                    );
                }
                PrefetchWaitOutcome::HardTimeout(progress) => {
                    self.prefetch.invalidate();
                    self.template
                        .metrics
                        .prefetch_fallbacks
                        .fetch_add(1, Ordering::Relaxed);
                    self.template
                        .metrics
                        .prefetch_fallback_hard
                        .fetch_add(1, Ordering::Relaxed);
                    eprintln!(
                        "native_media_source event=prefetch_timeout reason=hard_cap generation={} start={} wait_ms={} headers_received={} bytes_received={} expected_bytes={} fallback=foreground",
                        self.generation,
                        start,
                        wait_ms,
                        progress.headers_received,
                        progress.bytes_received,
                        progress.expected_bytes,
                    );
                }
            }
        }

        self.fetch_foreground()?;
        Ok(true)
    }

    fn record_read_result(&self, position: u64, requested: usize, returned: usize) {
        self.template.metrics.read_calls.fetch_add(1, Ordering::Relaxed);
        self.template
            .metrics
            .last_read_position
            .store(position, Ordering::Relaxed);
        self.template
            .metrics
            .last_read_requested
            .store(requested as u64, Ordering::Relaxed);
        self.template
            .metrics
            .last_read_returned
            .store(returned as u64, Ordering::Relaxed);
        self.template
            .metrics
            .last_read_remaining
            .store(self.size.saturating_sub(position), Ordering::Relaxed);
    }

    fn force_non_eof_read_recovery(&mut self, position: u64) -> Result<(), String> {
        self.template
            .metrics
            .non_eof_zero_reads_prevented
            .fetch_add(1, Ordering::Relaxed);
        self.template
            .metrics
            .last_non_eof_zero_position
            .store(position, Ordering::Relaxed);
        self.template
            .metrics
            .last_non_eof_zero_remaining
            .store(self.size.saturating_sub(position), Ordering::Relaxed);
        self.template
            .metrics
            .last_non_eof_zero_generation
            .store(self.generation, Ordering::Relaxed);
        let previous_generation = self.generation;
        let resident_bytes = self.cache.resident_bytes();
        let segments = self.cache.segment_count();
        let reservoir_depth = self.current_forward_depth();
        let had_pending_prefetch = self.prefetch.has_pending();

        // Un read da 0 byte prima della size dichiarata sarebbe EOF per mpv.
        // Non deve mai uscire dalla NativeMediaSource: invalidiamo la catena
        // speculativa e forziamo un Range foreground sulla posizione corrente.
        self.prefetch.invalidate();
        self.generation = self.generation.saturating_add(1);
        self.sequential_fetches = 1;
        self.template
            .metrics
            .generation
            .store(self.generation, Ordering::Release);
        self.template
            .metrics
            .sequential_fetches
            .store(self.sequential_fetches, Ordering::Relaxed);
        self.template
            .metrics
            .current_range_bytes
            .store(self.next_range_bytes() as u64, Ordering::Relaxed);

        eprintln!(
            "native_media_source event=non_eof_zero_read_prevented position={} size={} remaining={} previous_generation={} recovery_generation={} cache_resident_bytes={} cache_segments={} reservoir_depth_bytes={} had_pending_prefetch={} action=foreground_refill",
            position,
            self.size,
            self.size.saturating_sub(position),
            previous_generation,
            self.generation,
            resident_bytes,
            segments,
            reservoir_depth,
            had_pending_prefetch,
        );
        self.fetch_foreground()
    }

    fn read_into(&mut self, target: &mut [u8]) -> Result<usize, String> {
        if target.is_empty() {
            return Ok(0);
        }
        if self.position >= self.size {
            let position = self.position;
            self.template
                .metrics
                .true_eof_reads
                .fetch_add(1, Ordering::Relaxed);
            self.record_read_result(position, target.len(), 0);
            return Ok(0);
        }

        let read_position = self.position;

        // I risultati del worker possono contenere piu Range consecutivi: li
        // materializziamo nella sparse cache prima di decidere se il read deve
        // bloccare. Il worker continua comunque a scaricare serialmente anche
        // mentre questi risultati attendono nel canale.
        self.harvest_prefetch_ready();

        if !self.cache.contains(self.position) {
            self.template.metrics.cache_misses.fetch_add(1, Ordering::Relaxed);
            let blocked_started = Instant::now();
            let blocked = self.fill_missing_range()?;
            if blocked {
                let blocked_ms = blocked_started.elapsed().as_millis().min(u64::MAX as u128) as u64;
                self.template
                    .metrics
                    .blocking_fetches
                    .fetch_add(1, Ordering::Relaxed);
                self.template
                    .metrics
                    .blocking_fetch_ms_total
                    .fetch_add(blocked_ms, Ordering::Relaxed);
                self.template
                    .metrics
                    .blocking_fetch_ms_max
                    .fetch_max(blocked_ms, Ordering::Relaxed);
            }
        } else {
            self.template.metrics.cache_hits.fetch_add(1, Ordering::Relaxed);
        }

        let remaining = self.size.saturating_sub(self.position) as usize;
        let wanted = target.len().min(remaining);
        let mut count = self.cache.read_into(self.position, &mut target[..wanted]);

        if count == 0 && self.position < self.size {
            let recovery_position = self.position;
            self.force_non_eof_read_recovery(recovery_position)?;
            count = self
                .cache
                .read_into(self.position, &mut target[..wanted]);
            if count == 0 {
                self.template
                    .metrics
                    .non_eof_zero_read_failures
                    .fetch_add(1, Ordering::Relaxed);
                self.template.metrics.errors.fetch_add(1, Ordering::Relaxed);
                self.record_read_result(read_position, wanted, 0);
                return Err(format!(
                    "NativeMediaSource non puo restituire EOF a offset {recovery_position} prima della size {}.",
                    self.size
                ));
            }
        }

        self.position = self.position.saturating_add(count as u64);
        self.template
            .metrics
            .bytes_served
            .fetch_add(count as u64, Ordering::Relaxed);
        self.record_read_result(read_position, wanted, count);

        self.harvest_prefetch_ready();
        self.ensure_forward_reservoir();
        Ok(count)
    }

    fn seek(&mut self, offset: i64) -> Result<i64, String> {
        if offset < 0 || offset as u64 > self.size {
            return Err("Seek NativeMediaSource fuori dal file.".to_string());
        }
        self.harvest_prefetch_ready();
        let offset = offset as u64;
        let previous_position = self.position;
        let seek_distance = if offset >= previous_position {
            offset - previous_position
        } else {
            previous_position - offset
        };
        let eof_seek = offset == self.size;
        self.template
            .metrics
            .last_seek_offset
            .store(offset, Ordering::Relaxed);
        self.template
            .metrics
            .last_seek_previous_position
            .store(previous_position, Ordering::Relaxed);
        if eof_seek {
            self.template
                .metrics
                .seek_to_eof_count
                .fetch_add(1, Ordering::Relaxed);
        }
        let cache_hit = self.offset_is_cached(offset);
        let initial_seek = self.generation == 0
            && self.cache.is_empty()
            && previous_position == 0
            && offset == 0;
        let prefetch_match = !cache_hit && self.prefetch.expected_for(self.generation, offset);
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
        } else if !eof_seek {
            self.template
                .metrics
                .seek_cache_misses
                .fetch_add(1, Ordering::Relaxed);
            let preserved_bytes = self.cache.resident_bytes() as u64;
            let preserved_segments = self.cache.segment_count() as u64;
            self.template
                .metrics
                .cache_preserved_miss_bytes
                .fetch_add(preserved_bytes, Ordering::Relaxed);
            self.template
                .metrics
                .cache_preserved_miss_segments
                .fetch_add(preserved_segments, Ordering::Relaxed);

            if !prefetch_match {
                self.generation = self.generation.saturating_add(1);
                // Solo l'apertura iniziale usa 1 MiB. Dopo un vero random miss
                // ripartiamo subito dal Range stabile da 2 MiB invece di
                // degradare a una raffica di richieste da 1 MiB.
                self.sequential_fetches = if initial_seek { 0 } else { 1 };
                self.prefetch.invalidate();
                self.template
                    .metrics
                    .generation
                    .store(self.generation, Ordering::Release);
                self.template
                    .metrics
                    .sequential_fetches
                    .store(self.sequential_fetches, Ordering::Relaxed);
                self.template
                    .metrics
                    .current_range_bytes
                    .store(self.next_range_bytes() as u64, Ordering::Relaxed);
            }
            self.publish_cache_metrics();
            eprintln!(
                "native_media_source event=sparse_cache_miss offset={} previous_position={} seek_distance={} generation={} preserved_bytes={} preserved_segments={} prefetch_match={} next_range_bytes={}",
                offset,
                previous_position,
                seek_distance,
                self.generation,
                preserved_bytes,
                preserved_segments,
                prefetch_match,
                self.next_range_bytes(),
            );
        }
        eprintln!(
            "native_media_source event=seek offset={} cache_hit={} generation={} next_range_bytes={} prefetch_invalidated={} cache_policy=sparse_lru cache_resident_bytes={} cache_segments={}",
            offset,
            cache_hit,
            self.generation,
            self.next_range_bytes(),
            !cache_hit && !eof_seek && !prefetch_match,
            self.cache.resident_bytes(),
            self.cache.segment_count(),
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
                "native_media_source event=close remote_requests={} bytes_requested={} bytes_received={} bytes_served_to_mpv={} cache_hits={} cache_misses={} cache_seek_hits={} seek_cache_misses={} seeks={} errors={} generation={} cache_peak_bytes={} cache_segments={} cache_peak_segments={} cache_evictions={} cache_evicted_bytes={} cache_preserved_miss_bytes={} cache_preserved_miss_segments={} reservoir_low_bytes={} reservoir_high_bytes={} reservoir_depth_bytes={} reservoir_depth_peak_bytes={} reservoir_refills={} reservoir_ranges_scheduled={} reservoir_ranges_completed={} reservoir_bytes_completed={} read_calls={} true_eof_reads={} non_eof_zero_reads_prevented={} non_eof_zero_read_failures={} last_non_eof_zero_position={} last_non_eof_zero_remaining={} last_non_eof_zero_generation={} last_read_position={} last_read_requested={} last_read_returned={} last_read_remaining={} source_size={} seek_to_eof_count={} last_seek_offset={} last_seek_previous_position={} pool_slot_0_requests={} pool_slot_1_requests={} metadata_ms={} blocking_fetches={} blocking_fetch_ms_total={} blocking_fetch_ms_max={} range_headers_ms_total={} range_headers_ms_max={} range_body_ms_total={} range_body_ms_max={} range_elapsed_ms_total={} range_elapsed_ms_max={} first_range_headers_ms={} first_range_body_ms={} first_range_elapsed_ms={} slow_250={} slow_500={} slow_1000={} seek_distance_bytes_total={} seek_distance_bytes_max={} prefetch_requests={} prefetch_hits={} prefetch_waits={} prefetch_wait_ms_total={} prefetch_wait_ms_max={} prefetch_wait_extensions={} prefetch_fallbacks={} prefetch_fallback_stalled={} prefetch_fallback_hard={} prefetch_cancelled={} prefetch_stale_results={} prefetch_errors={} prefetch_bytes_discarded={}",
                stats.remote_requests,
                stats.bytes_requested,
                stats.bytes_received,
                stats.bytes_served,
                stats.cache_hits,
                stats.cache_misses,
                stats.cache_seek_hits,
                stats.seek_cache_misses,
                stats.seeks,
                stats.errors,
                stats.generation,
                stats.cache_peak_bytes,
                stats.cache_segments,
                stats.cache_peak_segments,
                stats.cache_evictions,
                stats.cache_evicted_bytes,
                stats.cache_preserved_miss_bytes,
                stats.cache_preserved_miss_segments,
                stats.reservoir_low_bytes,
                stats.reservoir_high_bytes,
                stats.reservoir_depth_bytes,
                stats.reservoir_depth_peak_bytes,
                stats.reservoir_refills,
                stats.reservoir_ranges_scheduled,
                stats.reservoir_ranges_completed,
                stats.reservoir_bytes_completed,
                stats.read_calls,
                stats.true_eof_reads,
                stats.non_eof_zero_reads_prevented,
                stats.non_eof_zero_read_failures,
                stats.last_non_eof_zero_position,
                stats.last_non_eof_zero_remaining,
                stats.last_non_eof_zero_generation,
                stats.last_read_position,
                stats.last_read_requested,
                stats.last_read_returned,
                stats.last_read_remaining,
                stats.source_size,
                stats.seek_to_eof_count,
                stats.last_seek_offset,
                stats.last_seek_previous_position,
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
                stats.prefetch_requests,
                stats.prefetch_hits,
                stats.prefetch_waits,
                stats.prefetch_wait_ms_total,
                stats.prefetch_wait_ms_max,
                stats.prefetch_wait_extensions,
                stats.prefetch_fallbacks,
                stats.prefetch_fallback_stalled,
                stats.prefetch_fallback_hard,
                stats.prefetch_cancelled,
                stats.prefetch_stale_results,
                stats.prefetch_errors,
                stats.prefetch_bytes_discarded,
            );
        }
        drop(cookie);
    }));
}

#[cfg(test)]
mod tests {
    use super::{
        configured_max_range_bytes, configured_window_bytes, parse_content_range,
        ABSOLUTE_MAX_RANGE_BYTES, DEFAULT_MAX_RANGE_BYTES, DEFAULT_RESERVOIR_HIGH_BYTES,
        DEFAULT_RESERVOIR_LOW_BYTES, DEFAULT_WINDOW_BYTES, FOREGROUND_POOL_SLOT,
        INITIAL_RANGE_BYTES, MAX_RESERVOIR_HIGH_BYTES, MAX_WINDOW_BYTES, MEDIA_POOL_SIZE,
        MID_RANGE_BYTES, MIN_WINDOW_BYTES, PREFETCH_POOL_SLOT, PREFETCH_STALL_BUDGET,
        PREFETCH_WAIT_HARD_BUDGET, PREFETCH_WAIT_SOFT_BUDGET, SparseRangeCache,
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

    #[test]
    fn phase6b7_defaults_to_two_mib_and_reserves_the_second_pool_for_prefetch() {
        assert_eq!(DEFAULT_MAX_RANGE_BYTES, MID_RANGE_BYTES);
        assert_eq!(MEDIA_POOL_SIZE, 2);
        assert_eq!(FOREGROUND_POOL_SLOT, 0);
        assert_eq!(PREFETCH_POOL_SLOT, 1);
    }

    #[test]
    fn phase6b71_progress_aware_handoff_keeps_a_bounded_hard_cap() {
        assert!(PREFETCH_WAIT_SOFT_BUDGET < PREFETCH_WAIT_HARD_BUDGET);
        assert!(PREFETCH_STALL_BUDGET < PREFETCH_WAIT_HARD_BUDGET);
    }

    #[test]
    fn phase6b72_sparse_cache_preserves_old_segments_across_random_insertions() {
        let mut cache = SparseRangeCache::new(8 * 1024 * 1024);
        let first = vec![1u8; 1024];
        let second = vec![2u8; 1024];
        let first_report = cache.insert(0, first, 0);
        let second_report = cache.insert(4 * 1024 * 1024, second, 4 * 1024 * 1024);
        assert_eq!(first_report.evicted_segments, 0);
        assert_eq!(second_report.evicted_segments, 0);
        assert!(cache.contains(0));
        assert!(cache.contains(4 * 1024 * 1024));
        assert_eq!(cache.segment_count(), 2);
    }

    #[test]
    fn phase6b72_sparse_cache_uses_lru_eviction_instead_of_full_clear() {
        let mut cache = SparseRangeCache::new(3 * 1024);
        cache.insert(0, vec![1u8; 1024], 0);
        cache.insert(4096, vec![2u8; 1024], 4096);
        let mut scratch = [0u8; 16];
        let scratch_len = scratch.len();
        assert_eq!(cache.read_into(0, &mut scratch), scratch_len);
        cache.insert(8192, vec![3u8; 2048], 8192);
        assert!(cache.contains(0));
        assert!(cache.contains(8192));
        assert!(!cache.contains(4096));
        assert!(cache.resident_bytes() <= 3 * 1024);
    }

    #[test]
    fn phase6b72_sparse_cache_default_budget_is_sixty_four_mib() {
        assert_eq!(DEFAULT_WINDOW_BYTES, 64 * 1024 * 1024);
        assert!(MAX_WINDOW_BYTES >= DEFAULT_WINDOW_BYTES);
    }

    #[test]
    fn phase6b72_fetch_stops_before_an_already_cached_segment() {
        let mut cache = SparseRangeCache::new(16 * 1024);
        cache.insert(4096, vec![7u8; 1024], 4096);
        assert_eq!(cache.fetch_bytes_until_cached(0, 8192, 16384), 4096);
    }
    #[test]
    fn phase6b73_forward_reservoir_has_bounded_hysteresis() {
        assert!(DEFAULT_RESERVOIR_LOW_BYTES >= DEFAULT_MAX_RANGE_BYTES);
        assert!(DEFAULT_RESERVOIR_LOW_BYTES < DEFAULT_RESERVOIR_HIGH_BYTES);
        assert!(DEFAULT_RESERVOIR_HIGH_BYTES <= DEFAULT_WINDOW_BYTES / 2);
        assert!(DEFAULT_RESERVOIR_HIGH_BYTES <= MAX_RESERVOIR_HIGH_BYTES);
    }

}
