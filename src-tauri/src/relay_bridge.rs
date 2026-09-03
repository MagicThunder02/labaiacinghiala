use crate::{core::CoreState, identity};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rustls::{
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    crypto::{self, aws_lc_rs, WebPkiSupportedAlgorithms},
    pki_types::{CertificateDer, ServerName, UnixTime},
    ClientConfig, DigitallySignedStruct, Error as TlsError, SignatureScheme,
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    net::TcpListener as StdTcpListener,
    sync::Arc,
    thread,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{mpsc, oneshot, Mutex},
    time::{interval, sleep, timeout},
};
use tokio_rustls::TlsConnector;
use url::Url;

pub const RELAY_ENDPOINT_ENV: &str = "BAIA_RELAY_ENDPOINT";
pub const RELAY_CERT_FINGERPRINT_ENV: &str = "BAIA_RELAY_CERT_FINGERPRINT";
pub const LOCAL_RELAY_CONNECTOR_ENDPOINT: &str = "https://127.0.0.1:43128";
const LOCAL_RELAY_BIND: &str = "127.0.0.1:43128";
const RELAY_PROTOCOL_VERSION: u8 = 1;
const FRAME_HEADER_BYTES: usize = 16;
const MAX_DATA_PAYLOAD_BYTES: usize = 64 * 1024;
const MAX_CONTROL_PAYLOAD_BYTES: usize = 16 * 1024;
const MAX_CONCURRENT_STREAMS: usize = 64;
const FRAME_QUEUE_CAPACITY: usize = 128;
const STREAM_QUEUE_CAPACITY: usize = 4;
const AUTH_TIMEOUT: Duration = Duration::from_secs(10);
const STREAM_OPEN_TIMEOUT: Duration = Duration::from_secs(5);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(20);
const SESSION_DEAD_TIMEOUT: Duration = Duration::from_secs(60);
const CLIENT_AUTH_DOMAIN: &[u8] = b"baia-relay-client-auth-v1\0";
const SERVER_ID_BYTES: usize = 32;
const DEVICE_PUBLIC_KEY_BYTES: usize = 32;
const CHALLENGE_BYTES: usize = 32;
const SIGNATURE_BYTES: usize = 64;
const GRANT_BYTES: usize = 171;
const CLIENT_HELLO_BYTES: usize = 32 + 32 + GRANT_BYTES;
const GRANT_DEVICE_PUBLIC_KEY_OFFSET: usize = 1 + 32 + 16;

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

pub fn normalize_relay_endpoint(value: &str) -> Result<String, String> {
    let parsed = Url::parse(value.trim())
        .map_err(|_| format!("{RELAY_ENDPOINT_ENV} non valido."))?;
    if parsed.scheme() != "tls"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || (parsed.path() != "" && parsed.path() != "/")
    {
        return Err(format!(
            "{RELAY_ENDPOINT_ENV} deve essere tls://host:porta senza credenziali o path."
        ));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| format!("{RELAY_ENDPOINT_ENV} deve contenere un host."))?;
    let port = parsed.port().unwrap_or(443);
    Ok(format!("tls://{host}:{port}"))
}

fn parse_relay_endpoint(value: &str) -> Result<RelayEndpoint, String> {
    let normalized = normalize_relay_endpoint(value)?;
    let parsed = Url::parse(&normalized).map_err(|_| "Endpoint relay normalizzato non valido.".to_string())?;
    Ok(RelayEndpoint {
        host: parsed.host_str().unwrap().to_string(),
        port: parsed.port().unwrap_or(443),
    })
}

pub fn normalize_relay_cert_fingerprint(value: &str) -> Result<String, String> {
    let input = value.trim();
    let encoded = input
        .strip_prefix("SHA256:")
        .ok_or_else(|| format!("{RELAY_CERT_FINGERPRINT_ENV} deve iniziare con SHA256:."))?;
    let decoded = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| format!("{RELAY_CERT_FINGERPRINT_ENV} non valida."))?;
    if decoded.len() != 32 {
        return Err(format!("{RELAY_CERT_FINGERPRINT_ENV} deve contenere 32 byte SHA-256."));
    }
    Ok(format!("SHA256:{}", URL_SAFE_NO_PAD.encode(decoded)))
}

