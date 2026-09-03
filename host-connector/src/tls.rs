use crate::server_identity::ServerIdentity;
use rustls::{
    crypto::aws_lc_rs,
    pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer},
    server::AlwaysResolvesServerRawPublicKeys,
    sign::CertifiedKey,
    ServerConfig, ServerConnection, StreamOwned,
};
use std::{net::TcpStream, sync::Arc};

pub type ServerTlsStream = StreamOwned<ServerConnection, TcpStream>;

pub fn build_server_config(identity: &ServerIdentity) -> Result<Arc<ServerConfig>, String> {
    let provider = aws_lc_rs::default_provider();
    let private_key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
        identity.private_key_pkcs8().to_vec(),
    ));
    let signing_key = provider
        .key_provider
        .load_private_key(private_key)
        .map_err(|error| format!("Impossibile caricare la chiave TLS del Connector: {error}"))?;

    // Rustls RFC 7250: la voce `cert` contiene la SubjectPublicKeyInfo DER quando
    // il resolver dichiara di usare esclusivamente Raw Public Keys.
    let raw_public_key = CertificateDer::from(identity.subject_public_key_info_der());
    let certified_key = Arc::new(CertifiedKey::new(vec![raw_public_key], signing_key));
    let resolver = AlwaysResolvesServerRawPublicKeys::new(certified_key);

    let mut config = ServerConfig::builder_with_provider(Arc::new(provider))
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|error| format!("Impossibile limitare il Connector a TLS 1.3: {error}"))?
        .with_no_client_auth()
        .with_cert_resolver(Arc::new(resolver));
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(Arc::new(config))
}

pub fn accept_tls(
    mut stream: TcpStream,
    config: Arc<ServerConfig>,
) -> Result<ServerTlsStream, String> {
    let mut connection = ServerConnection::new(config)
        .map_err(|error| format!("Impossibile inizializzare la sessione TLS del Connector: {error}"))?;

    while connection.is_handshaking() {
        connection
            .complete_io(&mut stream)
            .map_err(|error| format!("Handshake TLS 1.3 del Connector fallito: {error}"))?;
    }

    Ok(StreamOwned::new(connection, stream))
}
