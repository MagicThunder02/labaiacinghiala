use crate::server_identity::ServerIdentity;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ring::digest::{digest, Context, SHA256};
use rustls::{
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    crypto::{self, aws_lc_rs, WebPkiSupportedAlgorithms},
    pki_types::{CertificateDer, ServerName, UnixTime},
    ClientConfig, DigitallySignedStruct, Error as TlsError, SignatureScheme,
};
use std::{
    collections::HashMap,
    env,
    net::{SocketAddrV4},
    sync::Arc,
    thread,
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::TcpStream,
    sync::{mpsc, oneshot, Mutex},
    time::{interval, sleep, timeout},
};
use tokio_rustls::TlsConnector;
use url::Url;
use uuid::Uuid;

pub const RELAY_ENDPOINT_ENV: &str = "BAIA_RELAY_ENDPOINT";
pub const RELAY_CERT_FINGERPRINT_ENV: &str = "BAIA_RELAY_CERT_FINGERPRINT";
const RELAY_PROTOCOL_VERSION: u8 = 1;
const FRAME_HEADER_BYTES: usize = 16;
const MAX_DATA_PAYLOAD_BYTES: usize = 64 * 1024;
const MAX_CONTROL_PAYLOAD_BYTES: usize = 16 * 1024;
const MAX_CONCURRENT_STREAMS: usize = 64;
const FRAME_QUEUE_CAPACITY: usize = 128;
const STREAM_QUEUE_CAPACITY: usize = 4;
const AUTH_TIMEOUT: Duration = Duration::from_secs(10);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(20);
const SESSION_DEAD_TIMEOUT: Duration = Duration::from_secs(60);
const SERVER_ID_DOMAIN: &[u8] = b"baia-server-id-v1\0";
const SERVER_AUTH_DOMAIN: &[u8] = b"baia-relay-server-auth-v1\0";
const RELAY_ACCESS_GRANT_DOMAIN: &[u8] = b"baia-relay-access-grant-v1\0";
const SERVER_ID_BYTES: usize = 32;
const PUBLIC_KEY_BYTES: usize = 32;
const SIGNATURE_BYTES: usize = 64;
const CHALLENGE_BYTES: usize = 32;
const DEVICE_ID_BYTES: usize = 16;
const GRANT_ID_BYTES: usize = 16;
const GRANT_UNSIGNED_BYTES: usize = 1 + 32 + 16 + 32 + 16 + 8 + 2;
const GRANT_BYTES: usize = GRANT_UNSIGNED_BYTES + SIGNATURE_BYTES;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
enum FrameType {
    ServerHello = 0x01,
    ClientHello = 0x02,
    Challenge = 0x03,
    ServerAuth = 0x04,
    ClientAuth = 0x05,
    AuthOk = 0x06,
    Error = 0x07,
    Open = 0x10,
    OpenOk = 0x11,
    Data = 0x12,
    Fin = 0x13,
    Reset = 0x14,
    Ping = 0x20,
    Pong = 0x21,
}

impl FrameType {
    fn from_u8(value: u8) -> Result<Self, String> {
        match value {
            0x01 => Ok(Self::ServerHello),
            0x02 => Ok(Self::ClientHello),
            0x03 => Ok(Self::Challenge),
            0x04 => Ok(Self::ServerAuth),
            0x05 => Ok(Self::ClientAuth),
            0x06 => Ok(Self::AuthOk),
            0x07 => Ok(Self::Error),
            0x10 => Ok(Self::Open),
            0x11 => Ok(Self::OpenOk),
            0x12 => Ok(Self::Data),
            0x13 => Ok(Self::Fin),
            0x14 => Ok(Self::Reset),
            0x20 => Ok(Self::Ping),
            0x21 => Ok(Self::Pong),
            _ => Err("Tipo frame relay sconosciuto.".to_string()),
        }
    }

    fn is_stream(self) -> bool {
        matches!(self, Self::Open | Self::OpenOk | Self::Data | Self::Fin | Self::Reset)
    }
}

#[derive(Debug, Clone)]
struct Frame {
    frame_type: FrameType,
    stream_id: u64,
    payload: Vec<u8>,
}

fn frame(frame_type: FrameType, stream_id: u64, payload: Vec<u8>) -> Frame {
    Frame { frame_type, stream_id, payload }
}

