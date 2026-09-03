use base64::{engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD}, Engine as _};
use ring::digest::{digest, SHA256};
use rustls::{
    crypto::aws_lc_rs,
    pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs1KeyDer, PrivatePkcs8KeyDer, PrivateSec1KeyDer},
    ServerConfig,
};
use std::{fs, sync::Arc};

fn pem_blocks(contents: &str, label: &str) -> Result<Vec<Vec<u8>>, String> {
    let begin = format!("-----BEGIN {label}-----");
    let end = format!("-----END {label}-----");
    let mut rest = contents;
    let mut blocks = Vec::new();

    while let Some(start) = rest.find(&begin) {
        let after_begin = &rest[start + begin.len()..];
        let stop = after_begin
            .find(&end)
            .ok_or_else(|| format!("PEM {label} troncato."))?;
        let encoded = after_begin[..stop]
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect::<String>();
        let decoded = STANDARD
            .decode(encoded)
            .map_err(|_| format!("PEM {label} non valido."))?;
        blocks.push(decoded);
        rest = &after_begin[stop + end.len()..];
    }

    if blocks.is_empty() {
        return Err(format!("Nessun blocco PEM {label} trovato."));
    }
    Ok(blocks)
}

fn load_certificates(path: &str) -> Result<Vec<CertificateDer<'static>>, String> {
    let contents = fs::read_to_string(path)
        .map_err(|error| format!("Impossibile leggere il certificato relay {path}: {error}"))?;
    pem_blocks(&contents, "CERTIFICATE").map(|blocks| {
        blocks
            .into_iter()
            .map(CertificateDer::from)
            .collect::<Vec<_>>()
    })
}

fn load_private_key(path: &str) -> Result<PrivateKeyDer<'static>, String> {
    let contents = fs::read_to_string(path)
        .map_err(|error| format!("Impossibile leggere la chiave TLS relay {path}: {error}"))?;

    if let Ok(mut blocks) = pem_blocks(&contents, "PRIVATE KEY") {
        if blocks.len() == 1 {
            return Ok(PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(blocks.remove(0))));
        }
    }
    if let Ok(mut blocks) = pem_blocks(&contents, "RSA PRIVATE KEY") {
        if blocks.len() == 1 {
            return Ok(PrivateKeyDer::Pkcs1(PrivatePkcs1KeyDer::from(blocks.remove(0))));
        }
    }
    if let Ok(mut blocks) = pem_blocks(&contents, "EC PRIVATE KEY") {
        if blocks.len() == 1 {
            return Ok(PrivateKeyDer::Sec1(PrivateSec1KeyDer::from(blocks.remove(0))));
        }
    }

    Err("Chiave TLS relay non supportata: usa PEM PKCS#8, PKCS#1 RSA o SEC1 EC.".to_string())
}

pub struct RelayTlsConfig {
    pub config: Arc<ServerConfig>,
    pub certificate_fingerprint: String,
}

pub fn build_server_config(cert_path: &str, key_path: &str) -> Result<RelayTlsConfig, String> {
    let certificates = load_certificates(cert_path)?;
    let certificate_fingerprint = format!(
        "SHA256:{}",
        URL_SAFE_NO_PAD.encode(digest(&SHA256, certificates[0].as_ref()).as_ref())
    );
    let private_key = load_private_key(key_path)?;
    let provider = aws_lc_rs::default_provider();

    let mut config = ServerConfig::builder_with_provider(Arc::new(provider))
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|error| format!("Impossibile limitare il relay a TLS 1.3: {error}"))?
        .with_no_client_auth()
        .with_single_cert(certificates, private_key)
        .map_err(|error| format!("Certificato/chiave TLS relay non validi: {error}"))?;
    config.alpn_protocols = vec![b"baia-relay-v1".to_vec()];

    Ok(RelayTlsConfig {
        config: Arc::new(config),
        certificate_fingerprint,
    })
}

#[cfg(test)]
mod tests {
    use super::pem_blocks;
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    #[test]
    fn pem_parser_decodes_multiple_blocks() {
        let first = STANDARD.encode([1u8, 2, 3]);
        let second = STANDARD.encode([4u8, 5, 6]);
        let pem = format!(
            "-----BEGIN CERTIFICATE-----\n{first}\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\n{second}\n-----END CERTIFICATE-----\n"
        );
        let blocks = pem_blocks(&pem, "CERTIFICATE").unwrap();
        assert_eq!(blocks, vec![vec![1, 2, 3], vec![4, 5, 6]]);
    }
}
