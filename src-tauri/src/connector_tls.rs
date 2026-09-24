use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use reqwest::redirect::Policy;
use rustls::{
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    crypto::{self, aws_lc_rs, WebPkiSupportedAlgorithms},
    pki_types::{CertificateDer, ServerName, SubjectPublicKeyInfoDer, UnixTime},
    ClientConfig, DigitallySignedStruct, Error as TlsError, SignatureScheme,
};
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Duration};
use url::{Host, Url};

pub const CONNECTOR_FINGERPRINT_ENV: &str = "BAIA_CONNECTOR_SERVER_FINGERPRINT";
pub const CONNECTOR_ENDPOINT_ENV: &str = "BAIA_CONNECTOR_ENDPOINT";
pub const DEFAULT_CONNECTOR_ENDPOINT: &str = "https://127.0.0.1:43127";
pub const CONNECTOR_PORT: u16 = 43127;
pub const LOCAL_RELAY_BRIDGE_PORT: u16 = 43128;
pub const HEALTH_PATH: &str = "/baia/v1/health";
pub const REQUEST_PATH: &str = "/baia/v1/request";
pub const MEDIA_PATH: &str = "/baia/v1/media";
pub const PAIRING_PATH: &str = "/baia/v1/pairing";
pub const UPLOAD_PATH: &str = "/baia/v1/upload";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConnectorEndpointKind {
    Lan,
    DirectInternet,
    RelayBridge,
}