async fn read_frame<R: AsyncRead + Unpin>(reader: &mut R) -> Result<Frame, String> {
    let mut header = [0u8; FRAME_HEADER_BYTES];
    reader
        .read_exact(&mut header)
        .await
        .map_err(|error| format!("Header frame relay non leggibile: {error}"))?;
    if header[0] != RELAY_PROTOCOL_VERSION || header[2] != 0 || header[3] != 0 {
        return Err("Header frame relay incompatibile.".to_string());
    }
    let frame_type = FrameType::from_u8(header[1])?;
    let stream_id = u64::from_be_bytes(header[4..12].try_into().unwrap());
    if frame_type.is_stream() != (stream_id != 0) {
        return Err("Stream ID relay non valido.".to_string());
    }
    let payload_len = u32::from_be_bytes(header[12..16].try_into().unwrap()) as usize;
    let max = if frame_type == FrameType::Data {
        MAX_DATA_PAYLOAD_BYTES
    } else {
        MAX_CONTROL_PAYLOAD_BYTES
    };
    if payload_len > max {
        return Err("Payload frame relay troppo grande.".to_string());
    }
    let mut payload = vec![0u8; payload_len];
    if payload_len != 0 {
        reader
            .read_exact(&mut payload)
            .await
            .map_err(|error| format!("Payload frame relay non leggibile: {error}"))?;
    }
    Ok(Frame { frame_type, stream_id, payload })
}

async fn write_frame<W: AsyncWrite + Unpin>(writer: &mut W, frame: &Frame) -> Result<(), String> {
    let max = if frame.frame_type == FrameType::Data {
        MAX_DATA_PAYLOAD_BYTES
    } else {
        MAX_CONTROL_PAYLOAD_BYTES
    };
    if frame.payload.len() > max || frame.frame_type.is_stream() != (frame.stream_id != 0) {
        return Err("Frame relay in uscita non valido.".to_string());
    }
    let mut header = [0u8; FRAME_HEADER_BYTES];
    header[0] = RELAY_PROTOCOL_VERSION;
    header[1] = frame.frame_type as u8;
    header[4..12].copy_from_slice(&frame.stream_id.to_be_bytes());
    header[12..16].copy_from_slice(&(frame.payload.len() as u32).to_be_bytes());
    writer
        .write_all(&header)
        .await
        .map_err(|error| format!("Header frame relay non scrivibile: {error}"))?;
    if !frame.payload.is_empty() {
        writer
            .write_all(&frame.payload)
            .await
            .map_err(|error| format!("Payload frame relay non scrivibile: {error}"))?;
    }
    writer.flush().await.map_err(|error| format!("Flush relay fallito: {error}"))
}

#[derive(Clone, Debug)]
struct RelayEndpoint {
    host: String,
    port: u16,
}

impl RelayEndpoint {
    fn parse(value: &str) -> Result<Self, String> {
        let parsed = Url::parse(value.trim())
            .map_err(|_| format!("{RELAY_ENDPOINT_ENV} non valido."))?;
        if parsed.scheme() != "tls"
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
            || parsed.path() != ""
                && parsed.path() != "/"
        {
            return Err(format!(
                "{RELAY_ENDPOINT_ENV} deve essere tls://host:porta senza credenziali o path."
            ));
        }
        let host = parsed
            .host_str()
            .ok_or_else(|| format!("{RELAY_ENDPOINT_ENV} deve contenere un host."))?
            .to_string();
        Ok(Self {
            host,
            port: parsed.port().unwrap_or(443),
        })
    }

    fn socket_target(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}

fn decode_fingerprint(value: &str) -> Result<[u8; 32], String> {
    let encoded = value
        .trim()
        .strip_prefix("SHA256:")
        .ok_or_else(|| format!("{RELAY_CERT_FINGERPRINT_ENV} deve iniziare con SHA256:."))?;
    let decoded = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| format!("{RELAY_CERT_FINGERPRINT_ENV} non valida."))?;
    decoded
        .try_into()
        .map_err(|_| format!("{RELAY_CERT_FINGERPRINT_ENV} deve contenere 32 byte SHA-256."))
}

#[derive(Debug)]
struct PinnedRelayVerifier {
    expected: [u8; 32],
    supported_algorithms: WebPkiSupportedAlgorithms,
}

