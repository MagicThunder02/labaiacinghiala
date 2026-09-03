use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ring::{
    digest::{Context, SHA256},
    signature::{UnparsedPublicKey, ED25519},
};
use uuid::Uuid;

const GRANT_VERSION: u8 = 1;
const TRANSPORT_PROTOCOL_VERSION: u16 = 1;
const SERVER_ID_DOMAIN: &[u8] = b"baia-server-id-v1\0";
// Compatibilita' wire con il grant gia' emesso per il fallback relay.
// Il grant e' firmato dall'identita' persistente del Connector e resta
// vincolato alla chiave pubblica del device; non e' un bearer token.
const ACCESS_GRANT_DOMAIN: &[u8] = b"baia-relay-access-grant-v1\0";
const REQUEST_CONTEXT: &str = "BAIA-REQ-V1";
const MEDIA_CONTEXT: &str = "BAIA-MEDIA-V1";
const SERVER_ID_BYTES: usize = 32;
const DEVICE_ID_BYTES: usize = 16;
const PUBLIC_KEY_BYTES: usize = 32;
const GRANT_ID_BYTES: usize = 16;
const SIGNATURE_BYTES: usize = 64;
const NONCE_BYTES: usize = 16;
const GRANT_UNSIGNED_BYTES: usize = 1 + SERVER_ID_BYTES + DEVICE_ID_BYTES + PUBLIC_KEY_BYTES + GRANT_ID_BYTES + 8 + 2;
const GRANT_BYTES: usize = GRANT_UNSIGNED_BYTES + SIGNATURE_BYTES;
const REQUEST_CLOCK_SKEW_SECONDS: u64 = 90;
const MEDIA_MAX_TTL_SECONDS: u64 = 8 * 60 * 60;
const GRANT_FUTURE_SKEW_SECONDS: u64 = 5 * 60;
const MAX_TARGET_BYTES: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedAccessGrant {
    pub device_id: String,
    pub device_public_key: [u8; PUBLIC_KEY_BYTES],
    pub issued_at: u64,
}

fn derive_server_id(public_key: &[u8; PUBLIC_KEY_BYTES]) -> [u8; SERVER_ID_BYTES] {
    let mut context = Context::new(&SHA256);
    context.update(SERVER_ID_DOMAIN);
    context.update(public_key);
    context
        .finish()
        .as_ref()
        .try_into()
        .expect("SHA-256 deve produrre 32 byte")
}

fn decode_canonical_base64url(value: &str, expected_bytes: usize, label: &str) -> Result<Vec<u8>, String> {
    let value = value.trim();
    if value.is_empty()
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err(format!("{label} non valido."));
    }
    let decoded = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| format!("{label} non valido."))?;
    if decoded.len() != expected_bytes || URL_SAFE_NO_PAD.encode(&decoded) != value {
        return Err(format!("{label} non valido."));
    }
    Ok(decoded)
}

pub fn verify_access_grant(
    encoded_grant: &str,
    server_public_key: &[u8; PUBLIC_KEY_BYTES],
    now_seconds: u64,
) -> Result<VerifiedAccessGrant, String> {
    let grant = decode_canonical_base64url(encoded_grant, GRANT_BYTES, "Grant accesso trasporto")?;
    let unsigned = &grant[..GRANT_UNSIGNED_BYTES];
    let signature = &grant[GRANT_UNSIGNED_BYTES..];

    let mut offset = 0usize;
    let version = unsigned[offset];
    offset += 1;
    if version != GRANT_VERSION {
        return Err(format!("Versione grant accesso non supportata: {version}."));
    }

    let server_id: [u8; SERVER_ID_BYTES] = unsigned[offset..offset + SERVER_ID_BYTES]
        .try_into()
        .expect("slice server_id di lunghezza fissa");
    offset += SERVER_ID_BYTES;
    if server_id != derive_server_id(server_public_key) {
        return Err("Grant accesso emesso per un altro server.".to_string());
    }

    let device_id_bytes: [u8; DEVICE_ID_BYTES] = unsigned[offset..offset + DEVICE_ID_BYTES]
        .try_into()
        .expect("slice device_id di lunghezza fissa");
    offset += DEVICE_ID_BYTES;
    let device_id = Uuid::from_bytes(device_id_bytes).to_string();

    let device_public_key: [u8; PUBLIC_KEY_BYTES] = unsigned[offset..offset + PUBLIC_KEY_BYTES]
        .try_into()
        .expect("slice device public key di lunghezza fissa");
    offset += PUBLIC_KEY_BYTES;

    // grant_id e' intenzionalmente opaco al Connector Direct: resta incluso nella firma.
    offset += GRANT_ID_BYTES;
    let issued_at = u64::from_be_bytes(
        unsigned[offset..offset + 8]
            .try_into()
            .expect("slice issued_at di lunghezza fissa"),
    );
    offset += 8;
    let protocol_version = u16::from_be_bytes(
        unsigned[offset..offset + 2]
            .try_into()
            .expect("slice protocol_version di lunghezza fissa"),
    );

    if issued_at == 0 || issued_at > now_seconds.saturating_add(GRANT_FUTURE_SKEW_SECONDS) {
        return Err("Timestamp grant accesso non valido.".to_string());
    }
    if protocol_version != TRANSPORT_PROTOCOL_VERSION {
        return Err(format!(
            "Versione protocollo grant accesso non supportata: {protocol_version}."
        ));
    }

    let mut message = Vec::with_capacity(ACCESS_GRANT_DOMAIN.len() + GRANT_UNSIGNED_BYTES);
    message.extend_from_slice(ACCESS_GRANT_DOMAIN);
    message.extend_from_slice(unsigned);
    UnparsedPublicKey::new(&ED25519, server_public_key)
        .verify(&message, signature)
        .map_err(|_| "Firma server del grant accesso non valida.".to_string())?;

    Ok(VerifiedAccessGrant {
        device_id,
        device_public_key,
        issued_at,
    })
}