fn decode_fingerprint(value: &str) -> Result<[u8; 32], String> {
    let normalized = normalize_relay_cert_fingerprint(value)?;
    URL_SAFE_NO_PAD
        .decode(normalized.trim_start_matches("SHA256:"))
        .map_err(|_| "Fingerprint relay non valida.".to_string())?
        .try_into()
        .map_err(|_| "Fingerprint relay di lunghezza inattesa.".to_string())
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
        let actual = Sha256::digest(end_entity.as_ref());
        if actual.as_slice() != self.expected.as_slice() {
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

#[derive(Clone)]
struct RelayConfig {
    endpoint: RelayEndpoint,
    tls_config: Arc<ClientConfig>,
    grant: [u8; GRANT_BYTES],
    server_id: [u8; SERVER_ID_BYTES],
    device_public_key: [u8; DEVICE_PUBLIC_KEY_BYTES],
}

fn relay_config_from_state(state: &CoreState) -> Result<Option<RelayConfig>, String> {
    let Some((endpoint, cert_fingerprint, grant_text, expected_server_id)) = state.relay_context()? else {
        return Ok(None);
    };
    let decoded = URL_SAFE_NO_PAD
        .decode(grant_text)
        .map_err(|_| "RelayAccessGrant locale non è base64url valido.".to_string())?;
    let grant: [u8; GRANT_BYTES] = decoded
        .try_into()
        .map_err(|_| format!("RelayAccessGrant locale deve essere lungo {GRANT_BYTES} byte."))?;
    if grant[0] != 1 {
        return Err("Versione RelayAccessGrant non supportata.".to_string());
    }
    let server_id: [u8; SERVER_ID_BYTES] = grant[1..33].try_into().unwrap();
    let server_id_text = format!("srv1_{}", URL_SAFE_NO_PAD.encode(server_id));
    if server_id_text != expected_server_id {
        return Err("server_id locale non corrisponde al RelayAccessGrant.".to_string());
    }
    let device_public_key: [u8; DEVICE_PUBLIC_KEY_BYTES] = grant
        [GRANT_DEVICE_PUBLIC_KEY_OFFSET..GRANT_DEVICE_PUBLIC_KEY_OFFSET + DEVICE_PUBLIC_KEY_BYTES]
        .try_into()
        .unwrap();
    let local_public_key = identity::device_public_key_bytes()?;
    if device_public_key != local_public_key {
        return Err("RelayAccessGrant appartiene a una diversa identità device.".to_string());
    }

    Ok(Some(RelayConfig {
        endpoint: parse_relay_endpoint(&endpoint)?,
        tls_config: tls_config(&cert_fingerprint)?,
        grant,
        server_id,
        device_public_key,
    }))
}

pub struct RelayBridge {
    enabled: bool,
}

impl RelayBridge {
    pub fn start_if_configured(state: &CoreState) -> Result<Self, String> {
        let Some(config) = relay_config_from_state(state)? else {
            return Ok(Self { enabled: false });
        };

        let listener = StdTcpListener::bind(LOCAL_RELAY_BIND)
            .map_err(|error| format!("Impossibile aprire il bridge relay locale {LOCAL_RELAY_BIND}: {error}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("Impossibile rendere non bloccante il bridge relay: {error}"))?;

        thread::Builder::new()
            .name("baia-relay-bridge".to_string())
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        eprintln!("Runtime bridge relay non avviato: {error}");
                        return;
                    }
                };
                let listener = match TcpListener::from_std(listener) {
                    Ok(listener) => listener,
                    Err(error) => {
                        eprintln!("Bridge relay locale non inizializzato: {error}");
                        return;
                    }
                };
                runtime.block_on(reconnect_loop(listener, config));
            })
            .map_err(|error| format!("Impossibile avviare il thread bridge relay: {error}"))?;

        Ok(Self { enabled: true })
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }
}

async fn reconnect_loop(listener: TcpListener, config: RelayConfig) {
    let mut delay = Duration::from_secs(1);
    loop {
        match run_session(&listener, &config).await {
            Ok(()) => eprintln!("Sessione client relay terminata; riconnessione in corso."),
            Err(error) => eprintln!("Relay client non disponibile: {error}"),
        }
        sleep(delay).await;
        delay = (delay * 2).min(Duration::from_secs(30));
    }
}