impl ServerCertVerifier for PinnedRelayVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, TlsError> {
        let actual = digest(&SHA256, end_entity.as_ref());
        if actual.as_ref() != self.expected.as_slice() {
            return Err(TlsError::General("Certificato TLS relay non corrisponde al pin configurato.".to_string()));
        }
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        Err(TlsError::General("TLS 1.2 non consentito dal relay Baia.".to_string()))
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        crypto::verify_tls13_signature(message, cert, dss, &self.supported_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.supported_algorithms.supported_schemes()
    }
}

fn tls_config(fingerprint: &str) -> Result<Arc<ClientConfig>, String> {
    let provider = aws_lc_rs::default_provider();
    let verifier = Arc::new(PinnedRelayVerifier {
        expected: decode_fingerprint(fingerprint)?,
        supported_algorithms: provider.signature_verification_algorithms,
    });
    let mut config = ClientConfig::builder_with_provider(Arc::new(provider))
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|error| format!("Impossibile limitare il relay client a TLS 1.3: {error}"))?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    config.alpn_protocols = vec![b"baia-relay-v1".to_vec()];
    Ok(Arc::new(config))
}

fn derive_server_id(public_key: &[u8; PUBLIC_KEY_BYTES]) -> [u8; SERVER_ID_BYTES] {
    let mut context = Context::new(&SHA256);
    context.update(SERVER_ID_DOMAIN);
    context.update(public_key);
    let digest = context.finish();
    digest.as_ref().try_into().expect("SHA-256 deve produrre 32 byte")
}

fn server_id_text(server_id: [u8; SERVER_ID_BYTES]) -> String {
    format!("srv1_{}", URL_SAFE_NO_PAD.encode(server_id))
}

fn build_server_auth_message(
    public_key: &[u8; PUBLIC_KEY_BYTES],
    challenge: &[u8; CHALLENGE_BYTES],
) -> Vec<u8> {
    let server_id = derive_server_id(public_key);
    let mut message = Vec::with_capacity(SERVER_AUTH_DOMAIN.len() + 1 + 32 + 32 + 32);
    message.extend_from_slice(SERVER_AUTH_DOMAIN);
    message.push(RELAY_PROTOCOL_VERSION);
    message.extend_from_slice(&server_id);
    message.extend_from_slice(public_key);
    message.extend_from_slice(challenge);
    message
}

pub struct IssuedRelayGrant {
    pub server_id: String,
    pub grant: String,
}

pub fn issue_access_grant(
    identity: &ServerIdentity,
    device_id: &str,
    device_public_key: &str,
) -> Result<IssuedRelayGrant, String> {
    let device_uuid = Uuid::parse_str(device_id)
        .map_err(|_| "Node ha restituito un device_id non valido per il grant relay.".to_string())?;
    let device_id_bytes = *device_uuid.as_bytes();
    let decoded_public_key = URL_SAFE_NO_PAD
        .decode(device_public_key.trim())
        .map_err(|_| "Chiave pubblica device pairing non valida per il grant relay.".to_string())?;
    let device_public_key: [u8; PUBLIC_KEY_BYTES] = decoded_public_key
        .try_into()
        .map_err(|_| "Chiave pubblica device pairing di lunghezza inattesa.".to_string())?;
    let server_public_key = identity.public_key();
    let server_id = derive_server_id(server_public_key);
    let grant_id = *Uuid::new_v4().as_bytes();
    let issued_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "Orologio di sistema non valido per il grant relay.".to_string())?
        .as_secs();

    let mut unsigned = [0u8; GRANT_UNSIGNED_BYTES];
    let mut offset = 0usize;
    unsigned[offset] = 1;
    offset += 1;
    unsigned[offset..offset + 32].copy_from_slice(&server_id);
    offset += 32;
    unsigned[offset..offset + DEVICE_ID_BYTES].copy_from_slice(&device_id_bytes);
    offset += DEVICE_ID_BYTES;
    unsigned[offset..offset + PUBLIC_KEY_BYTES].copy_from_slice(&device_public_key);
    offset += PUBLIC_KEY_BYTES;
    unsigned[offset..offset + GRANT_ID_BYTES].copy_from_slice(&grant_id);
    offset += GRANT_ID_BYTES;
    unsigned[offset..offset + 8].copy_from_slice(&issued_at.to_be_bytes());
    offset += 8;
    unsigned[offset..offset + 2].copy_from_slice(&(RELAY_PROTOCOL_VERSION as u16).to_be_bytes());

    let mut message = Vec::with_capacity(RELAY_ACCESS_GRANT_DOMAIN.len() + unsigned.len());
    message.extend_from_slice(RELAY_ACCESS_GRANT_DOMAIN);
    message.extend_from_slice(&unsigned);
    let signature = identity.sign_message(&message)?;

    let mut grant = [0u8; GRANT_BYTES];
    grant[..GRANT_UNSIGNED_BYTES].copy_from_slice(&unsigned);
    grant[GRANT_UNSIGNED_BYTES..].copy_from_slice(&signature);

    Ok(IssuedRelayGrant {
        server_id: server_id_text(server_id),
        grant: URL_SAFE_NO_PAD.encode(grant),
    })
}