fn verify_device_signature(
    public_key: &[u8; PUBLIC_KEY_BYTES],
    signature: &str,
    message: &[u8],
) -> Result<(), String> {
    let signature = decode_canonical_base64url(signature, SIGNATURE_BYTES, "Firma dispositivo")?;
    UnparsedPublicKey::new(&ED25519, public_key)
        .verify(message, &signature)
        .map_err(|_| "Firma dispositivo non valida al perimetro Connector.".to_string())
}

fn validate_device_binding(grant: &VerifiedAccessGrant, device_id: &str) -> Result<(), String> {
    let parsed = Uuid::parse_str(device_id).map_err(|_| "Device ID non valido.".to_string())?;
    if parsed.to_string() != grant.device_id {
        return Err("Grant accesso associato a un dispositivo diverso.".to_string());
    }
    Ok(())
}

fn validate_target(target: &str) -> Result<(), String> {
    if !target.starts_with("/api/")
        || target.starts_with("//")
        || target.len() > MAX_TARGET_BYTES
        || target.contains('\r')
        || target.contains('\n')
        || target.contains('\\')
        || target.contains('#')
    {
        return Err("Target autorizzazione trasporto non valido.".to_string());
    }
    Ok(())
}

pub fn verify_request_authorization(
    grant: &VerifiedAccessGrant,
    device_id: &str,
    timestamp: u64,
    nonce: &str,
    signature: &str,
    method: &str,
    target: &str,
    now_seconds: u64,
) -> Result<(), String> {
    validate_device_binding(grant, device_id)?;
    validate_target(target)?;
    if timestamp.abs_diff(now_seconds) > REQUEST_CLOCK_SKEW_SECONDS {
        return Err("Autorizzazione dispositivo scaduta al perimetro Connector.".to_string());
    }
    decode_canonical_base64url(nonce, NONCE_BYTES, "Nonce dispositivo")?;
    if !matches!(method, "GET" | "HEAD" | "POST" | "PUT") {
        return Err("Metodo autorizzazione trasporto non valido.".to_string());
    }

    let message = format!(
        "{REQUEST_CONTEXT}\n{device_id}\n{timestamp}\n{nonce}\n{method}\n{target}"
    );
    verify_device_signature(&grant.device_public_key, signature, message.as_bytes())
}

