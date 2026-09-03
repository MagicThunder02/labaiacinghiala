use crate::{
    connector_tls,
    core::{CoreState, PairingRecord},
    identity,
    relay_bridge,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use std::{net::IpAddr, time::Duration};
use tauri::State;
use url::{Host, Url};
use uuid::Uuid;

const PROTOCOL_VERSION: u16 = 1;
const PAIRING_TIMEOUT: Duration = Duration::from_secs(15);
const PAIRING_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_CONNECTOR_RESPONSE_BYTES: usize = 128 * 1024;
const MAX_NODE_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_DEVICE_NAME_CHARS: usize = 80;
const DIRECT_BOOTSTRAP_PREFIX: &str = "baia-direct1.";
const MAX_DIRECT_BOOTSTRAP_BYTES: usize = 8 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingRequest {
    invite_token: String,
    installation_id: String,
    public_key: String,
    signature: String,
    device_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DirectBootstrapPayload {
    version: u8,
    connector_endpoint: String,
    server_fingerprint: String,
    invite_token: String,
}

#[derive(Clone, Debug)]
struct DirectBootstrap {
    connector_endpoint: String,
    server_fingerprint: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectorPairingRequest {
    protocol_version: u16,
    request_id: String,
    pairing: PairingRequest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConnectorPairingResponse {
    protocol_version: u16,
    request_id: String,
    status: u16,
    body: String,
    #[serde(default)]
    relay_server_id: Option<String>,
    #[serde(default)]
    relay_access_grant: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectorProtocolError {
    #[serde(default)]
    protocol_version: Option<u16>,
    #[serde(default)]
    request_id: Option<String>,
    #[serde(default)]
    error_code: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Deserialize)]
struct PairingEnvelope {
    paired: bool,
    device: PairedDeviceResponse,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairedDeviceResponse {
    id: String,
    device_name: String,
    fingerprint: String,
    paired_at: String,
}

#[derive(Deserialize)]
struct PairingErrorResponse {
    error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingStatus {
    paired: bool,
    current_server_matches: bool,
    server_base_url: Option<String>,
    device_id: Option<String>,
    device_name: Option<String>,
    fingerprint: Option<String>,
    paired_at: Option<String>,
    suggested_device_name: String,
}

fn parse_pairing_input(value: &str) -> Result<(String, Option<DirectBootstrap>), String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("Inserisci un invito Baia valido.".to_string());
    }
    let Some(encoded) = value.strip_prefix(DIRECT_BOOTSTRAP_PREFIX) else {
        return Ok((value.to_string(), None));
    };
    if encoded.is_empty() || encoded.len() > MAX_DIRECT_BOOTSTRAP_BYTES * 2 {
        return Err("Bootstrap Direct Baia non valido.".to_string());
    }
    let decoded = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| "Bootstrap Direct Baia non valido.".to_string())?;
    if decoded.len() > MAX_DIRECT_BOOTSTRAP_BYTES {
        return Err("Bootstrap Direct Baia troppo grande.".to_string());
    }
    let payload: DirectBootstrapPayload = serde_json::from_slice(&decoded)
        .map_err(|_| "Bootstrap Direct Baia non valido.".to_string())?;
    if payload.version != 1 {
        return Err(format!(
            "Versione bootstrap Direct Baia non supportata: {}.",
            payload.version
        ));
    }
    let connector_endpoint = connector_tls::normalize_connector_endpoint(&payload.connector_endpoint)?;
    if connector_tls::classify_connector_endpoint(&connector_endpoint)?
        != connector_tls::ConnectorEndpointKind::DirectInternet
    {
        return Err("Il bootstrap Direct Baia richiede un endpoint HTTPS pubblico su TCP 443.".to_string());
    }
    let server_fingerprint = connector_tls::normalize_server_fingerprint(&payload.server_fingerprint)?;
    let invite_token = payload.invite_token.trim().to_string();
    // La validazione crittografica completa del token resta in identity/Node.
    if !invite_token.starts_with("baia1.") || invite_token.len() > 4096 {
        return Err("Invito interno del bootstrap Direct Baia non valido.".to_string());
    }
    Ok((
        invite_token.clone(),
        Some(DirectBootstrap {
            connector_endpoint,
            server_fingerprint,
        }),
    ))
}

fn suggested_device_name() -> String {
    #[cfg(target_os = "windows")]
    let host = std::env::var("COMPUTERNAME").ok();

    #[cfg(not(target_os = "windows"))]
    let host = std::env::var("HOSTNAME").ok();

    let candidate = host
        .filter(|value| !value.trim().is_empty())
        .map(|value| format!("Baia su {}", value.trim()))
        .unwrap_or_else(|| "Baia device".to_string());

    candidate.chars().take(MAX_DEVICE_NAME_CHARS).collect()
}

fn normalize_device_name(value: Option<String>) -> String {
    let candidate = value
        .unwrap_or_default()
        .chars()
        .filter(|ch| !ch.is_control())
        .collect::<String>();
    let collapsed = candidate.split_whitespace().collect::<Vec<_>>().join(" ");
    let normalized = collapsed.chars().take(MAX_DEVICE_NAME_CHARS).collect::<String>();
    if normalized.is_empty() {
        suggested_device_name()
    } else {
        normalized
    }
}

fn is_loopback_host(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(address)) => IpAddr::V4(address).is_loopback(),
        Some(Host::Ipv6(address)) => IpAddr::V6(address).is_loopback(),
        None => false,
    }
}

fn ensure_local_connector_server(base_url: &str) -> Result<(), String> {
    let base = Url::parse(base_url).map_err(|_| "Endpoint Baia Core non valido.".to_string())?;
    if base.scheme() == "http"
        && base.port_or_known_default() == Some(3000)
        && is_loopback_host(&base)
        && base.path() == "/"
        && base.query().is_none()
        && base.fragment().is_none()
    {
        Ok(())
    } else {
        Err(
            "Il pairing della Fase 3C richiede Node locale su http://127.0.0.1:3000 e Baia Host Connector attivo."
                .to_string(),
        )
    }
}

fn status_from_record(current_server: &str, record: Option<PairingRecord>) -> PairingStatus {
    match record {
        Some(record) => PairingStatus {
            paired: true,
            current_server_matches: record.server_base_url == current_server,
            server_base_url: Some(record.server_base_url),
            device_id: Some(record.device_id),
            device_name: Some(record.device_name),
            fingerprint: Some(record.fingerprint),
            paired_at: Some(record.paired_at),
            suggested_device_name: suggested_device_name(),
        },
        None => PairingStatus {
            paired: false,
            current_server_matches: false,
            server_base_url: None,
            device_id: None,
            device_name: None,
            fingerprint: None,
            paired_at: None,
            suggested_device_name: suggested_device_name(),
        },
    }
}

fn response_error(status: u16, body: &[u8]) -> String {
    if let Ok(payload) = serde_json::from_slice::<PairingErrorResponse>(body) {
        if let Some(message) = payload.error.filter(|value| !value.trim().is_empty()) {
            return message;
        }
    }
    format!("Pairing rifiutato dal server (HTTP {status}).")
}

fn connector_error(status: u16, body: &[u8]) -> String {
    if let Ok(payload) = serde_json::from_slice::<ConnectorProtocolError>(body) {
        let protocol_ok = payload.protocol_version.is_none_or(|value| value == PROTOCOL_VERSION);
        if protocol_ok {
            if let Some(message) = payload.message.filter(|value| !value.trim().is_empty()) {
                return match payload.error_code.filter(|value| !value.trim().is_empty()) {
                    Some(code) => format!("{message} ({code})"),
                    None => message,
                };
            }
        }
    }
    format!("Baia Host Connector ha rifiutato il pairing (HTTP {status}).")
}

fn validate_connector_response(
    response: &ConnectorPairingResponse,
    expected_request_id: &str,
) -> Result<(), String> {
    if response.protocol_version != PROTOCOL_VERSION {
        return Err(format!(
            "Versione Host Connector incompatibile: {}.",
            response.protocol_version
        ));
    }
    if response.request_id != expected_request_id {
        return Err("Risposta pairing del Connector associata a una richiesta diversa.".to_string());
    }
    if response.body.len() > MAX_NODE_RESPONSE_BYTES {
        return Err("Risposta di pairing Node troppo grande.".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn baia_core_pairing_status(state: State<'_, CoreState>) -> Result<PairingStatus, String> {
    let (server_base_url, _, record) = state.pairing_context()?;
    Ok(status_from_record(&server_base_url, record))
}

#[tauri::command]
pub async fn baia_core_pair_with_invite(
    invite_token: String,
    device_name: Option<String>,
    state: State<'_, CoreState>,
) -> Result<PairingStatus, String> {
    let (server_base_url, installation_id, existing_pairing) = state.pairing_context()?;
    let relay_was_active = existing_pairing.as_ref().is_some_and(|pairing| {
        pairing.relay_server_id.is_some() && pairing.relay_access_grant.is_some()
    });
    ensure_local_connector_server(&server_base_url)?;

    let (invite_token, direct_bootstrap) = parse_pairing_input(&invite_token)?;
    let (connector_endpoint, server_fingerprint) = match direct_bootstrap.as_ref() {
        Some(bootstrap) => (
            bootstrap.connector_endpoint.clone(),
            bootstrap.server_fingerprint.clone(),
        ),
        None => state.connector_context()?,
    };
    let connector_url =
        connector_tls::connector_url(&connector_endpoint, connector_tls::PAIRING_PATH)?;
    let client = connector_tls::async_client(
        &server_fingerprint,
        PAIRING_CONNECT_TIMEOUT,
        Some(PAIRING_TIMEOUT),
    )
    .map_err(|error| format!("Impossibile inizializzare il client pairing TLS del Core: {error}"))?;

    let proof = identity::create_pairing_proof(&invite_token, &installation_id)?;
    let device_name = normalize_device_name(device_name);
    let request_id = Uuid::new_v4().to_string();
    let frame = ConnectorPairingRequest {
        protocol_version: PROTOCOL_VERSION,
        request_id: request_id.clone(),
        pairing: PairingRequest {
            invite_token,
            installation_id,
            public_key: proof.public_key,
            signature: proof.signature,
            device_name,
        },
    };

    let response = client
        .post(&connector_url)
        .json(&frame)
        .send()
        .await
        .map_err(|error| {
            format!(
                "Baia Host Connector TLS non raggiungibile o identita server rifiutata su {connector_endpoint} durante il pairing: {error}"
            )
        })?;

    let connector_status = response.status().as_u16();
    let body = response
        .bytes()
        .await
        .map_err(|error| format!("Risposta pairing del Connector non leggibile: {error}"))?;
    if body.len() > MAX_CONNECTOR_RESPONSE_BYTES {
        return Err("Risposta pairing del Connector troppo grande.".to_string());
    }
    if !(200..300).contains(&connector_status) {
        return Err(connector_error(connector_status, &body));
    }

    let connector_response: ConnectorPairingResponse = serde_json::from_slice(&body)
        .map_err(|_| "Risposta pairing del Connector non valida.".to_string())?;
    validate_connector_response(&connector_response, &request_id)?;

    if !(200..300).contains(&connector_response.status) {
        return Err(response_error(
            connector_response.status,
            connector_response.body.as_bytes(),
        ));
    }

    let envelope: PairingEnvelope = serde_json::from_str(&connector_response.body)
        .map_err(|_| "Risposta di pairing del server non valida.".to_string())?;
    if !envelope.paired {
        return Err("Il server non ha confermato il pairing.".to_string());
    }
    if envelope.device.fingerprint != proof.fingerprint {
        return Err("Il server ha restituito un'identità dispositivo inattesa.".to_string());
    }

    let relay_server_id = connector_response
        .relay_server_id
        .filter(|value| value.starts_with("srv1_") && value.len() > 16);
    let relay_access_grant = connector_response
        .relay_access_grant
        .filter(|value| !value.trim().is_empty());
    if relay_server_id.is_some() != relay_access_grant.is_some() {
        return Err("Host Connector ha restituito dati relay incompleti.".to_string());
    }

    let record = PairingRecord {
        server_base_url: server_base_url.clone(),
        device_id: envelope.device.id,
        device_name: envelope.device.device_name,
        fingerprint: envelope.device.fingerprint,
        paired_at: envelope.device.paired_at,
        relay_server_id,
        relay_access_grant,
    };

    if let Some(bootstrap) = direct_bootstrap.as_ref() {
        state.store_direct_pairing(
            record.clone(),
            &bootstrap.connector_endpoint,
            &bootstrap.server_fingerprint,
        )?;
    } else {
        state.store_pairing(record.clone())?;
        if !relay_was_active {
            let _ = relay_bridge::RelayBridge::start_if_configured(&*state)?;
        }
    }

    Ok(status_from_record(&server_base_url, Some(record)))
}

#[cfg(test)]
mod tests {
    use super::{
        ensure_local_connector_server, normalize_device_name, parse_pairing_input,
        validate_connector_response, ConnectorPairingResponse, PairedDeviceResponse,
        PROTOCOL_VERSION,
    };
    use base64::Engine as _;
    use uuid::Uuid;

    #[test]
    fn phase3c_pairing_uses_connector_only_for_node_loopback_3000() {
        assert!(ensure_local_connector_server("http://127.0.0.1:3000").is_ok());
        assert!(ensure_local_connector_server("http://localhost:3000").is_ok());
        assert!(ensure_local_connector_server("http://192.168.1.50:3000").is_err());
        assert!(ensure_local_connector_server("http://127.0.0.1:3001").is_err());
        assert!(ensure_local_connector_server("https://127.0.0.1:3000").is_err());
    }

    #[test]
    fn normalizes_device_name_without_control_characters() {
        assert_eq!(
            normalize_device_name(Some("  PC\n  salotto   principale  ".to_string())),
            "PC salotto principale"
        );
    }

    #[test]
    fn accepts_legacy_server_response_with_extra_profile_key() {
        let json = r#"{
          "id": "660e8400-e29b-41d4-a716-446655440000",
          "deviceName": "PC legacy",
          "profileKey": "default",
          "fingerprint": "SHA256:fixture",
          "pairedAt": "2026-08-05T12:00:00.000Z"
        }"#;
        let response: PairedDeviceResponse = serde_json::from_str(json).unwrap();
        assert_eq!(response.device_name, "PC legacy");
    }

    #[test]
    fn direct_bootstrap_carries_public_endpoint_pin_and_inner_invite() {
        let payload = serde_json::json!({
            "version": 1,
            "connectorEndpoint": "https://baia.example.test:443",
            "serverFingerprint": "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "inviteToken": "baia1.550e8400-e29b-41d4-a716-446655440000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        });
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&payload).unwrap());
        let value = format!("baia-direct1.{encoded}");
        let (inner, bootstrap) = parse_pairing_input(&value).unwrap();
        let bootstrap = bootstrap.unwrap();

        assert!(inner.starts_with("baia1."));
        assert_eq!(bootstrap.connector_endpoint, "https://baia.example.test");
        assert_eq!(
            bootstrap.server_fingerprint,
            "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        );
        assert_eq!(inner, payload["inviteToken"].as_str().unwrap());
    }

    #[test]
    fn direct_bootstrap_rejects_non_public_connector_endpoint() {
        let payload = serde_json::json!({
            "version": 1,
            "connectorEndpoint": "https://192.168.1.50:43127",
            "serverFingerprint": "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "inviteToken": "baia1.550e8400-e29b-41d4-a716-446655440000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        });
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&payload).unwrap());
        assert!(parse_pairing_input(&format!("baia-direct1.{encoded}")).is_err());
    }

    #[test]
    fn pairing_connector_response_requires_protocol_and_request_id() {
        let request_id = Uuid::new_v4().to_string();
        let good = ConnectorPairingResponse {
            protocol_version: PROTOCOL_VERSION,
            request_id: request_id.clone(),
            status: 200,
            body: "{}".to_string(),
            relay_server_id: None,
            relay_access_grant: None,
        };
        assert!(validate_connector_response(&good, &request_id).is_ok());

        let bad_version = ConnectorPairingResponse {
            protocol_version: 2,
            request_id: request_id.clone(),
            status: 200,
            body: "{}".to_string(),
            relay_server_id: None,
            relay_access_grant: None,
        };
        assert!(validate_connector_response(&bad_version, &request_id).is_err());

        let bad_id = ConnectorPairingResponse {
            protocol_version: PROTOCOL_VERSION,
            request_id: Uuid::new_v4().to_string(),
            status: 200,
            body: "{}".to_string(),
            relay_server_id: None,
            relay_access_grant: None,
        };
        assert!(validate_connector_response(&bad_id, &request_id).is_err());
    }
}