const ED25519_SPKI_PREFIX: &[u8] = &[
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

pub fn classify_connector_endpoint(value: &str) -> Result<ConnectorEndpointKind, String> {
    let input = value.trim();
    let parsed = Url::parse(input)
        .map_err(|_| "Endpoint Host Connector non valido.".to_string())?;

    if parsed.scheme() != "https" {
        return Err("L'Host Connector deve usare https://.".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("L'endpoint Host Connector non deve contenere credenziali.".to_string());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() || parsed.path() != "/" {
        return Err("L'endpoint Host Connector deve contenere soltanto origine e porta.".to_string());
    }

    let port = parsed.port_or_known_default().ok_or_else(|| {
        "L'endpoint Host Connector deve specificare una porta HTTPS valida.".to_string()
    })?;

    match (port, parsed.host()) {
        (CONNECTOR_PORT, Some(Host::Ipv4(address)))
            if address.is_loopback() || address.is_private() =>
        {
            Ok(ConnectorEndpointKind::Lan)
        }
        (LOCAL_RELAY_BRIDGE_PORT, Some(Host::Ipv4(address))) if address.is_loopback() => {
            Ok(ConnectorEndpointKind::RelayBridge)
        }
        (443, Some(Host::Domain(domain)))
            if !domain.trim().is_empty()
                && !domain.trim_end_matches('.').eq_ignore_ascii_case("localhost")
                && !domain.to_ascii_lowercase().ends_with(".localhost") =>
        {
            Ok(ConnectorEndpointKind::DirectInternet)
        }
        (443, Some(Host::Ipv4(address)))
            if !address.is_unspecified()
                && !address.is_loopback()
                && !address.is_private()
                && !address.is_multicast() =>
        {
            Ok(ConnectorEndpointKind::DirectInternet)
        }
        (443, Some(Host::Ipv6(address)))
            if !address.is_unspecified()
                && !address.is_loopback()
                && !address.is_multicast()
                && !address.is_unique_local()
                && !address.is_unicast_link_local() =>
        {
            Ok(ConnectorEndpointKind::DirectInternet)
        }
        _ => Err(format!(
            "Endpoint Host Connector non consentito: LAN privata su {CONNECTOR_PORT}, bridge relay loopback su {LOCAL_RELAY_BRIDGE_PORT}, oppure endpoint Internet pubblico HTTPS su TCP 443."
        )),
    }
}

pub fn normalize_connector_endpoint(value: &str) -> Result<String, String> {
    classify_connector_endpoint(value)?;
    let parsed = Url::parse(value.trim())
        .map_err(|_| "Endpoint Host Connector non valido.".to_string())?;
    Ok(parsed.origin().ascii_serialization())
}

pub fn connector_url(endpoint: &str, path: &str) -> Result<String, String> {
    if ![HEALTH_PATH, REQUEST_PATH, MEDIA_PATH, PAIRING_PATH, UPLOAD_PATH].contains(&path) {
        return Err("Route Host Connector non consentita dal Core.".to_string());
    }
    let endpoint = normalize_connector_endpoint(endpoint)?;
    Ok(format!("{endpoint}{path}"))
}

pub fn normalize_server_fingerprint(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    let encoded = trimmed
        .strip_prefix("SHA256:")
        .ok_or_else(|| "Fingerprint Host Connector non valida: prefisso SHA256: mancante.".to_string())?;
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| "Fingerprint Host Connector non valida: base64url non valido.".to_string())?;
    if bytes.len() != 32 {
        return Err("Fingerprint Host Connector non valida: SHA-256 deve contenere 32 byte.".to_string());
    }
    Ok(format!("SHA256:{}", URL_SAFE_NO_PAD.encode(bytes)))
}

fn decode_server_fingerprint(value: &str) -> Result<[u8; 32], String> {
    let normalized = normalize_server_fingerprint(value)?;
    let encoded = normalized
        .strip_prefix("SHA256:")
        .expect("fingerprint normalizzata con prefisso SHA256");
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| "Fingerprint Host Connector non valida.".to_string())?;
    bytes
        .try_into()
        .map_err(|_| "Fingerprint Host Connector di lunghezza inattesa.".to_string())
}

fn ed25519_public_key_from_rpk(bytes: &[u8]) -> Result<[u8; 32], TlsError> {
    if bytes.len() != ED25519_SPKI_PREFIX.len() + 32
        || !bytes.starts_with(ED25519_SPKI_PREFIX)
    {
        return Err(TlsError::General(
            "Identita TLS Host Connector non e una Raw Public Key Ed25519 valida.".to_string(),
        ));
    }
    bytes[ED25519_SPKI_PREFIX.len()..]
        .try_into()
        .map_err(|_| TlsError::General("Chiave pubblica TLS Host Connector non valida.".to_string()))
}

#[derive(Debug)]
struct PinnedServerVerifier {
    expected_fingerprint: [u8; 32],
    supported_algorithms: WebPkiSupportedAlgorithms,
}

impl PinnedServerVerifier {
    fn verify_pinned_rpk(&self, rpk: &[u8]) -> Result<(), TlsError> {
        let public_key = ed25519_public_key_from_rpk(rpk)?;
        let actual: [u8; 32] = Sha256::digest(public_key).into();
        if actual != self.expected_fingerprint {
            return Err(TlsError::General(
                "Identita TLS Host Connector rifiutata: fingerprint diversa dal pin configurato."
                    .to_string(),
            ));
        }
        Ok(())
    }
}

impl ServerCertVerifier for PinnedServerVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, TlsError> {
        if !intermediates.is_empty() || !ocsp_response.is_empty() {
            return Err(TlsError::General(
                "Il prototipo Baia 4A.4 accetta solo la Raw Public Key pinnata del Connector."
                    .to_string(),
            ));
        }
        self.verify_pinned_rpk(end_entity.as_ref())?;
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        Err(TlsError::General(
            "TLS 1.2 non consentito dal trasporto Baia 4A.4.".to_string(),
        ))
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        let spki = SubjectPublicKeyInfoDer::from(cert.as_ref());
        crypto::verify_tls13_signature_with_raw_key(
            message,
            &spki,
            dss,
            &self.supported_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![SignatureScheme::ED25519]
    }

    fn requires_raw_public_keys(&self) -> bool {
        true
    }
}

fn client_config(server_fingerprint: &str) -> Result<ClientConfig, String> {
    let expected_fingerprint = decode_server_fingerprint(server_fingerprint)?;
    let provider = aws_lc_rs::default_provider();
    let supported_algorithms = provider.signature_verification_algorithms;
    let verifier = Arc::new(PinnedServerVerifier {
        expected_fingerprint,
        supported_algorithms,
    });

    let mut config = ClientConfig::builder_with_provider(Arc::new(provider))
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|error| format!("Impossibile limitare il Core a TLS 1.3: {error}"))?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(config)
}

pub fn async_client(
    server_fingerprint: &str,
    connect_timeout: Duration,
    request_timeout: Option<Duration>,
) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .connect_timeout(connect_timeout)
        .https_only(true)
        .tls_backend_preconfigured(client_config(server_fingerprint)?);
    if let Some(timeout) = request_timeout {
        builder = builder.timeout(timeout);
    }
    builder
        .build()
        .map_err(|error| format!("Impossibile inizializzare il client TLS pinnato del Core: {error}"))
}