pub fn verify_media_authorization(
    grant: &VerifiedAccessGrant,
    device_id: &str,
    expires: u64,
    signature: &str,
    path: &str,
    now_seconds: u64,
) -> Result<(), String> {
    validate_device_binding(grant, device_id)?;
    validate_target(path)?;
    if expires < now_seconds
        || expires.saturating_sub(now_seconds)
            > MEDIA_MAX_TTL_SECONDS.saturating_add(REQUEST_CLOCK_SKEW_SECONDS)
    {
        return Err("Autorizzazione media scaduta o con durata non valida.".to_string());
    }
    let message = format!("{MEDIA_CONTEXT}\n{device_id}\n{expires}\nGET\n{path}");
    verify_device_signature(&grant.device_public_key, signature, message.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::{
        rand::SystemRandom,
        signature::{Ed25519KeyPair, KeyPair},
    };

    fn signed_grant(
        server: &Ed25519KeyPair,
        device_id: Uuid,
        device_public_key: [u8; PUBLIC_KEY_BYTES],
        issued_at: u64,
    ) -> String {
        let server_public_key: [u8; PUBLIC_KEY_BYTES] = server
            .public_key()
            .as_ref()
            .try_into()
            .unwrap();
        let server_id = derive_server_id(&server_public_key);
        let mut unsigned = [0u8; GRANT_UNSIGNED_BYTES];
        let mut offset = 0usize;
        unsigned[offset] = GRANT_VERSION;
        offset += 1;
        unsigned[offset..offset + SERVER_ID_BYTES].copy_from_slice(&server_id);
        offset += SERVER_ID_BYTES;
        unsigned[offset..offset + DEVICE_ID_BYTES].copy_from_slice(device_id.as_bytes());
        offset += DEVICE_ID_BYTES;
        unsigned[offset..offset + PUBLIC_KEY_BYTES].copy_from_slice(&device_public_key);
        offset += PUBLIC_KEY_BYTES;
        unsigned[offset..offset + GRANT_ID_BYTES].copy_from_slice(Uuid::new_v4().as_bytes());
        offset += GRANT_ID_BYTES;
        unsigned[offset..offset + 8].copy_from_slice(&issued_at.to_be_bytes());
        offset += 8;
        unsigned[offset..offset + 2].copy_from_slice(&TRANSPORT_PROTOCOL_VERSION.to_be_bytes());

        let mut message = Vec::new();
        message.extend_from_slice(ACCESS_GRANT_DOMAIN);
        message.extend_from_slice(&unsigned);
        let signature = server.sign(&message);
        let mut grant = [0u8; GRANT_BYTES];
        grant[..GRANT_UNSIGNED_BYTES].copy_from_slice(&unsigned);
        grant[GRANT_UNSIGNED_BYTES..].copy_from_slice(signature.as_ref());
        URL_SAFE_NO_PAD.encode(grant)
    }

    fn key_pair() -> Ed25519KeyPair {
        let rng = SystemRandom::new();
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap()
    }

    #[test]
    fn grant_is_bound_to_server_and_device_key() {
        let server = key_pair();
        let device = key_pair();
        let device_id = Uuid::new_v4();
        let device_public_key = device.public_key().as_ref().try_into().unwrap();
        let encoded = signed_grant(&server, device_id, device_public_key, 1_000);
        let server_public_key = server.public_key().as_ref().try_into().unwrap();

        let verified = verify_access_grant(&encoded, &server_public_key, 1_100).unwrap();
        assert_eq!(verified.device_id, device_id.to_string());
        assert_eq!(verified.device_public_key, device_public_key);

        let other_server = key_pair();
        let other_public_key = other_server.public_key().as_ref().try_into().unwrap();
        assert!(verify_access_grant(&encoded, &other_public_key, 1_100).is_err());
    }

    #[test]
    fn request_proof_requires_private_device_key_and_fresh_timestamp() {
        let server = key_pair();
        let device = key_pair();
        let device_id = Uuid::new_v4();
        let device_public_key = device.public_key().as_ref().try_into().unwrap();
        let encoded = signed_grant(&server, device_id, device_public_key, 1_000);
        let server_public_key = server.public_key().as_ref().try_into().unwrap();
        let grant = verify_access_grant(&encoded, &server_public_key, 1_100).unwrap();
        let nonce = URL_SAFE_NO_PAD.encode([0x33u8; NONCE_BYTES]);
        let timestamp = 1_100;
        let target = "/api/movies?limit=10";
        let message = format!(
            "{REQUEST_CONTEXT}\n{device_id}\n{timestamp}\n{nonce}\nGET\n{target}"
        );
        let signature = URL_SAFE_NO_PAD.encode(device.sign(message.as_bytes()).as_ref());

        assert!(verify_request_authorization(
            &grant,
            &device_id.to_string(),
            timestamp,
            &nonce,
            &signature,
            "GET",
            target,
            1_100,
        )
        .is_ok());
        assert!(verify_request_authorization(
            &grant,
            &device_id.to_string(),
            timestamp,
            &nonce,
            &signature,
            "GET",
            target,
            1_500,
        )
        .is_err());
    }

    #[test]
    fn media_proof_is_bound_to_path_and_expiry() {
        let server = key_pair();
        let device = key_pair();
        let device_id = Uuid::new_v4();
        let device_public_key = device.public_key().as_ref().try_into().unwrap();
        let encoded = signed_grant(&server, device_id, device_public_key, 1_000);
        let server_public_key = server.public_key().as_ref().try_into().unwrap();
        let grant = verify_access_grant(&encoded, &server_public_key, 1_100).unwrap();
        let expires = 1_500;
        let path = "/api/movies/12/stream";
        let message = format!("{MEDIA_CONTEXT}\n{device_id}\n{expires}\nGET\n{path}");
        let signature = URL_SAFE_NO_PAD.encode(device.sign(message.as_bytes()).as_ref());

        assert!(verify_media_authorization(
            &grant,
            &device_id.to_string(),
            expires,
            &signature,
            path,
            1_100,
        )
        .is_ok());
        assert!(verify_media_authorization(
            &grant,
            &device_id.to_string(),
            expires,
            &signature,
            "/api/movies/13/stream",
            1_100,
        )
        .is_err());
    }
}
