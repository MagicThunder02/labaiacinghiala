mod access_grant;
mod relay_transport;
mod server_identity;
mod tls;

use reqwest::{blocking::{Body, Client}, redirect::Policy, Method};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap},
    io::{self, BufRead, BufReader, ErrorKind, Read, Write},
    env,
    net::{IpAddr, Ipv4Addr, SocketAddrV4, TcpListener, TcpStream},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use url::Url;
use uuid::Uuid;

const PROTOCOL_VERSION: u16 = 1;
const DEFAULT_BIND_IP: &str = "127.0.0.1";
const CONNECTOR_PORT: u16 = 43127;
const BIND_IP_ENV: &str = "BAIA_CONNECTOR_BIND_IP";
const UPSTREAM_BASE_URL: &str = "http://127.0.0.1:3000";
const HEALTH_PATH: &str = "/baia/v1/health";
const REQUEST_PATH: &str = "/baia/v1/request";
const MEDIA_PATH: &str = "/baia/v1/media";
const PAIRING_PATH: &str = "/baia/v1/pairing";
const UPLOAD_PATH: &str = "/baia/v1/upload";
const NODE_PAIRING_PATH: &str = "/api/pairing/redeem";
const MAX_HTTP_HEADERS_BYTES: usize = 32 * 1024;
const MAX_FRAME_BYTES: usize = 3 * 1024 * 1024;
const MAX_API_BODY_BYTES: usize = 2 * 1024 * 1024;
const MAX_API_RESPONSE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_PAIRING_RESPONSE_BYTES: u64 = 64 * 1024;
const MAX_UPLOAD_RESPONSE_BYTES: u64 = 1024 * 1024;
const MAX_UPLOAD_BODY_BYTES: u64 = 512 * 1024 * 1024 * 1024;
const MAX_PAIRING_TOKEN_BYTES: usize = 4096;
const MAX_PAIRING_PROOF_BYTES: usize = 4096;
const MAX_DEVICE_NAME_CHARS: usize = 80;
const MAX_HTTP_HEADER_COUNT: usize = 64;
const MAX_HTTP_LINE_BYTES: usize = 8 * 1024;
const MAX_MEDIA_FRAME_BYTES: usize = 64 * 1024;
const MAX_PAIRING_FRAME_BYTES: usize = 32 * 1024;
const TLS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(8);
const HTTP_HEAD_TIMEOUT: Duration = Duration::from_secs(12);
const CLIENT_READ_TIMEOUT: Duration = Duration::from_secs(130);
const CLIENT_WRITE_TIMEOUT: Duration = Duration::from_secs(130);
const MAX_ACTIVE_CONNECTIONS: usize = 128;
const MAX_ACTIVE_CONNECTIONS_PER_IP: usize = 16;
const CONNECTION_START_WINDOW: Duration = Duration::from_secs(10);
const MAX_CONNECTION_STARTS_PER_WINDOW: usize = 256;
const UPSTREAM_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const UPSTREAM_REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const UPSTREAM_UPLOAD_REQUEST_TIMEOUT: Option<Duration> = None;
const ALLOWED_APPLICATION_HEADERS: &[&str] = &["accept", "content-type"];
const EXPOSED_RESPONSE_HEADERS: &[&str] = &[
    "content-type",
    "content-length",
    "cache-control",
    "etag",
    "last-modified",
    "retry-after",
];
const MEDIA_RESPONSE_HEADERS: &[&str] = &[
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "content-disposition",
    "cache-control",
    "etag",
    "last-modified",
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConnectorRequest {
    protocol_version: u16,
    request_id: String,
    method: String,
    path: String,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    #[serde(default)]
    body: Option<String>,
    access_grant: String,
    device_auth: DeviceAuthorization,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeviceAuthorization {
    device_id: String,
    timestamp: u64,
    nonce: String,
    signature: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectorResponse {
    protocol_version: u16,
    request_id: String,
    status: u16,
    headers: BTreeMap<String, String>,
    body: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectorErrorResponse<'a> {
    protocol_version: u16,
    request_id: Option<&'a str>,
    error_code: &'a str,
    message: &'a str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    protocol_version: u16,
    connector_version: &'static str,
    status: &'static str,
    upstream: &'static str,
    node_reachable: bool,
}

struct ConnectorClients {
    api: Client,
    media: Client,
    upload: Client,
}

struct ConnectionCounts {
    total: usize,
    per_ip: HashMap<IpAddr, usize>,
    start_window_started: Instant,
    starts_in_window: usize,
}

struct ConnectionLimiter {
    counts: Mutex<ConnectionCounts>,
}

impl ConnectionLimiter {
    fn new() -> Self {
        Self {
            counts: Mutex::new(ConnectionCounts {
                total: 0,
                per_ip: HashMap::new(),
                start_window_started: Instant::now(),
                starts_in_window: 0,
            }),
        }
    }

    fn try_acquire(self: &Arc<Self>, peer_ip: IpAddr) -> Option<ConnectionPermit> {
        let mut counts = self.counts.lock().ok()?;
        if counts.start_window_started.elapsed() >= CONNECTION_START_WINDOW {
            counts.start_window_started = Instant::now();
            counts.starts_in_window = 0;
        }
        if counts.starts_in_window >= MAX_CONNECTION_STARTS_PER_WINDOW {
            return None;
        }
        counts.starts_in_window += 1;

        let per_ip = counts.per_ip.get(&peer_ip).copied().unwrap_or(0);
        if counts.total >= MAX_ACTIVE_CONNECTIONS || per_ip >= MAX_ACTIVE_CONNECTIONS_PER_IP {
            return None;
        }
        counts.total += 1;
        counts.per_ip.insert(peer_ip, per_ip + 1);
        Some(ConnectionPermit {
            limiter: Arc::clone(self),
            peer_ip,
        })
    }

    fn release(&self, peer_ip: IpAddr) {
        let Ok(mut counts) = self.counts.lock() else {
            return;
        };
        counts.total = counts.total.saturating_sub(1);
        if let Some(value) = counts.per_ip.get_mut(&peer_ip) {
            *value = value.saturating_sub(1);
            if *value == 0 {
                counts.per_ip.remove(&peer_ip);
            }
        }
    }
}

struct ConnectionPermit {
    limiter: Arc<ConnectionLimiter>,
    peer_ip: IpAddr,
}

impl Drop for ConnectionPermit {
    fn drop(&mut self) {
        self.limiter.release(self.peer_ip);
    }
}

#[derive(Clone)]
struct SharedTlsStream {
    inner: Arc<Mutex<tls::ServerTlsStream>>,
}

impl SharedTlsStream {
    fn new(stream: tls::ServerTlsStream) -> Self {
        Self {
            inner: Arc::new(Mutex::new(stream)),
        }
    }

    fn lock_error() -> io::Error {
        io::Error::new(ErrorKind::Other, "Stream TLS del Connector non disponibile.")
    }

    fn set_read_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        self.inner
            .lock()
            .map_err(|_| Self::lock_error())?
            .sock
            .set_read_timeout(timeout)
    }

    fn set_write_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        self.inner
            .lock()
            .map_err(|_| Self::lock_error())?
            .sock
            .set_write_timeout(timeout)
    }
}

impl Read for SharedTlsStream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.inner
            .lock()
            .map_err(|_| Self::lock_error())?
            .read(buffer)
    }
}