pub fn start_if_configured(
    identity: Arc<ServerIdentity>,
    local_connector: SocketAddrV4,
) -> Result<bool, String> {
    let endpoint = env::var(RELAY_ENDPOINT_ENV).ok();
    let fingerprint = env::var(RELAY_CERT_FINGERPRINT_ENV).ok();
    match (endpoint, fingerprint) {
        (None, None) => Ok(false),
        (Some(endpoint), Some(fingerprint)) => {
            let endpoint = RelayEndpoint::parse(&endpoint)?;
            let tls_config = tls_config(&fingerprint)?;
            thread::Builder::new()
                .name("baia-relay-connector".to_string())
                .spawn(move || {
                    let runtime = match tokio::runtime::Builder::new_multi_thread()
                        .worker_threads(2)
                        .enable_all()
                        .build()
                    {
                        Ok(runtime) => runtime,
                        Err(error) => {
                            eprintln!("Runtime relay Connector non avviato: {error}");
                            return;
                        }
                    };
                    runtime.block_on(reconnect_loop(identity, endpoint, tls_config, local_connector));
                })
                .map_err(|error| format!("Impossibile avviare il worker relay Connector: {error}"))?;
            Ok(true)
        }
        _ => Err(format!(
            "Configura insieme {RELAY_ENDPOINT_ENV} e {RELAY_CERT_FINGERPRINT_ENV}."
        )),
    }
}

async fn reconnect_loop(
    identity: Arc<ServerIdentity>,
    endpoint: RelayEndpoint,
    tls_config: Arc<ClientConfig>,
    local_connector: SocketAddrV4,
) {
    let mut delay = Duration::from_secs(1);
    loop {
        match run_session(&identity, &endpoint, Arc::clone(&tls_config), local_connector).await {
            Ok(()) => eprintln!("Sessione relay Connector terminata; riconnessione in corso."),
            Err(error) => eprintln!("Relay Connector non disponibile: {error}"),
        }
        sleep(delay).await;
        delay = (delay * 2).min(Duration::from_secs(30));
    }
}