pub fn blocking_client(
    server_fingerprint: &str,
    connect_timeout: Duration,
    request_timeout: Option<Duration>,
) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .connect_timeout(connect_timeout)
        .timeout(request_timeout)
        .https_only(true)
        .tls_backend_preconfigured(client_config(server_fingerprint)?)
        .build()
        .map_err(|error| format!("Impossibile inizializzare il client TLS pinnato del Core: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{
        classify_connector_endpoint, connector_url, decode_server_fingerprint,
        ed25519_public_key_from_rpk, normalize_connector_endpoint, normalize_server_fingerprint,
        ConnectorEndpointKind, PinnedServerVerifier, ED25519_SPKI_PREFIX, MEDIA_PATH, REQUEST_PATH,
    };
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use rustls::crypto::aws_lc_rs;
    use sha2::{Digest, Sha256};

    fn pin_for(public_key: [u8; 32]) -> String {
        format!(
            "SHA256:{}",
            URL_SAFE_NO_PAD.encode(Sha256::digest(public_key))
        )
    }

    fn rpk_for(public_key: [u8; 32]) -> Vec<u8> {
        let mut rpk = ED25519_SPKI_PREFIX.to_vec();
        rpk.extend_from_slice(&public_key);
        rpk
    }

    #[test]
    fn connector_endpoint_accepts_lan_relay_and_direct_internet_without_arbitrary_ports() {
        assert_eq!(
            normalize_connector_endpoint("https://127.0.0.1:43127/").unwrap(),
            "https://127.0.0.1:43127"
        );
        assert_eq!(
            classify_connector_endpoint("https://192.168.1.50:43127").unwrap(),
            ConnectorEndpointKind::Lan
        );
        assert_eq!(
            classify_connector_endpoint("https://127.0.0.1:43128").unwrap(),
            ConnectorEndpointKind::RelayBridge
        );
        assert_eq!(
            normalize_connector_endpoint("https://baia.example.test").unwrap(),
            "https://baia.example.test"
        );
        assert_eq!(
            classify_connector_endpoint("https://baia.example.test:443").unwrap(),
            ConnectorEndpointKind::DirectInternet
        );
        assert_eq!(
            classify_connector_endpoint("https://8.8.8.8:443").unwrap(),
            ConnectorEndpointKind::DirectInternet
        );

        assert!(normalize_connector_endpoint("https://192.168.1.50:43128").is_err());
        assert!(normalize_connector_endpoint("http://192.168.1.50:43127").is_err());
        assert!(normalize_connector_endpoint("https://0.0.0.0:443").is_err());
        assert!(normalize_connector_endpoint("https://8.8.8.8:43127").is_err());
        assert!(normalize_connector_endpoint("https://localhost:443").is_err());
        assert!(normalize_connector_endpoint("https://localhost.:443").is_err());
        assert!(normalize_connector_endpoint("https://printer.localhost:443").is_err());
        assert!(normalize_connector_endpoint("https://[::1]:443").is_err());
        assert!(normalize_connector_endpoint("https://[fc00::1]:443").is_err());
        assert!(normalize_connector_endpoint("https://[fe80::1]:443").is_err());
        assert!(normalize_connector_endpoint("https://baia.example.test:444").is_err());
        assert!(normalize_connector_endpoint("https://baia.example.test:443/api").is_err());

        assert_eq!(
            connector_url("https://baia.example.test:443", REQUEST_PATH).unwrap(),
            "https://baia.example.test/baia/v1/request"
        );
        assert_eq!(
            connector_url("https://127.0.0.1:43127", MEDIA_PATH).unwrap(),
            "https://127.0.0.1:43127/baia/v1/media"
        );
        assert!(connector_url("https://127.0.0.1:43127", "/evil").is_err());
    }

    #[test]
    fn fingerprint_format_is_strict_and_canonical() {
        let pin = pin_for([7u8; 32]);
        assert_eq!(normalize_server_fingerprint(&format!("  {pin}  ")).unwrap(), pin);
        assert_eq!(decode_server_fingerprint(&pin).unwrap().len(), 32);
        assert!(normalize_server_fingerprint("sha256:abc").is_err());
        assert!(normalize_server_fingerprint("SHA256:abc").is_err());
        assert!(normalize_server_fingerprint("https://evil.invalid").is_err());
    }

    #[test]
    fn raw_public_key_must_be_exact_ed25519_spki() {
        let public_key = [9u8; 32];
        assert_eq!(ed25519_public_key_from_rpk(&rpk_for(public_key)).unwrap(), public_key);
        let mut wrong_prefix = rpk_for(public_key);
        wrong_prefix[0] ^= 1;
        assert!(ed25519_public_key_from_rpk(&wrong_prefix).is_err());
        assert!(ed25519_public_key_from_rpk(&[0u8; 32]).is_err());
    }

    #[test]
    fn verifier_accepts_only_the_pinned_server_public_key() {
        let expected_key = [11u8; 32];
        let expected_fingerprint = decode_server_fingerprint(&pin_for(expected_key)).unwrap();
        let verifier = PinnedServerVerifier {
            expected_fingerprint,
            supported_algorithms: aws_lc_rs::default_provider().signature_verification_algorithms,
        };

        assert!(verifier.verify_pinned_rpk(&rpk_for(expected_key)).is_ok());
        assert!(verifier.verify_pinned_rpk(&rpk_for([12u8; 32])).is_err());
    }
}