impl Write for SharedTlsStream {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.inner
            .lock()
            .map_err(|_| Self::lock_error())?
            .write(buffer)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner
            .lock()
            .map_err(|_| Self::lock_error())?
            .flush()
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConnectorMediaRequest {
    protocol_version: u16,
    request_id: String,
    method: String,
    path: String,
    #[serde(default)]
    range: Option<String>,
    #[serde(default)]
    if_range: Option<String>,
    access_grant: String,
    device_auth: MediaAuthorization,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MediaAuthorization {
    device_id: String,
    expires: u64,
    signature: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConnectorPairingRequest {
    protocol_version: u16,
    request_id: String,
    pairing: PairingPayload,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PairingPayload {
    invite_token: String,
    installation_id: String,
    public_key: String,
    signature: String,
    device_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectorPairingResponse {
    protocol_version: u16,
    request_id: String,
    status: u16,
    body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    relay_server_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    relay_access_grant: Option<String>,
}

#[derive(Debug, Deserialize)]
struct NodePairingEnvelope {
    paired: bool,
    device: NodePairedDevice,
}

#[derive(Debug, Deserialize)]
struct NodePairedDevice {
    id: String,
}

fn normalize_bind_ip(value: &str) -> Result<Ipv4Addr, String> {
    let input = value.trim();
    let address = input
        .parse::<Ipv4Addr>()
        .map_err(|_| format!("{BIND_IP_ENV} deve contenere un indirizzo IPv4 letterale."))?;
    if !(address.is_loopback() || address.is_private()) {
        return Err(format!(
            "{BIND_IP_ENV} accetta soltanto 127.0.0.1 o un indirizzo IPv4 LAN privato RFC1918."
        ));
    }
    Ok(address)
}

fn configured_bind_address() -> Result<SocketAddrV4, String> {
    let bind_ip = match env::var(BIND_IP_ENV) {
        Ok(value) => normalize_bind_ip(&value)?,
        Err(env::VarError::NotPresent) => DEFAULT_BIND_IP
            .parse::<Ipv4Addr>()
            .expect("DEFAULT_BIND_IP deve essere un IPv4 valido"),
        Err(env::VarError::NotUnicode(_)) => {
            return Err(format!("{BIND_IP_ENV} deve contenere testo UTF-8 valido."));
        }
    };
    Ok(SocketAddrV4::new(bind_ip, CONNECTOR_PORT))
}

fn unix_seconds() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| "Orologio di sistema non valido nel Connector.".to_string())
}

fn main() {
    let arguments: Vec<_> = env::args_os().skip(1).collect();
    if arguments.len() == 1 && arguments[0] == std::ffi::OsStr::new("--print-fingerprint") {
        match server_identity::load_or_create_server_identity() {
            Ok(identity) => println!("{}", identity.fingerprint()),
            Err(error) => {
                eprintln!("Impossibile leggere l'identita Host Connector: {error}");
                std::process::exit(1);
            }
        }
        return;
    }
    if !arguments.is_empty() {
        eprintln!("Argomenti Host Connector non supportati.");
        std::process::exit(2);
    }

    if let Err(error) = run() {
        eprintln!("Baia Host Connector non avviato: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let server_identity = Arc::new(server_identity::load_or_create_server_identity()?);
    let tls_config = tls::build_server_config(&server_identity)?;
    let bind_address = configured_bind_address()?;
    let listener = TcpListener::bind(bind_address)
        .map_err(|error| format!("Impossibile aprire {bind_address}: {error}"))?;
    let relay_enabled = relay_transport::start_if_configured(
        Arc::clone(&server_identity),
        bind_address,
    )?;
    let clients = Arc::new(ConnectorClients {
        api: Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .connect_timeout(UPSTREAM_CONNECT_TIMEOUT)
            .timeout(UPSTREAM_REQUEST_TIMEOUT)
            .build()
            .map_err(|error| format!("Impossibile inizializzare il client API upstream: {error}"))?,
        media: Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .connect_timeout(UPSTREAM_CONNECT_TIMEOUT)
            .build()
            .map_err(|error| format!("Impossibile inizializzare il client media upstream: {error}"))?,
        upload: Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .connect_timeout(UPSTREAM_CONNECT_TIMEOUT)
            .timeout(UPSTREAM_UPLOAD_REQUEST_TIMEOUT)
            .build()
            .map_err(|error| format!("Impossibile inizializzare il client upload upstream: {error}"))?,
    });

    println!(
        "Baia Host Connector {} attivo su https://{} (TLS 1.3, RFC7250 RPK, protocollo v{}, upstream Node fisso {}, server_identity={} {}, relay={})",
        env!("CARGO_PKG_VERSION"),
        bind_address,
        PROTOCOL_VERSION,
        UPSTREAM_BASE_URL,
        server_identity.algorithm(),
        server_identity.fingerprint(),
        if relay_enabled { "configured" } else { "disabled" }
    );

    let connection_limiter = Arc::new(ConnectionLimiter::new());
    for incoming in listener.incoming() {
        match incoming {
            Ok(stream) => {
                let peer_ip = match stream.peer_addr() {
                    Ok(address) => address.ip(),
                    Err(_) => {
                        eprintln!("Connessione Host Connector rifiutata: peer non identificabile.");
                        continue;
                    }
                };
                let Some(permit) = connection_limiter.try_acquire(peer_ip) else {
                    eprintln!("Connessione Host Connector rifiutata: limite connessioni raggiunto.");
                    continue;
                };

                let clients = Arc::clone(&clients);
                let tls_config = Arc::clone(&tls_config);
                let server_identity = Arc::clone(&server_identity);
                if let Err(error) = thread::Builder::new()
                    .name("baia-host-connector-request".to_string())
                    .spawn(move || {
                        let _permit = permit;
                        let _ = stream.set_nodelay(true);
                        if let Err(error) = stream.set_read_timeout(Some(TLS_HANDSHAKE_TIMEOUT)) {
                            eprintln!("Impossibile impostare timeout handshake TLS Connector: {error}");
                            return;
                        }
                        if let Err(error) = stream.set_write_timeout(Some(TLS_HANDSHAKE_TIMEOUT)) {
                            eprintln!("Impossibile impostare timeout write handshake TLS Connector: {error}");
                            return;
                        }
                        let tls_stream = match tls::accept_tls(stream, tls_config) {
                            Ok(stream) => stream,
                            Err(_error) => {
                                eprintln!("Connessione Host Connector rifiutata durante TLS.");
                                return;
                            }
                        };
                        let shared = SharedTlsStream::new(tls_stream);
                        if let Err(error) = shared.set_read_timeout(Some(HTTP_HEAD_TIMEOUT)) {
                            eprintln!("Impossibile impostare timeout header Connector: {error}");
                            return;
                        }
                        if let Err(error) = shared.set_write_timeout(Some(CLIENT_WRITE_TIMEOUT)) {
                            eprintln!("Impossibile impostare timeout write Connector: {error}");
                            return;
                        }
                        if let Err(error) = handle_connection(shared, &clients, &server_identity) {
                            eprintln!("Richiesta Host Connector rifiutata o interrotta: {error}");
                        }
                    })
                {
                    eprintln!("Impossibile creare il worker Host Connector: {error}");
                }
            }
            Err(error) => eprintln!("Errore accept Host Connector: {error}"),
        }
    }
    Ok(())
}

fn handle_connection(
    mut stream: SharedTlsStream,
    clients: &ConnectorClients,
    server_identity: &server_identity::ServerIdentity,
) -> Result<(), String> {
    let mut reader = BufReader::new(stream.clone());
    let head = read_http_head(&mut reader)?;
    let request_line = head
        .first()
        .ok_or_else(|| "Richiesta HTTP vuota.".to_string())?;
    let (method, target) = parse_request_line(request_line)?;
    let headers = parse_http_headers(&head[1..])?;
    stream
        .set_read_timeout(Some(CLIENT_READ_TIMEOUT))
        .map_err(|error| format!("Impossibile impostare timeout body Connector: {error}"))?;

    match (method.as_str(), target.as_str()) {
        ("GET", HEALTH_PATH) => write_health(&mut stream),
        ("POST", REQUEST_PATH) => {
            let Some(body) = read_json_frame(&mut stream, &mut reader, &headers, MAX_FRAME_BYTES)? else {
                return Ok(());
            };
            handle_protocol_request(&mut stream, &clients.api, &body, server_identity)
        }
        ("POST", MEDIA_PATH) => {
            let Some(body) = read_json_frame(&mut stream, &mut reader, &headers, MAX_MEDIA_FRAME_BYTES)? else {
                return Ok(());
            };
            handle_media_request(&mut stream, &clients.media, &body, server_identity)
        }
        ("POST", PAIRING_PATH) => {
            let Some(body) = read_json_frame(&mut stream, &mut reader, &headers, MAX_PAIRING_FRAME_BYTES)? else {
                return Ok(());
            };
            handle_pairing_request(&mut stream, &clients.api, &body, server_identity)
        }
        ("POST", UPLOAD_PATH) => {
            handle_upload_request(&mut stream, &clients.upload, reader, &headers, server_identity)
        }
        ("GET", _) | ("POST", _) => write_connector_error(
            &mut stream,
            404,
            None,
            "CONNECTOR_ROUTE_NOT_FOUND",
            "Route Host Connector non disponibile.",
        ),
        _ => write_connector_error(
            &mut stream,
            405,
            None,
            "CONNECTOR_METHOD_NOT_ALLOWED",
            "Metodo Host Connector non consentito.",
        ),
    }
}

fn read_json_frame<R: Read>(
    stream: &mut SharedTlsStream,
    reader: &mut R,
    headers: &BTreeMap<String, String>,
    max_frame_bytes: usize,
) -> Result<Option<Vec<u8>>, String> {
    if headers.contains_key("transfer-encoding") {
        write_connector_error(
            stream,
            400,
            None,
            "CONNECTOR_CHUNKED_UNSUPPORTED",
            "Il protocollo locale v1 richiede Content-Length.",
        )?;
        return Ok(None);
    }
    if !headers
        .get("content-type")
        .is_some_and(|value| value.to_ascii_lowercase().starts_with("application/json"))
    {
        write_connector_error(
            stream,
            415,
            None,
            "CONNECTOR_CONTENT_TYPE",
            "Il protocollo locale v1 accetta application/json.",
        )?;
        return Ok(None);
    }
    let content_length = match headers.get("content-length").and_then(|value| value.parse::<usize>().ok()) {
        Some(value) => value,
        None => {
            write_connector_error(
                stream,
                400,
                None,
                "CONNECTOR_CONTENT_LENGTH",
                "Il protocollo locale v1 richiede un Content-Length valido.",
            )?;
            return Ok(None);
        }
    };
    if content_length > max_frame_bytes {
        write_connector_error(
            stream,
            413,
            None,
            "CONNECTOR_FRAME_TOO_LARGE",
            "Frame protocollo troppo grande.",
        )?;
        return Ok(None);
    }

    let mut body = vec![0u8; content_length];
    reader
        .read_exact(&mut body)
        .map_err(|error| format!("Body protocollo incompleto: {error}"))?;
    Ok(Some(body))
}

fn handle_protocol_request(
    stream: &mut SharedTlsStream,
    client: &Client,
    body: &[u8],
    server_identity: &server_identity::ServerIdentity,
) -> Result<(), String> {
    let parsed: ConnectorRequest = match serde_json::from_slice(body) {
        Ok(value) => value,
        Err(_) => {
            return write_connector_error(
                stream,
                400,
                None,
                "CONNECTOR_INVALID_JSON",
                "Frame protocollo JSON non valido.",
            )
        }
    };

    let request_id = parsed.request_id.clone();
    let started = Instant::now();
    let validated = match validate_connector_request(parsed) {
        Ok(value) => value,
        Err(message) => {
            return write_connector_error(
                stream,
                400,
                Some(&request_id),
                "CONNECTOR_INVALID_REQUEST",
                &message,
            )
        }
    };

    let now_seconds = unix_seconds()?;
    let transport_auth = access_grant::verify_access_grant(
        &validated.access_grant,
        server_identity.public_key(),
        now_seconds,
    )
    .and_then(|grant| {
        access_grant::verify_request_authorization(
            &grant,
            &validated.device_auth.device_id,
            validated.device_auth.timestamp,
            &validated.device_auth.nonce,
            &validated.device_auth.signature,
            &validated.method,
            &validated.path,
            now_seconds,
        )
    });
    if transport_auth.is_err() {
        return write_connector_error(
            stream,
            401,
            Some(&request_id),
            "CONNECTOR_TRANSPORT_AUTH_REJECTED",
            "Autenticazione trasporto Baia non valida.",
        );
    }

    let target = build_upstream_target(&validated.path)?;
    let method = validated.method.parse::<Method>()
        .map_err(|_| "Metodo upstream non valido dopo validazione.".to_string())?;

    let mut upstream = client
        .request(method, target)
        .header("X-Baia-Device-Id", &validated.device_auth.device_id)
        .header("X-Baia-Timestamp", validated.device_auth.timestamp.to_string())
        .header("X-Baia-Nonce", &validated.device_auth.nonce)
        .header("X-Baia-Signature", &validated.device_auth.signature);

    for (name, value) in validated.headers {
        upstream = match name.as_str() {
            "accept" => upstream.header(reqwest::header::ACCEPT, value),
            "content-type" => upstream.header(reqwest::header::CONTENT_TYPE, value),
            _ => return Err("Header applicativo non valido dopo normalizzazione.".to_string()),
        };
    }
    if let Some(body) = validated.body {
        upstream = upstream.body(body);
    }

    let response = match upstream.send() {
        Ok(response) => response,
        Err(_) => {
            println!(
                "request={} result=upstream_unavailable elapsed_ms={}",
                request_id,
                started.elapsed().as_millis()
            );
            return write_connector_error(
                stream,
                502,
                Some(&request_id),
                "HOST_CONNECTOR_UPSTREAM_UNAVAILABLE",
                "Node Baia su loopback non è raggiungibile.",
            );
        }
    };

    if response.status().is_redirection() {
        return write_connector_error(
            stream,
            502,
            Some(&request_id),
            "HOST_CONNECTOR_UPSTREAM_REDIRECT",
            "Node Baia ha restituito un redirect non consentito.",
        );
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_API_RESPONSE_BYTES)
    {
        return write_connector_error(
            stream,
            502,
            Some(&request_id),
            "HOST_CONNECTOR_RESPONSE_TOO_LARGE",
            "Risposta Node troppo grande per il canale API JSON.",
        );
    }

    let status = response.status();
    let response_headers = collect_response_headers(response.headers());
    let bytes = response
        .bytes()
        .map_err(|error| format!("Impossibile leggere la risposta Node: {error}"))?;
    if bytes.len() as u64 > MAX_API_RESPONSE_BYTES {
        return write_connector_error(
            stream,
            502,
            Some(&request_id),
            "HOST_CONNECTOR_RESPONSE_TOO_LARGE",
            "Risposta Node troppo grande per il canale API JSON.",
        );
    }
    let response_body = String::from_utf8(bytes.to_vec()).map_err(|_| {
        "Il canale API JSON del Connector ha ricevuto una risposta non UTF-8.".to_string()
    })?;

    println!(
        "request={} result=upstream_response status={} elapsed_ms={}",
        request_id,
        status.as_u16(),
        started.elapsed().as_millis()
    );

    write_json(
        stream,
        200,
        &ConnectorResponse {
            protocol_version: PROTOCOL_VERSION,
            request_id,
            status: status.as_u16(),
            headers: response_headers,
            body: response_body,
        },
    )
}

fn handle_pairing_request(
    stream: &mut SharedTlsStream,
    client: &Client,
    body: &[u8],
    server_identity: &server_identity::ServerIdentity,
) -> Result<(), String> {
    let parsed: ConnectorPairingRequest = match serde_json::from_slice(body) {
        Ok(value) => value,
        Err(_) => {
            return write_connector_error(
                stream,
                400,
                None,
                "CONNECTOR_INVALID_JSON",
                "Frame pairing JSON non valido.",
            )
        }
    };

    let request_id = parsed.request_id.clone();
    let started = Instant::now();
    let validated = match validate_pairing_request(parsed) {
        Ok(value) => value,
        Err(message) => {
            return write_connector_error(
                stream,
                400,
                Some(&request_id),
                "CONNECTOR_INVALID_PAIRING",
                &message,
            )
        }
    };

    let target = pairing_upstream_target()?;
    let pairing_device_public_key = validated.pairing.public_key.clone();
    let pairing_body = serde_json::to_vec(&validated.pairing)
        .map_err(|_| "Impossibile serializzare il payload pairing per Node.".to_string())?;
    let response = match client
        .post(target)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(pairing_body)
        .send()
    {
        Ok(response) => response,
        Err(_) => {
            println!(
                "pairing={} result=upstream_unavailable elapsed_ms={}",
                request_id,
                started.elapsed().as_millis()
            );
            return write_connector_error(
                stream,
                502,
                Some(&request_id),
                "HOST_CONNECTOR_UPSTREAM_UNAVAILABLE",
                "Node Baia su loopback non è raggiungibile durante il pairing.",
            );
        }
    };

    if response.status().is_redirection() {
        return write_connector_error(
            stream,
            502,
            Some(&request_id),
            "HOST_CONNECTOR_UPSTREAM_REDIRECT",
            "Node Baia ha restituito un redirect pairing non consentito.",
        );
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_PAIRING_RESPONSE_BYTES)
    {
        return write_connector_error(
            stream,
            502,
            Some(&request_id),
            "HOST_CONNECTOR_RESPONSE_TOO_LARGE",
            "Risposta pairing Node troppo grande.",
        );
    }

    let status = response.status();
    let bytes = response
        .bytes()
        .map_err(|error| format!("Impossibile leggere la risposta pairing Node: {error}"))?;
    if bytes.len() as u64 > MAX_PAIRING_RESPONSE_BYTES {
        return write_connector_error(
            stream,
            502,
            Some(&request_id),
            "HOST_CONNECTOR_RESPONSE_TOO_LARGE",
            "Risposta pairing Node troppo grande.",
        );
    }
    let response_body = String::from_utf8(bytes.to_vec())
        .map_err(|_| "La risposta pairing Node non è UTF-8.".to_string())?;

    let relay_grant = if status.is_success() {
        let envelope: NodePairingEnvelope = serde_json::from_str(&response_body)
            .map_err(|_| "Risposta pairing Node valida HTTP ma non utilizzabile per il grant relay.".to_string())?;
        if !envelope.paired {
            return Err("Node ha restituito HTTP successo senza confermare il pairing.".to_string());
        }
        Some(relay_transport::issue_access_grant(
            server_identity,
            &envelope.device.id,
            &pairing_device_public_key,
        )?)
    } else {
        None
    };

    println!(
        "pairing={} result=upstream_response status={} elapsed_ms={}",
        request_id,
        status.as_u16(),
        started.elapsed().as_millis()
    );

    write_json(
        stream,
        200,
        &ConnectorPairingResponse {
            protocol_version: PROTOCOL_VERSION,
            request_id,
            status: status.as_u16(),
            body: response_body,
            relay_server_id: relay_grant.as_ref().map(|grant| grant.server_id.clone()),
            relay_access_grant: relay_grant.map(|grant| grant.grant),
        },
    )
}


fn handle_upload_request(
    stream: &mut SharedTlsStream,
    client: &Client,
    reader: BufReader<SharedTlsStream>,
    headers: &BTreeMap<String, String>,
    server_identity: &server_identity::ServerIdentity,
) -> Result<(), String> {
    let request_id = headers
        .get("x-baia-request-id")
        .map(String::as_str)
        .unwrap_or_default()
        .to_string();
    let started = Instant::now();

    let (path, content_type, content_length, access_grant_value, authorization) =
        match validate_upload_headers(headers) {
            Ok(value) => value,
            Err(message) => {
                let request_id_ref = if Uuid::parse_str(&request_id).is_ok() {
                    Some(request_id.as_str())
                } else {
                    None
                };
                return write_connector_error(
                    stream,
                    400,
                    request_id_ref,
                    "CONNECTOR_INVALID_UPLOAD",
                    &message,
                );
            }
        };

    let now_seconds = unix_seconds()?;
    let transport_auth = access_grant::verify_access_grant(
        &access_grant_value,
        server_identity.public_key(),
        now_seconds,
    )
    .and_then(|grant| {
        access_grant::verify_request_authorization(
            &grant,
            &authorization.device_id,
            authorization.timestamp,
            &authorization.nonce,
            &authorization.signature,
            "POST",
            &path,
            now_seconds,
        )
    });
    if transport_auth.is_err() {
        return write_connector_error(
            stream,
            401,
            Some(&request_id),
            "CONNECTOR_TRANSPORT_AUTH_REJECTED",
            "Autenticazione upload Baia non valida.",
        );
    }

    let target = build_upload_upstream_target(&path)?;
    let body_reader = reader.take(content_length);
    let body = Body::sized(body_reader, content_length);

    let mut response = match client
        .post(target)
        .header("X-Baia-Device-Id", authorization.device_id)
        .header("X-Baia-Timestamp", authorization.timestamp.to_string())
        .header("X-Baia-Nonce", authorization.nonce)
        .header("X-Baia-Signature", authorization.signature)
        .header(reqwest::header::CONTENT_TYPE, content_type)
        .body(body)
        .send()
    {
        Ok(response) => response,
        Err(_) => {
            println!(
                "upload={} result=upstream_unavailable elapsed_ms={}",
                request_id,
                started.elapsed().as_millis()
            );
            return write_connector_error(
                stream,
                502,
                Some(&request_id),
                "HOST_CONNECTOR_UPLOAD_UPSTREAM_UNAVAILABLE",
                "Node Baia su loopback non è raggiungibile durante l’upload.",
            );
        }
    };

    if response.status().is_redirection() {
        return write_connector_error(
            stream,
            502,
            Some(&request_id),
            "HOST_CONNECTOR_UPLOAD_REDIRECT",
            "Node Baia ha restituito un redirect upload non consentito.",
        );
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_UPLOAD_RESPONSE_BYTES)
    {
        return write_connector_error(
            stream,
            502,
            Some(&request_id),
            "HOST_CONNECTOR_RESPONSE_TOO_LARGE",
            "Risposta upload Node troppo grande.",
        );
    }

    let status = response.status();
    let response_content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let mut bytes = Vec::new();
    response
        .by_ref()
        .take(MAX_UPLOAD_RESPONSE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Impossibile leggere la risposta upload Node: {error}"))?;
    if bytes.len() as u64 > MAX_UPLOAD_RESPONSE_BYTES {
        return write_connector_error(
            stream,
            502,
            Some(&request_id),
            "HOST_CONNECTOR_RESPONSE_TOO_LARGE",
            "Risposta upload Node troppo grande.",
        );
    }

    println!(
        "upload={} result=upstream_response status={} elapsed_ms={}",
        request_id,
        status.as_u16(),
        started.elapsed().as_millis()
    );

    write_upload_response(
        stream,
        status.as_u16(),
        response_content_type.as_deref(),
        &bytes,
    )
}

fn validate_upload_headers(
    headers: &BTreeMap<String, String>,
) -> Result<(String, String, u64, String, DeviceAuthorization), String> {
    if headers.contains_key("transfer-encoding") {
        return Err("Il canale upload v1 richiede Content-Length e non accetta Transfer-Encoding.".to_string());
    }

    let protocol_version = required_upload_header(headers, "x-baia-protocol-version")?
        .parse::<u16>()
        .map_err(|_| "Versione protocollo upload non valida.".to_string())?;
    if protocol_version != PROTOCOL_VERSION {
        return Err(format!(
            "Versione protocollo upload non supportata: {protocol_version}."
        ));
    }

    let request_id = required_upload_header(headers, "x-baia-request-id")?;
    Uuid::parse_str(request_id).map_err(|_| "Request ID upload non valido.".to_string())?;

    let path = normalize_upload_path(required_upload_header(headers, "x-baia-upload-path")?)?;
    let content_type =
        normalize_upload_content_type(required_upload_header(headers, "content-type")?)?;
    let content_length = required_upload_header(headers, "content-length")?
        .parse::<u64>()
        .map_err(|_| "Content-Length upload non valido.".to_string())?;
    if content_length == 0 || content_length > MAX_UPLOAD_BODY_BYTES {
        return Err("Dimensione upload fuori dai limiti del protocollo.".to_string());
    }

    let device_id = required_upload_header(headers, "x-baia-device-id")?.to_string();
    Uuid::parse_str(&device_id).map_err(|_| "Device ID upload non valido.".to_string())?;
    let timestamp = required_upload_header(headers, "x-baia-timestamp")?
        .parse::<u64>()
        .map_err(|_| "Timestamp upload non valido.".to_string())?;
    if timestamp == 0 {
        return Err("Timestamp upload non valido.".to_string());
    }
    let nonce = required_upload_header(headers, "x-baia-nonce")?.to_string();
    let signature = required_upload_header(headers, "x-baia-signature")?.to_string();
    let access_grant = required_upload_header(headers, "x-baia-access-grant")?.to_string();
    validate_opaque_auth_value(&nonce, "nonce upload")?;
    validate_opaque_auth_value(&signature, "firma upload")?;
    if access_grant.len() > 1024 {
        return Err("Grant accesso upload troppo grande.".to_string());
    }

    Ok((
        path,
        content_type,
        content_length,
        access_grant,
        DeviceAuthorization {
            device_id,
            timestamp,
            nonce,
            signature,
        },
    ))
}

fn required_upload_header<'a>(
    headers: &'a BTreeMap<String, String>,
    name: &str,
) -> Result<&'a str, String> {
    headers
        .get(name)
        .map(String::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("Header upload richiesto mancante: {name}."))
}

fn normalize_upload_content_type(value: &str) -> Result<String, String> {
    let value = value.trim();
    let lower = value.to_ascii_lowercase();
    if value.len() > 512
        || !lower.starts_with("multipart/form-data;")
        || !lower.contains("boundary=")
    {
        return Err("Content-Type upload deve essere multipart/form-data con boundary.".to_string());
    }
    Ok(value.to_string())
}

fn normalize_upload_path(value: &str) -> Result<String, String> {
    let path = value.trim();
    if path.contains('?') || path.contains('#') || path.contains('\\') || path.starts_with("//") {
        return Err("Percorso upload non valido per il Connector.".to_string());
    }
    let segments: Vec<_> = path.trim_matches('/').split('/').collect();
    match segments.as_slice() {
        ["api", "uploads", "movies"] => Ok("/api/uploads/movies".to_string()),
        ["api", "uploads", "series"] => Ok("/api/uploads/series".to_string()),
        ["api", "uploads", "music", "sessions"] => {
            Ok("/api/uploads/music/sessions".to_string())
        }
        ["api", "uploads", "reading", category]
            if matches!(*category, "books" | "comics" | "manga") =>
        {
            Ok(format!("/api/uploads/reading/{category}"))
        }
        _ => Err(
            "Il Connector upload accetta soltanto gli endpoint nativi Film, Serie, Reading e Musica."
                .to_string(),
        ),
    }
}

fn build_upload_upstream_target(path: &str) -> Result<Url, String> {
    let normalized = normalize_upload_path(path)?;
    let target = build_upstream_target(&normalized)?;
    if target.origin().ascii_serialization() != UPSTREAM_BASE_URL
        || target.path() != normalized
        || target.query().is_some()
    {
        return Err("Destinazione upload upstream fuori da Node loopback.".to_string());
    }
    Ok(target)
}

fn write_upload_response(
    stream: &mut SharedTlsStream,
    status: u16,
    content_type: Option<&str>,
    body: &[u8],
) -> Result<(), String> {
    write!(
        stream,
        "HTTP/1.1 {} {}\r\n",
        status,
        reason_phrase(status)
    )
    .map_err(|error| format!("Impossibile scrivere status upload Connector: {error}"))?;
    if let Some(content_type) = content_type {
        write!(stream, "Content-Type: {content_type}\r\n")
            .map_err(|error| format!("Impossibile scrivere Content-Type upload Connector: {error}"))?;
    } else {
        write!(stream, "Content-Type: application/json; charset=utf-8\r\n")
            .map_err(|error| format!("Impossibile scrivere Content-Type upload Connector: {error}"))?;
    }
    write!(
        stream,
        "Content-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .map_err(|error| format!("Impossibile finalizzare header upload Connector: {error}"))?;
    stream
        .write_all(body)
        .map_err(|error| format!("Impossibile scrivere risposta upload Connector: {error}"))?;
    stream.flush().ok();
    Ok(())
}

fn handle_media_request(
    stream: &mut SharedTlsStream,
    client: &Client,
    body: &[u8],
    server_identity: &server_identity::ServerIdentity,
) -> Result<(), String> {
    let parsed: ConnectorMediaRequest = match serde_json::from_slice(body) {
        Ok(value) => value,
        Err(_) => {
            return write_connector_error(
                stream,
                400,
                None,
                "CONNECTOR_INVALID_MEDIA_JSON",
                "Frame media JSON non valido.",
            )
        }
    };

    let request_id = parsed.request_id.clone();
    let started = Instant::now();
    let validated = match validate_media_request(parsed) {
        Ok(value) => value,
        Err(message) => {
            return write_connector_error(
                stream,
                400,
                Some(&request_id),
                "CONNECTOR_INVALID_MEDIA_REQUEST",
                &message,
            )
        }
    };

    let now_seconds = unix_seconds()?;
    let transport_auth = access_grant::verify_access_grant(
        &validated.access_grant,
        server_identity.public_key(),
        now_seconds,
    )
    .and_then(|grant| {
        access_grant::verify_media_authorization(
            &grant,
            &validated.device_auth.device_id,
            validated.device_auth.expires,
            &validated.device_auth.signature,
            &validated.path,
            now_seconds,
        )
    });
    if transport_auth.is_err() {
        return write_connector_error(
            stream,
            401,
            Some(&request_id),
            "CONNECTOR_TRANSPORT_AUTH_REJECTED",
            "Autenticazione media Baia non valida.",
        );
    }

    let target = build_media_upstream_target(&validated.path, &validated.device_auth)?;
    let method = validated
        .method
        .parse::<Method>()
        .map_err(|_| "Metodo media upstream non valido dopo validazione.".to_string())?;

    let mut upstream = client.request(method.clone(), target);
    if let Some(value) = validated.range {
        upstream = upstream.header(reqwest::header::RANGE, value);
    }
    if let Some(value) = validated.if_range {
        upstream = upstream.header(reqwest::header::IF_RANGE, value);
    }

    let mut response = match upstream.send() {
        Ok(response) => response,
        Err(_) => {
            println!(
                "media={} result=upstream_unavailable elapsed_ms={}",
                request_id,
                started.elapsed().as_millis()
            );
            return write_connector_error(
                stream,
                502,
                Some(&request_id),
                "HOST_CONNECTOR_MEDIA_UPSTREAM_UNAVAILABLE",
                "Node Baia su loopback non è raggiungibile per il media.",
            );
        }
    };

    if response.status().is_redirection() {
        return write_connector_error(
            stream,
            502,
            Some(&request_id),
            "HOST_CONNECTOR_MEDIA_REDIRECT",
            "Node Baia ha restituito un redirect media non consentito.",
        );
    }

    let status = response.status();
    println!(
        "media={} result=upstream_response status={} elapsed_ms={}",
        request_id,
        status.as_u16(),
        started.elapsed().as_millis()
    );

    write_media_response(stream, &mut response, method == Method::HEAD)
}

fn validate_media_request(mut request: ConnectorMediaRequest) -> Result<ConnectorMediaRequest, String> {
    if request.protocol_version != PROTOCOL_VERSION {
        return Err(format!(
            "Versione protocollo media non supportata: {}.",
            request.protocol_version
        ));
    }
    Uuid::parse_str(&request.request_id)
        .map_err(|_| "Request ID media non valido.".to_string())?;
    Uuid::parse_str(&request.device_auth.device_id)
        .map_err(|_| "Device ID media non valido.".to_string())?;
    validate_opaque_auth_value(&request.access_grant, "grant accesso media")?;
    if request.device_auth.expires == 0 {
        return Err("Scadenza autorizzazione media non valida.".to_string());
    }
    validate_opaque_auth_value(&request.device_auth.signature, "firma media")?;

    request.method = normalize_media_method(&request.method)?;
    request.path = normalize_media_path(&request.path)?;
    request.range = normalize_optional_media_header(request.range.take(), "Range", 256)?;
    request.if_range = normalize_optional_media_header(request.if_range.take(), "If-Range", 512)?;
    if request
        .range
        .as_ref()
        .is_some_and(|value| !value.to_ascii_lowercase().starts_with("bytes="))
    {
        return Err("Range media deve usare l'unità bytes.".to_string());
    }
    Ok(request)
}

fn normalize_media_method(value: &str) -> Result<String, String> {
    match value.trim().to_ascii_uppercase().as_str() {
        "GET" => Ok("GET".to_string()),
        "HEAD" => Ok("HEAD".to_string()),
        _ => Err("Il canale media del Connector accetta solo GET e HEAD.".to_string()),
    }
}

fn normalize_media_path(value: &str) -> Result<String, String> {
    let path = value.trim();
    if path.contains('?') || path.contains('#') || path.contains('\\') || path.starts_with("//") {
        return Err("Percorso media non valido per il Connector.".to_string());
    }
    let segments: Vec<_> = path.trim_matches('/').split('/').collect();
    match segments.as_slice() {
        ["api", "movies", id, "stream"]
            if !id.is_empty() && id.chars().all(|ch| ch.is_ascii_digit()) =>
        {
            Ok(format!("/api/movies/{id}/stream"))
        }
        ["api", "movies", id, "poster"]
            if !id.is_empty() && id.chars().all(|ch| ch.is_ascii_digit()) =>
        {
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
        ["api", "reading", id, "file"]
            if !id.is_empty() && id.chars().all(|ch| ch.is_ascii_digit()) =>
        {
            Ok(format!("/api/reading/{id}/file"))
        }
        ["api", "reading", id, "cover"]
            if !id.is_empty() && id.chars().all(|ch| ch.is_ascii_digit()) =>
        {
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
        _ => Err("Il Connector media accetta soltanto risorse Film, Serie, Musica e Reading allowlistate.".to_string()),
    }
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

fn normalize_optional_media_header(
    value: Option<String>,
    label: &str,
    max_len: usize,
) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim().to_string();
    if value.is_empty() || value.len() > max_len || value.contains('\r') || value.contains('\n') {
        return Err(format!("{label} media non valido."));
    }
    Ok(Some(value))
}

fn build_media_upstream_target(
    path: &str,
    authorization: &MediaAuthorization,
) -> Result<Url, String> {
    let mut target = build_upstream_target(path)?;
    if target.query().is_some() {
        return Err("Il percorso media non può contenere query applicative.".to_string());
    }
    {
        let mut query = target.query_pairs_mut();
        query.append_pair("_baia_device", &authorization.device_id);
        query.append_pair("_baia_expires", &authorization.expires.to_string());
        query.append_pair("_baia_signature", &authorization.signature);
    }
    Ok(target)
}

fn write_media_response(
    stream: &mut SharedTlsStream,
    response: &mut reqwest::blocking::Response,
    head_only: bool,
) -> Result<(), String> {
    let status = response.status();
    write!(
        stream,
        "HTTP/1.1 {} {}\r\n",
        status.as_u16(),
        reason_phrase(status.as_u16())
    )
    .map_err(|error| format!("Impossibile scrivere status media Connector: {error}"))?;

    for name in MEDIA_RESPONSE_HEADERS {
        if let Some(value) = response.headers().get(*name).and_then(|value| value.to_str().ok()) {
            write!(stream, "{}: {}\r\n", canonical_header_name(name), value)
                .map_err(|error| format!("Impossibile scrivere header media Connector: {error}"))?;
        }
    }
    write!(stream, "Connection: close\r\n\r\n")
        .map_err(|error| format!("Impossibile finalizzare header media Connector: {error}"))?;

    if !head_only {
        if let Err(error) = std::io::copy(response, stream) {
            if !is_client_disconnect(&error) {
                return Err(format!("Streaming media Connector interrotto: {error}"));
            }
        }
    }
    stream.flush().ok();
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

fn is_client_disconnect(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        ErrorKind::BrokenPipe | ErrorKind::ConnectionAborted | ErrorKind::ConnectionReset
    )
}

fn validate_pairing_request(
    mut request: ConnectorPairingRequest,
) -> Result<ConnectorPairingRequest, String> {
    if request.protocol_version != PROTOCOL_VERSION {
        return Err(format!(
            "Versione protocollo pairing non supportata: {}.",
            request.protocol_version
        ));
    }
    Uuid::parse_str(&request.request_id)
        .map_err(|_| "Request ID pairing non valido.".to_string())?;
    Uuid::parse_str(&request.pairing.installation_id)
        .map_err(|_| "Installation ID pairing non valido.".to_string())?;

    request.pairing.invite_token = normalize_pairing_secret(
        request.pairing.invite_token,
        "invito",
        MAX_PAIRING_TOKEN_BYTES,
    )?;
    request.pairing.public_key = normalize_pairing_secret(
        request.pairing.public_key,
        "chiave pubblica",
        MAX_PAIRING_PROOF_BYTES,
    )?;
    request.pairing.signature = normalize_pairing_secret(
        request.pairing.signature,
        "firma",
        MAX_PAIRING_PROOF_BYTES,
    )?;
    request.pairing.device_name = normalize_pairing_device_name(request.pairing.device_name)?;
    Ok(request)
}

fn normalize_pairing_secret(value: String, label: &str, max_len: usize) -> Result<String, String> {
    let value = value.trim().to_string();
    if value.is_empty()
        || value.len() > max_len
        || value.contains('\r')
        || value.contains('\n')
        || value.chars().any(char::is_control)
    {
        return Err(format!("Valore {label} pairing non valido."));
    }
    Ok(value)
}

fn normalize_pairing_device_name(value: String) -> Result<String, String> {
    if value.chars().any(char::is_control) {
        return Err("Nome dispositivo pairing non valido.".to_string());
    }
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() || collapsed.chars().count() > MAX_DEVICE_NAME_CHARS {
        return Err("Nome dispositivo pairing non valido.".to_string());
    }
    Ok(collapsed)
}

fn pairing_upstream_target() -> Result<Url, String> {
    let target = build_upstream_target(NODE_PAIRING_PATH)?;
    if target.origin().ascii_serialization() != UPSTREAM_BASE_URL
        || target.path() != NODE_PAIRING_PATH
        || target.query().is_some()
    {
        return Err("Destinazione pairing upstream fuori da Node loopback.".to_string());
    }
    Ok(target)
}

fn validate_connector_request(mut request: ConnectorRequest) -> Result<ConnectorRequest, String> {
    if request.protocol_version != PROTOCOL_VERSION {
        return Err(format!(
            "Versione protocollo non supportata: {}.",
            request.protocol_version
        ));
    }
    Uuid::parse_str(&request.request_id)
        .map_err(|_| "Request ID protocollo non valido.".to_string())?;
    Uuid::parse_str(&request.device_auth.device_id)
        .map_err(|_| "Device ID protocollo non valido.".to_string())?;
    validate_opaque_auth_value(&request.access_grant, "grant accesso")?;
    validate_opaque_auth_value(&request.device_auth.nonce, "nonce")?;
    validate_opaque_auth_value(&request.device_auth.signature, "firma")?;
    if request.device_auth.timestamp == 0 {
        return Err("Timestamp device non valido.".to_string());
    }

    let method = normalize_method(&request.method)?;
    let path = normalize_api_path(&request.path)?;
    let headers = normalize_application_headers(std::mem::take(&mut request.headers))?;
    let body = normalize_body(&method, request.body.take())?;
    request.method = method;
    request.path = path;
    request.headers = headers;
    request.body = body;
    Ok(request)
}

fn normalize_method(value: &str) -> Result<String, String> {
    match value.trim().to_ascii_uppercase().as_str() {
        "GET" => Ok("GET".to_string()),
        "HEAD" => Ok("HEAD".to_string()),
        "POST" => Ok("POST".to_string()),
        "PUT" => Ok("PUT".to_string()),
        _ => Err("Metodo applicativo non consentito dal protocollo v1.".to_string()),
    }
}

fn normalize_api_path(value: &str) -> Result<String, String> {
    let path = value.trim();
    if !path.starts_with("/api/") || path.starts_with("//") || path.contains('\\') || path.contains('#') {
        return Err("Il Connector accetta soltanto path relativi /api/.".to_string());
    }
    let parsed = Url::parse(&format!("http://baia.invalid{path}"))
        .map_err(|_| "Path API non valido.".to_string())?;
    if parsed.origin().ascii_serialization() != "http://baia.invalid"
        || !parsed.path().starts_with("/api/")
        || parsed.fragment().is_some()
    {
        return Err("Path API fuori dal protocollo Baia.".to_string());
    }
    Ok(match parsed.query() {
        Some(query) => format!("{}?{query}", parsed.path()),
        None => parsed.path().to_string(),
    })
}

fn normalize_application_headers(
    headers: BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, String> {
    let mut accepted = BTreeMap::new();
    for (name, value) in headers {
        let normalized = name.trim().to_ascii_lowercase();
        if normalized.starts_with("x-baia-") {
            return Err("Gli header X-Baia non sono header applicativi del protocollo.".to_string());
        }
        if !ALLOWED_APPLICATION_HEADERS.contains(&normalized.as_str()) {
            return Err(format!("Header applicativo non consentito: {name}."));
        }
        if value.contains('\r') || value.contains('\n') {
            return Err("Valore header applicativo non valido.".to_string());
        }
        accepted.insert(normalized, value);
    }
    Ok(accepted)
}

fn normalize_body(method: &str, body: Option<String>) -> Result<Option<String>, String> {
    let body = body.filter(|value| !value.is_empty());
    if matches!(method, "GET" | "HEAD") && body.is_some() {
        return Err("GET e HEAD non possono avere body nel protocollo v1.".to_string());
    }
    if body.as_ref().is_some_and(|value| value.len() > MAX_API_BODY_BYTES) {
        return Err("Body API troppo grande per il protocollo v1.".to_string());
    }
    Ok(body)
}

fn validate_opaque_auth_value(value: &str, label: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > 1024 || value.contains('\r') || value.contains('\n') {
        return Err(format!("Valore {label} device non valido."));
    }
    Ok(())
}

fn build_upstream_target(path: &str) -> Result<Url, String> {
    let target = Url::parse(&format!("{UPSTREAM_BASE_URL}{path}"))
        .map_err(|_| "Impossibile costruire la destinazione Node.".to_string())?;
    if target.origin().ascii_serialization() != UPSTREAM_BASE_URL || !target.path().starts_with("/api/") {
        return Err("Destinazione upstream fuori da Node loopback.".to_string());
    }
    Ok(target)
}

fn collect_response_headers(headers: &reqwest::header::HeaderMap) -> BTreeMap<String, String> {
    let mut exposed = BTreeMap::new();
    for name in EXPOSED_RESPONSE_HEADERS {
        if let Some(value) = headers.get(*name).and_then(|value| value.to_str().ok()) {
            exposed.insert((*name).to_string(), value.to_string());
        }
    }
    exposed
}

fn read_bounded_http_line<R: BufRead>(reader: &mut R) -> Result<Option<Vec<u8>>, String> {
    let mut line = Vec::with_capacity(256);
    loop {
        let buffer = reader
            .fill_buf()
            .map_err(|error| format!("Header HTTP Connector non leggibile: {error}"))?;
        if buffer.is_empty() {
            return if line.is_empty() { Ok(None) } else { Ok(Some(line)) };
        }
        let take = buffer
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|index| index + 1)
            .unwrap_or(buffer.len());
        if line.len().saturating_add(take) > MAX_HTTP_LINE_BYTES {
            return Err("Riga header HTTP Connector troppo grande.".to_string());
        }
        line.extend_from_slice(&buffer[..take]);
        reader.consume(take);
        if line.last() == Some(&b'\n') {
            return Ok(Some(line));
        }
    }
}

fn read_http_head<R: BufRead>(reader: &mut R) -> Result<Vec<String>, String> {
    let mut lines = Vec::new();
    let mut total = 0usize;
    loop {
        let raw = read_bounded_http_line(reader)?
            .ok_or_else(|| "Connessione chiusa durante gli header Connector.".to_string())?;
        total = total.saturating_add(raw.len());
        if total > MAX_HTTP_HEADERS_BYTES {
            return Err("Header HTTP Connector troppo grande.".to_string());
        }
        if raw == b"\r\n" || raw == b"\n" {
            break;
        }
        if lines.len() >= MAX_HTTP_HEADER_COUNT + 1 {
            return Err("Troppi header HTTP Connector.".to_string());
        }
        let line = std::str::from_utf8(&raw)
            .map_err(|_| "Header HTTP Connector non UTF-8/ASCII valido.".to_string())?
            .trim_end_matches(&['\r', '\n'][..])
            .to_string();
        lines.push(line);
    }
    Ok(lines)
}

fn parse_request_line(value: &str) -> Result<(String, String), String> {
    let mut parts = value.split_whitespace();
    let method = parts
        .next()
        .ok_or_else(|| "Metodo HTTP mancante.".to_string())?;
    let target = parts
        .next()
        .ok_or_else(|| "Target HTTP mancante.".to_string())?;
    let version = parts
        .next()
        .ok_or_else(|| "Versione HTTP mancante.".to_string())?;
    if parts.next().is_some() || !matches!(version, "HTTP/1.1" | "HTTP/1.0") {
        return Err("Request line HTTP non valida.".to_string());
    }
    if !target.starts_with('/') || target.starts_with("//") || target.contains("://") {
        return Err("Target HTTP Connector deve essere un path origin-form.".to_string());
    }
    Ok((method.to_ascii_uppercase(), target.to_string()))
}

fn valid_http_header_name(name: &str) -> bool {
    !name.is_empty()
        && name.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b'!' | b'#' | b'$' | b'%' | b'&' | b'\'' | b'*' | b'+' | b'-' | b'.' | b'^' | b'_' | b'`' | b'|' | b'~')
        })
}

fn parse_http_headers(lines: &[String]) -> Result<BTreeMap<String, String>, String> {
    if lines.len() > MAX_HTTP_HEADER_COUNT {
        return Err("Troppi header HTTP Connector.".to_string());
    }
    let mut headers = BTreeMap::new();
    for line in lines {
        if line.as_bytes().first().is_some_and(u8::is_ascii_whitespace) {
            return Err("Header HTTP folded/non valido.".to_string());
        }
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| "Header HTTP Connector non valido.".to_string())?;
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim();
        if !valid_http_header_name(&name)
            || value.contains('\r')
            || value.contains('\n')
            || value.chars().any(|ch| ch.is_control() && ch != '\t')
        {
            return Err("Header HTTP Connector non valido.".to_string());
        }
        if headers.insert(name, value.to_string()).is_some() {
            return Err("Header HTTP Connector duplicato.".to_string());
        }
    }
    Ok(headers)
}

fn write_health(stream: &mut SharedTlsStream) -> Result<(), String> {
    let node_reachable = TcpStream::connect_timeout(
        &"127.0.0.1:3000"
            .parse()
            .map_err(|_| "Indirizzo Node interno non valido.".to_string())?,
        Duration::from_millis(500),
    )
    .is_ok();
    write_json(
        stream,
        200,
        &HealthResponse {
            protocol_version: PROTOCOL_VERSION,
            connector_version: env!("CARGO_PKG_VERSION"),
            status: "ready",
            upstream: "node-loopback",
            node_reachable,
        },
    )
}

fn write_connector_error(
    stream: &mut SharedTlsStream,
    status: u16,
    request_id: Option<&str>,
    error_code: &str,
    message: &str,
) -> Result<(), String> {
    write_json(
        stream,
        status,
        &ConnectorErrorResponse {
            protocol_version: PROTOCOL_VERSION,
            request_id,
            error_code,
            message,
        },
    )
}

fn write_json<T: Serialize>(stream: &mut SharedTlsStream, status: u16, payload: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec(payload)
        .map_err(|error| format!("Impossibile serializzare risposta Connector: {error}"))?;
    write!(
        stream,
        "HTTP/1.1 {} {}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        status,
        reason_phrase(status),
        bytes.len()
    )
    .map_err(|error| format!("Impossibile scrivere risposta Connector: {error}"))?;
    stream
        .write_all(&bytes)
        .map_err(|error| format!("Impossibile scrivere body Connector: {error}"))?;
    stream.flush().ok();
    Ok(())
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
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        416 => "Range Not Satisfiable",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "Response",
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_media_upstream_target, build_upstream_target, normalize_api_path,
        normalize_bind_ip,
        normalize_application_headers, normalize_body, normalize_media_path, normalize_method,
        normalize_upload_content_type, normalize_upload_path, pairing_upstream_target,
        validate_connector_request, validate_media_request,
        parse_http_headers, parse_request_line, read_http_head, validate_pairing_request,
        ConnectionLimiter, ConnectorMediaRequest, ConnectorPairingRequest, ConnectorRequest,
        DeviceAuthorization, MediaAuthorization, PairingPayload, MAX_ACTIVE_CONNECTIONS_PER_IP,
        MAX_CONNECTION_STARTS_PER_WINDOW, NODE_PAIRING_PATH, PROTOCOL_VERSION, UPSTREAM_BASE_URL,
        UPSTREAM_UPLOAD_REQUEST_TIMEOUT,
    };
    use std::{collections::BTreeMap, io::BufReader, net::{IpAddr, Ipv4Addr}, sync::Arc};
    use uuid::Uuid;

    fn fixture() -> ConnectorRequest {
        ConnectorRequest {
            protocol_version: PROTOCOL_VERSION,
            request_id: Uuid::new_v4().to_string(),
            method: "GET".to_string(),
            path: "/api/movies?limit=10".to_string(),
            headers: BTreeMap::new(),
            body: None,
            access_grant: "grant-fixture".to_string(),
            device_auth: DeviceAuthorization {
                device_id: Uuid::new_v4().to_string(),
                timestamp: 1_700_000_000,
                nonce: "nonce-fixture".to_string(),
                signature: "signature-fixture".to_string(),
            },
        }
    }

    fn media_fixture() -> ConnectorMediaRequest {
        ConnectorMediaRequest {
            protocol_version: PROTOCOL_VERSION,
            request_id: Uuid::new_v4().to_string(),
            method: "GET".to_string(),
            path: "/api/movies/12/stream".to_string(),
            range: Some("bytes=1048576-".to_string()),
            if_range: None,
            access_grant: "grant-fixture".to_string(),
            device_auth: MediaAuthorization {
                device_id: Uuid::new_v4().to_string(),
                expires: 1_800_000_000,
                signature: "signature-fixture".to_string(),
            },
        }
    }


    fn pairing_fixture() -> ConnectorPairingRequest {
        ConnectorPairingRequest {
            protocol_version: PROTOCOL_VERSION,
            request_id: Uuid::new_v4().to_string(),
            pairing: PairingPayload {
                invite_token: "invite-fixture".to_string(),
                installation_id: Uuid::new_v4().to_string(),
                public_key: "public-key-fixture".to_string(),
                signature: "signature-fixture".to_string(),
                device_name: "PC staging".to_string(),
            },
        }
    }

    #[test]
    fn protocol_v1_accepts_only_relative_baia_api_paths() {
        assert_eq!(normalize_api_path("/api/movies?limit=10").unwrap(), "/api/movies?limit=10");
        assert!(normalize_api_path("https://evil.invalid/api/movies").is_err());
        assert!(normalize_api_path("/admin").is_err());
        assert!(normalize_api_path("/api/../admin").is_err());
        assert!(normalize_api_path("/api/movies#frag").is_err());
    }

    #[test]
    fn phase4a4_bind_accepts_only_loopback_or_private_ipv4() {
        assert!(normalize_bind_ip("127.0.0.1").is_ok());
        assert!(normalize_bind_ip("192.168.1.50").is_ok());
        assert!(normalize_bind_ip("10.20.30.40").is_ok());
        assert!(normalize_bind_ip("172.16.5.9").is_ok());
        assert!(normalize_bind_ip("0.0.0.0").is_err());
        assert!(normalize_bind_ip("8.8.8.8").is_err());
        assert!(normalize_bind_ip("localhost").is_err());
    }

    #[test]
    fn connector_has_one_fixed_node_loopback_upstream() {
        let target = build_upstream_target("/api/movies").unwrap();
        assert_eq!(target.origin().ascii_serialization(), UPSTREAM_BASE_URL);
        assert_eq!(target.as_str(), "http://127.0.0.1:3000/api/movies");
    }

    #[test]
    fn frontend_cannot_smuggle_device_headers_or_arbitrary_methods() {
        let mut headers = BTreeMap::new();
        headers.insert("X-Baia-Signature".to_string(), "forged".to_string());
        assert!(normalize_application_headers(headers).is_err());
        assert!(normalize_method("DELETE").is_err());
        assert!(normalize_body("GET", Some("payload".to_string())).is_err());
    }

    #[test]
    fn protocol_requires_ids_and_device_authorization_structure() {
        assert!(validate_connector_request(fixture()).is_ok());
        let mut bad = fixture();
        bad.request_id = "not-a-uuid".to_string();
        assert!(validate_connector_request(bad).is_err());
        let mut bad = fixture();
        bad.device_auth.signature = "".to_string();
        assert!(validate_connector_request(bad).is_err());
        let mut bad = fixture();
        bad.protocol_version = 2;
        assert!(validate_connector_request(bad).is_err());
    }

    #[test]
    fn media_protocol_accepts_only_allowlisted_logical_paths() {
        assert_eq!(
            normalize_media_path("/api/movies/12/stream").unwrap(),
            "/api/movies/12/stream"
        );
        assert_eq!(
            normalize_media_path("/api/reading/21/reader/entry/0").unwrap(),
            "/api/reading/21/reader/entry/0"
        );
        assert!(normalize_media_path("https://evil.invalid/api/movies/12/stream").is_err());
        assert_eq!(
            normalize_media_path("/api/movies/12/poster").unwrap(),
            "/api/movies/12/poster"
        );
        assert_eq!(
            normalize_media_path("/api/series/123e4567-e89b-42d3-a456-426614174000/poster").unwrap(),
            "/api/series/123e4567-e89b-42d3-a456-426614174000/poster"
        );
        assert_eq!(
            normalize_media_path("/api/music/albums/223e4567-e89b-42d3-a456-426614174000/cover").unwrap(),
            "/api/music/albums/223e4567-e89b-42d3-a456-426614174000/cover"
        );
        assert_eq!(
            normalize_media_path("/api/reading/21/cover").unwrap(),
            "/api/reading/21/cover"
        );
        assert!(normalize_media_path("/api/series/not-a-uuid/poster").is_err());
        assert!(normalize_media_path("/api/music/albums/not-a-uuid/cover").is_err());
        assert!(normalize_media_path("/api/movies/12/poster?v=1").is_err());
        assert!(normalize_media_path("/api/reading/21/cover?v=1").is_err());
        assert!(normalize_media_path("/api/reading/21/reader/manifest").is_err());
    }

    #[test]
    fn media_protocol_preserves_range_but_rejects_arbitrary_methods() {
        assert!(validate_media_request(media_fixture()).is_ok());

        let mut bad = media_fixture();
        bad.method = "POST".to_string();
        assert!(validate_media_request(bad).is_err());

        let mut bad = media_fixture();
        bad.range = Some("items=0-10".to_string());
        assert!(validate_media_request(bad).is_err());
    }

    #[test]
    fn media_upstream_is_always_built_from_fixed_node_loopback() {
        let authorization = MediaAuthorization {
            device_id: Uuid::new_v4().to_string(),
            expires: 1_800_000_000,
            signature: "signature-fixture".to_string(),
        };
        let target = build_media_upstream_target("/api/movies/12/stream", &authorization).unwrap();
        assert_eq!(target.origin().ascii_serialization(), UPSTREAM_BASE_URL);
        assert_eq!(target.path(), "/api/movies/12/stream");
        assert_eq!(
            target.query_pairs().find(|(name, _)| name == "_baia_device").map(|(_, value)| value.into_owned()),
            Some(authorization.device_id)
        );
    }

    #[test]
    fn pairing_protocol_is_specific_and_rejects_invalid_identity_fields() {
        assert!(validate_pairing_request(pairing_fixture()).is_ok());

        let mut bad = pairing_fixture();
        bad.protocol_version = 2;
        assert!(validate_pairing_request(bad).is_err());

        let mut bad = pairing_fixture();
        bad.pairing.installation_id = "not-a-uuid".to_string();
        assert!(validate_pairing_request(bad).is_err());

        let mut bad = pairing_fixture();
        bad.pairing.invite_token = "\n".to_string();
        assert!(validate_pairing_request(bad).is_err());
    }

    #[test]
    fn pairing_upstream_is_fixed_to_node_redeem_route() {
        let target = pairing_upstream_target().unwrap();
        assert_eq!(target.origin().ascii_serialization(), UPSTREAM_BASE_URL);
        assert_eq!(target.path(), NODE_PAIRING_PATH);
        assert_eq!(target.as_str(), "http://127.0.0.1:3000/api/pairing/redeem");
    }


    #[test]
    fn upload_protocol_accepts_only_native_upload_paths() {
        assert_eq!(
            normalize_upload_path("/api/uploads/movies").unwrap(),
            "/api/uploads/movies"
        );
        assert_eq!(
            normalize_upload_path("/api/uploads/reading/books").unwrap(),
            "/api/uploads/reading/books"
        );
        assert_eq!(
            normalize_upload_path("/api/uploads/music/sessions").unwrap(),
            "/api/uploads/music/sessions"
        );
        assert!(normalize_upload_path("/api/uploads/status").is_err());
        assert!(normalize_upload_path("/api/uploads/reading/../../secret").is_err());
        assert!(normalize_upload_path("https://evil.invalid/api/uploads/movies").is_err());
    }

    #[test]
    fn upload_client_has_no_total_request_timeout() {
        assert_eq!(UPSTREAM_UPLOAD_REQUEST_TIMEOUT, None);
    }

    #[test]
    fn upload_content_type_requires_multipart_boundary() {
        assert!(
            normalize_upload_content_type("multipart/form-data; boundary=baia-123").is_ok()
        );
        assert!(normalize_upload_content_type("application/json").is_err());
        assert!(normalize_upload_content_type("multipart/form-data").is_err());
    }

    #[test]
    fn internet_facing_http_parser_rejects_duplicate_headers_and_absolute_targets() {
        assert!(parse_request_line("POST /baia/v1/request HTTP/1.1").is_ok());
        assert!(parse_request_line("POST https://evil.invalid/baia/v1/request HTTP/1.1").is_err());
        assert!(parse_request_line("POST //evil.invalid/baia/v1/request HTTP/1.1").is_err());

        let duplicate = vec![
            "Content-Length: 10".to_string(),
            "content-length: 11".to_string(),
        ];
        assert!(parse_http_headers(&duplicate).is_err());
        assert!(parse_http_headers(&[" Bad: folded".to_string()]).is_err());
    }

    #[test]
    fn internet_facing_http_head_is_bounded_before_unlimited_allocation() {
        let valid = b"GET /baia/v1/health HTTP/1.1\r\nHost: fixture\r\n\r\n";
        let mut reader = BufReader::new(valid.as_slice());
        let lines = read_http_head(&mut reader).unwrap();
        assert_eq!(lines[0], "GET /baia/v1/health HTTP/1.1");

        let oversized = format!("GET /{} HTTP/1.1\r\n\r\n", "a".repeat(9 * 1024));
        let mut reader = BufReader::new(oversized.as_bytes());
        assert!(read_http_head(&mut reader).is_err());
    }

    #[test]
    fn connection_limiter_caps_each_source_ip_and_releases_permits() {
        let limiter = Arc::new(ConnectionLimiter::new());
        let ip = IpAddr::V4(Ipv4Addr::new(203, 0, 113, 10));
        let mut permits = Vec::new();
        for _ in 0..MAX_ACTIVE_CONNECTIONS_PER_IP {
            permits.push(limiter.try_acquire(ip).expect("permit atteso"));
        }
        assert!(limiter.try_acquire(ip).is_none());
        permits.pop();
        assert!(limiter.try_acquire(ip).is_some());
    }

    #[test]
    fn connection_limiter_caps_connection_start_rate_globally() {
        let limiter = Arc::new(ConnectionLimiter::new());
        let ip = IpAddr::V4(Ipv4Addr::new(203, 0, 113, 11));
        for _ in 0..MAX_CONNECTION_STARTS_PER_WINDOW {
            let permit = limiter.try_acquire(ip).expect("permit rate atteso");
            drop(permit);
        }
        assert!(limiter.try_acquire(ip).is_none());
    }

}