async fn run_session(
    identity: &ServerIdentity,
    endpoint: &RelayEndpoint,
    tls_config: Arc<ClientConfig>,
    local_connector: SocketAddrV4,
) -> Result<(), String> {
    let tcp = timeout(Duration::from_secs(10), TcpStream::connect(endpoint.socket_target()))
        .await
        .map_err(|_| "Timeout connessione TCP al relay.".to_string())?
        .map_err(|error| format!("Connessione TCP relay fallita: {error}"))?;
    let server_name = ServerName::try_from(endpoint.host.clone())
        .map_err(|_| "Hostname relay non valido per TLS.".to_string())?;
    let connector = TlsConnector::from(tls_config);
    let mut tls = timeout(Duration::from_secs(10), connector.connect(server_name, tcp))
        .await
        .map_err(|_| "Timeout handshake TLS relay.".to_string())?
        .map_err(|error| format!("Handshake TLS relay fallito: {error}"))?;

    let public_key = identity.public_key();
    let server_id = derive_server_id(public_key);
    let mut hello = Vec::with_capacity(64);
    hello.extend_from_slice(&server_id);
    hello.extend_from_slice(public_key);
    write_frame(&mut tls, &frame(FrameType::ServerHello, 0, hello)).await?;

    let challenge_frame = timeout(AUTH_TIMEOUT, read_frame(&mut tls))
        .await
        .map_err(|_| "Timeout CHALLENGE relay per Connector.".to_string())??;
    if challenge_frame.frame_type != FrameType::Challenge || challenge_frame.payload.len() != CHALLENGE_BYTES {
        return Err("CHALLENGE relay server non valida.".to_string());
    }
    let challenge: [u8; CHALLENGE_BYTES] = challenge_frame.payload.try_into().unwrap();
    let message = build_server_auth_message(public_key, &challenge);
    let signature = identity.sign_message(&message)?;
    write_frame(
        &mut tls,
        &frame(FrameType::ServerAuth, 0, signature.to_vec()),
    )
    .await?;
    let auth_ok = timeout(AUTH_TIMEOUT, read_frame(&mut tls))
        .await
        .map_err(|_| "Timeout AUTH_OK relay per Connector.".to_string())??;
    if auth_ok.frame_type != FrameType::AuthOk || !auth_ok.payload.is_empty() {
        return Err("Relay non ha confermato SERVER_AUTH.".to_string());
    }

    println!("relay=connected server_id={}", server_id_text(server_id));

    let (reader, writer) = tokio::io::split(tls);
    let (out_tx, out_rx) = mpsc::channel::<Frame>(FRAME_QUEUE_CAPACITY);
    let streams = Arc::new(Mutex::new(HashMap::<u64, mpsc::Sender<Frame>>::new()));
    let writer_task = tokio::spawn(writer_loop(writer, out_rx));
    let ping_task = tokio::spawn(ping_loop(out_tx.clone()));
    let result = reader_loop(reader, out_tx.clone(), Arc::clone(&streams), local_connector).await;

    ping_task.abort();
    writer_task.abort();
    let stream_senders = {
        let mut guard = streams.lock().await;
        guard.drain().map(|(_, tx)| tx).collect::<Vec<_>>()
    };
    for tx in stream_senders {
        let _ = tx.send(frame(FrameType::Reset, 1, Vec::new())).await;
    }
    result
}

async fn writer_loop<W: AsyncWrite + Unpin>(mut writer: W, mut rx: mpsc::Receiver<Frame>) {
    while let Some(frame) = rx.recv().await {
        if write_frame(&mut writer, &frame).await.is_err() {
            break;
        }
    }
}

async fn ping_loop(tx: mpsc::Sender<Frame>) {
    let mut ticker = interval(HEARTBEAT_INTERVAL);
    ticker.tick().await;
    loop {
        ticker.tick().await;
        if tx.send(frame(FrameType::Ping, 0, Vec::new())).await.is_err() {
            break;
        }
    }
}

async fn reader_loop<R: AsyncRead + Unpin>(
    mut reader: R,
    out_tx: mpsc::Sender<Frame>,
    streams: Arc<Mutex<HashMap<u64, mpsc::Sender<Frame>>>>,
    local_connector: SocketAddrV4,
) -> Result<(), String> {
    loop {
        let inbound = timeout(SESSION_DEAD_TIMEOUT, read_frame(&mut reader))
            .await
            .map_err(|_| "Sessione relay Connector scaduta senza traffico/PONG.".to_string())??;
        match inbound.frame_type {
            FrameType::Ping => {
                out_tx
                    .send(frame(FrameType::Pong, 0, Vec::new()))
                    .await
                    .map_err(|_| "Writer relay Connector terminato.".to_string())?;
            }
            FrameType::Pong => {}
            FrameType::Open => {
                if !inbound.payload.is_empty() {
                    let _ = out_tx.send(frame(FrameType::Reset, inbound.stream_id, Vec::new())).await;
                    continue;
                }
                let mut guard = streams.lock().await;
                if guard.len() >= MAX_CONCURRENT_STREAMS || guard.contains_key(&inbound.stream_id) {
                    drop(guard);
                    let _ = out_tx.send(frame(FrameType::Reset, inbound.stream_id, Vec::new())).await;
                    continue;
                }
                let (stream_tx, stream_rx) = mpsc::channel::<Frame>(STREAM_QUEUE_CAPACITY);
                guard.insert(inbound.stream_id, stream_tx);
                drop(guard);
                let streams_for_task = Arc::clone(&streams);
                let out_for_task = out_tx.clone();
                tokio::spawn(async move {
                    run_local_stream(
                        inbound.stream_id,
                        local_connector,
                        out_for_task,
                        stream_rx,
                    )
                    .await;
                    streams_for_task.lock().await.remove(&inbound.stream_id);
                });
            }
            FrameType::Data | FrameType::Fin | FrameType::Reset => {
                let tx = streams.lock().await.get(&inbound.stream_id).cloned();
                if let Some(tx) = tx {
                    let _ = tx.send(inbound).await;
                } else {
                    let _ = out_tx.send(frame(FrameType::Reset, inbound.stream_id, Vec::new())).await;
                }
            }
            _ => return Err("Frame inatteso dal relay sulla sessione Connector.".to_string()),
        }
    }
}