async fn run_session(listener: &TcpListener, config: &RelayConfig) -> Result<(), String> {
    let target = format!("{}:{}", config.endpoint.host, config.endpoint.port);
    let tcp = timeout(Duration::from_secs(10), TcpStream::connect(target))
        .await
        .map_err(|_| "Timeout connessione TCP al relay.".to_string())?
        .map_err(|error| format!("Connessione TCP relay fallita: {error}"))?;
    let server_name = ServerName::try_from(config.endpoint.host.clone())
        .map_err(|_| "Hostname relay non valido per TLS.".to_string())?;
    let connector = TlsConnector::from(Arc::clone(&config.tls_config));
    let mut tls = timeout(Duration::from_secs(10), connector.connect(server_name, tcp))
        .await
        .map_err(|_| "Timeout handshake TLS relay.".to_string())?
        .map_err(|error| format!("Handshake TLS relay fallito: {error}"))?;

    let mut hello = Vec::with_capacity(CLIENT_HELLO_BYTES);
    hello.extend_from_slice(&config.server_id);
    hello.extend_from_slice(&config.device_public_key);
    hello.extend_from_slice(&config.grant);
    write_frame(&mut tls, &frame(FrameType::ClientHello, 0, hello)).await?;

    let challenge_frame = timeout(AUTH_TIMEOUT, read_frame(&mut tls))
        .await
        .map_err(|_| "Timeout CHALLENGE relay client.".to_string())??;
    if challenge_frame.frame_type != FrameType::Challenge || challenge_frame.payload.len() != CHALLENGE_BYTES {
        return Err("CHALLENGE relay client non valida.".to_string());
    }
    let grant_hash = Sha256::digest(config.grant);
    let mut message = Vec::with_capacity(CLIENT_AUTH_DOMAIN.len() + 1 + 32 + 32 + 32 + 32);
    message.extend_from_slice(CLIENT_AUTH_DOMAIN);
    message.push(RELAY_PROTOCOL_VERSION);
    message.extend_from_slice(&config.server_id);
    message.extend_from_slice(&config.device_public_key);
    message.extend_from_slice(&grant_hash);
    message.extend_from_slice(&challenge_frame.payload);
    let signature_text = identity::sign_device_message(&message)?;
    let signature: [u8; SIGNATURE_BYTES] = URL_SAFE_NO_PAD
        .decode(signature_text)
        .map_err(|_| "Firma device relay non valida.".to_string())?
        .try_into()
        .map_err(|_| "Firma device relay di lunghezza inattesa.".to_string())?;
    write_frame(
        &mut tls,
        &frame(FrameType::ClientAuth, 0, signature.to_vec()),
    )
    .await?;
    let auth_ok = timeout(AUTH_TIMEOUT, read_frame(&mut tls))
        .await
        .map_err(|_| "Timeout AUTH_OK relay client.".to_string())??;
    if auth_ok.frame_type != FrameType::AuthOk || !auth_ok.payload.is_empty() {
        return Err("Relay non ha confermato CLIENT_AUTH.".to_string());
    }

    let (reader, writer) = tokio::io::split(tls);
    let (out_tx, out_rx) = mpsc::channel::<Frame>(FRAME_QUEUE_CAPACITY);
    let (in_tx, mut in_rx) = mpsc::channel::<Result<Frame, String>>(FRAME_QUEUE_CAPACITY);
    let streams = Arc::new(Mutex::new(HashMap::<u64, mpsc::Sender<Frame>>::new()));
    let writer_task = tokio::spawn(writer_loop(writer, out_rx));
    let reader_task = tokio::spawn(reader_loop(reader, in_tx));
    let mut heartbeat = interval(HEARTBEAT_INTERVAL);
    heartbeat.tick().await;
    let mut last_rx = Instant::now();
    let mut next_stream_id = 1u64;

    println!("relay=client_connected server_id=srv1_{}", URL_SAFE_NO_PAD.encode(config.server_id));

    let result = loop {
        tokio::select! {
            incoming = in_rx.recv() => {
                let inbound = match incoming {
                    Some(Ok(frame)) => frame,
                    Some(Err(error)) => break Err(error),
                    None => break Err("Reader relay client terminato.".to_string()),
                };
                last_rx = Instant::now();
                match inbound.frame_type {
                    FrameType::Ping => {
                        if out_tx.send(frame(FrameType::Pong, 0, Vec::new())).await.is_err() {
                            break Err("Writer relay client terminato.".to_string());
                        }
                    }
                    FrameType::Pong => {}
                    FrameType::OpenOk | FrameType::Data | FrameType::Fin | FrameType::Reset => {
                        let stream_tx = streams.lock().await.get(&inbound.stream_id).cloned();
                        if let Some(stream_tx) = stream_tx {
                            let _ = stream_tx.send(inbound).await;
                        }
                    }
                    _ => break Err("Frame inatteso dal relay sulla sessione client.".to_string()),
                }
            }
            accepted = listener.accept() => {
                let (local, _) = match accepted {
                    Ok(value) => value,
                    Err(error) => break Err(format!("Accept bridge relay locale fallito: {error}")),
                };
                let mut guard = streams.lock().await;
                if guard.len() >= MAX_CONCURRENT_STREAMS {
                    drop(guard);
                    drop(local);
                    continue;
                }
                let stream_id = next_stream_id;
                next_stream_id = next_stream_id.wrapping_add(1);
                if next_stream_id == 0 { next_stream_id = 1; }
                let (stream_tx, stream_rx) = mpsc::channel::<Frame>(STREAM_QUEUE_CAPACITY);
                guard.insert(stream_id, stream_tx);
                drop(guard);
                if out_tx.send(frame(FrameType::Open, stream_id, Vec::new())).await.is_err() {
                    break Err("Writer relay client terminato durante OPEN.".to_string());
                }
                let streams_for_task = Arc::clone(&streams);
                let out_for_task = out_tx.clone();
                tokio::spawn(async move {
                    run_local_client_stream(stream_id, local, out_for_task, stream_rx).await;
                    streams_for_task.lock().await.remove(&stream_id);
                });
            }
            _ = heartbeat.tick() => {
                if last_rx.elapsed() >= SESSION_DEAD_TIMEOUT {
                    break Err("Sessione client relay scaduta senza traffico/PONG.".to_string());
                }
                if out_tx.send(frame(FrameType::Ping, 0, Vec::new())).await.is_err() {
                    break Err("Writer relay client terminato.".to_string());
                }
            }
        }
    };

    reader_task.abort();
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

async fn reader_loop<R: AsyncRead + Unpin>(
    mut reader: R,
    tx: mpsc::Sender<Result<Frame, String>>,
) {
    loop {
        let result = read_frame(&mut reader).await;
        let terminal = result.is_err();
        if tx.send(result).await.is_err() || terminal {
            break;
        }
    }
}

async fn writer_loop<W: AsyncWrite + Unpin>(mut writer: W, mut rx: mpsc::Receiver<Frame>) {
    while let Some(frame) = rx.recv().await {
        if write_frame(&mut writer, &frame).await.is_err() {
            break;
        }
    }
}

async fn run_local_client_stream(
    stream_id: u64,
    local: TcpStream,
    out_tx: mpsc::Sender<Frame>,
    mut inbound_rx: mpsc::Receiver<Frame>,
) {
    let opened = timeout(STREAM_OPEN_TIMEOUT, inbound_rx.recv()).await;
    match opened {
        Ok(Some(Frame { frame_type: FrameType::OpenOk, .. })) => {}
        Ok(Some(Frame { frame_type: FrameType::Reset, .. })) => return,
        _ => {
            let _ = out_tx
                .send(frame(FrameType::Reset, stream_id, Vec::new()))
                .await;
            return;
        }
    }

    let (mut local_reader, mut local_writer) = local.into_split();
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
    use super::{normalize_relay_cert_fingerprint, normalize_relay_endpoint};
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

    #[test]
    fn relay_endpoint_is_tls_only_and_origin_only() {
        assert_eq!(
            normalize_relay_endpoint("tls://relay.example.test").unwrap(),
            "tls://relay.example.test:443"
        );
        assert!(normalize_relay_endpoint("http://relay.example.test").is_err());
        assert!(normalize_relay_endpoint("tls://relay.example.test/path").is_err());
    }

    #[test]
    fn relay_certificate_pin_is_strict_sha256() {
        let pin = format!("SHA256:{}", URL_SAFE_NO_PAD.encode([7u8; 32]));
        assert_eq!(normalize_relay_cert_fingerprint(&pin).unwrap(), pin);
        assert!(normalize_relay_cert_fingerprint("SHA256:bad").is_err());
    }
}