async fn run_local_stream(
    stream_id: u64,
    local_connector: SocketAddrV4,
    out_tx: mpsc::Sender<Frame>,
    mut inbound_rx: mpsc::Receiver<Frame>,
) {
    let local = match timeout(Duration::from_secs(5), TcpStream::connect(local_connector)).await {
        Ok(Ok(stream)) => stream,
        _ => {
            let _ = out_tx.send(frame(FrameType::Reset, stream_id, Vec::new())).await;
            return;
        }
    };
    let (mut local_reader, mut local_writer) = local.into_split();
    if out_tx
        .send(frame(FrameType::OpenOk, stream_id, Vec::new()))
        .await
        .is_err()
    {
        return;
    }

    let out_for_reader = out_tx.clone();
    let (local_done_tx, mut local_done_rx) = oneshot::channel::<bool>();
    let reader_task = tokio::spawn(async move {
        let mut buffer = vec![0u8; MAX_DATA_PAYLOAD_BYTES];
        let graceful = loop {
            match local_reader.read(&mut buffer).await {
                Ok(0) => {
                    let sent = out_for_reader
                        .send(frame(FrameType::Fin, stream_id, Vec::new()))
                        .await
                        .is_ok();
                    break sent;
                }
                Ok(count) => {
                    if out_for_reader
                        .send(frame(FrameType::Data, stream_id, buffer[..count].to_vec()))
                        .await
                        .is_err()
                    {
                        break false;
                    }
                }
                Err(_) => {
                    let _ = out_for_reader
                        .send(frame(FrameType::Reset, stream_id, Vec::new()))
                        .await;
                    break false;
                }
            }
        };
        let _ = local_done_tx.send(graceful);
    });

    let mut local_finished = false;
    let mut remote_finished = false;
    loop {
        tokio::select! {
            local_done = &mut local_done_rx, if !local_finished => {
                local_finished = true;
                match local_done {
                    Ok(true) if remote_finished => break,
                    Ok(true) => {}
                    _ => break,
                }
            }
            inbound = inbound_rx.recv() => {
                let Some(inbound) = inbound else { break; };
                match inbound.frame_type {
                    FrameType::Data if !remote_finished => {
                        if local_writer.write_all(&inbound.payload).await.is_err() {
                            let _ = out_tx.send(frame(FrameType::Reset, stream_id, Vec::new())).await;
                            break;
                        }
                    }
                    FrameType::Fin if !remote_finished => {
                        let _ = local_writer.shutdown().await;
                        remote_finished = true;
                        if local_finished { break; }
                    }
                    FrameType::Reset => break,
                    _ => break,
                }
            }
        }
    }

    if !local_finished {
        reader_task.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::{derive_server_id, RelayEndpoint, RELAY_PROTOCOL_VERSION};

    #[test]
    fn relay_endpoint_is_fixed_tls_origin() {
        let endpoint = RelayEndpoint::parse("tls://relay.example.test:443").unwrap();
        assert_eq!(endpoint.host, "relay.example.test");
        assert_eq!(endpoint.port, 443);
        assert!(RelayEndpoint::parse("http://relay.example.test:443").is_err());
        assert!(RelayEndpoint::parse("tls://relay.example.test:443/path").is_err());
    }

    #[test]
    fn server_id_derivation_is_domain_separated() {
        assert_eq!(RELAY_PROTOCOL_VERSION, 1);
        assert_ne!(derive_server_id(&[0u8; 32]), [0u8; 32]);
    }
}
