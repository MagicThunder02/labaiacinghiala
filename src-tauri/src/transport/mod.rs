use crate::{
    auth,
    connector_tls,
    core::CoreState,
};
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, net::IpAddr, sync::Mutex, time::Duration};
use tauri::State;
use url::{Host, Url};
use uuid::Uuid;

const PROTOCOL_VERSION: u16 = 1;
const MAX_REQUEST_BODY_BYTES: usize = 2 * 1024 * 1024;
const MAX_RESPONSE_BODY_BYTES: u64 = 4 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(125);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

const ALLOWED_REQUEST_HEADERS: &[&str] = &["accept", "content-type"];

struct CachedConnectorClient {
    fingerprint: String,
    client: Client,
}

pub struct TransportManager {
    connector_client: Mutex<Option<CachedConnectorClient>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApiTransportRequest {
    path: String,
    method: String,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    #[serde(default)]
    body: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiTransportResponse {
    status: u16,
    ok: bool,
    headers: BTreeMap<String, String>,
    body: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectorProtocolRequest {
    protocol_version: u16,
    request_id: String,
    method: String,
    path: String,
    headers: BTreeMap<String, String>,
    body: Option<String>,
    access_grant: String,
    device_auth: auth::RequestAuthorization,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConnectorProtocolResponse {
    protocol_version: u16,
    request_id: String,
    status: u16,
    headers: BTreeMap<String, String>,
    body: String,
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

impl TransportManager {
    pub fn new() -> Self {
        Self {
            connector_client: Mutex::new(None),
        }
    }

    fn client_for(&self, server_fingerprint: &str) -> Result<Client, String> {
        let mut guard = self
            .connector_client
            .lock()
            .map_err(|_| "Cache TLS del Transport Manager non disponibile.".to_string())?;
        if let Some(cached) = guard.as_ref() {
            if cached.fingerprint == server_fingerprint {
                return Ok(cached.client.clone());
            }
        }

        let client = connector_tls::async_client(
            server_fingerprint,
            CONNECT_TIMEOUT,
            Some(REQUEST_TIMEOUT),
        )
        .map_err(|error| format!("Impossibile inizializzare il Transport Manager TLS: {error}"))?;
        *guard = Some(CachedConnectorClient {
            fingerprint: server_fingerprint.to_string(),
            client: client.clone(),
        });
        Ok(client)
    }

    async fn connector_api_request(
        &self,
        request: ApiTransportRequest,
        core_state: &CoreState,
    ) -> Result<ApiTransportResponse, String> {
        let method = normalize_method(&request.method)?;
        let path = normalize_api_path(&request.path)?;
        let headers = normalize_request_headers(request.headers)?;
        let body = normalize_body(&method, request.body)?;
        let (base_url, _, _) = core_state.pairing_context()?;
        ensure_local_connector_server(&base_url)?;

        // La firma resta contestualizzata al Node logico configurato; il Connector
        // inoltra gli header senza possedere o ricostruire la private key device.
        let target = build_signature_target(&base_url, &path)?;
        let authorization = auth::authorize_request(method.as_str(), target.as_str(), core_state)?;
        let access_grant = core_state.transport_access_grant()?;
        let request_id = Uuid::new_v4().to_string();
        let frame = ConnectorProtocolRequest {
            protocol_version: PROTOCOL_VERSION,
            request_id: request_id.clone(),
            method: method.as_str().to_string(),
            path,
            headers,
            body,
            access_grant,
            device_auth: authorization,
        };

        let (connector_endpoint, server_fingerprint) = core_state.connector_context()?;
        let connector_url =
            connector_tls::connector_url(&connector_endpoint, connector_tls::REQUEST_PATH)?;
        let connector_client = self.client_for(&server_fingerprint)?;
        let response = connector_client
            .post(&connector_url)
            .header(reqwest::header::ACCEPT, "application/json")
            .json(&frame)
            .send()
            .await
            .map_err(|error| format!(
                "Baia Host Connector TLS non raggiungibile o identita server rifiutata su {connector_endpoint}: {error}"
            ))?;

        if response.status().is_redirection() {
            return Err("Il Baia Host Connector ha restituito un redirect non consentito.".to_string());
        }

        let connector_status = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(|error| format!("Impossibile leggere la risposta del Baia Host Connector: {error}"))?;
        if bytes.len() as u64 > MAX_RESPONSE_BODY_BYTES.saturating_add(256 * 1024) {
            return Err("Risposta del Baia Host Connector troppo grande.".to_string());
        }

        if !connector_status.is_success() {
            let parsed = serde_json::from_slice::<ConnectorProtocolError>(&bytes).ok();
            if let Some(error) = parsed {
                let code = error.error_code.unwrap_or_else(|| "HOST_CONNECTOR_ERROR".to_string());
                let message = error.message.unwrap_or_else(|| "Errore del Baia Host Connector.".to_string());
                let protocol_note = error
                    .protocol_version
                    .filter(|version| *version != PROTOCOL_VERSION)
                    .map(|version| format!(" protocollo={version}"))
                    .unwrap_or_default();
                let request_note = error
                    .request_id
                    .filter(|value| value == &request_id)
                    .map(|_| format!(" request={request_id}"))
                    .unwrap_or_default();
                return Err(format!("{code}: {message}{protocol_note}{request_note}"));
            }
            return Err(format!(
                "Baia Host Connector ha restituito HTTP {}.",
                connector_status.as_u16()
            ));
        }

        let payload: ConnectorProtocolResponse = serde_json::from_slice(&bytes)
            .map_err(|_| "Risposta protocollo v1 del Baia Host Connector non valida.".to_string())?;
        validate_connector_response(&payload, &request_id)?;
        if payload.body.len() as u64 > MAX_RESPONSE_BODY_BYTES {
            return Err("La risposta API del server è troppo grande per il trasporto JSON del Core.".to_string());
        }

        Ok(ApiTransportResponse {
            status: payload.status,
            ok: (200..300).contains(&payload.status),
            headers: payload.headers,
            body: payload.body,
        })
    }
}

fn normalize_method(value: &str) -> Result<Method, String> {
    match value.trim().to_ascii_uppercase().as_str() {
        "GET" => Ok(Method::GET),
        "HEAD" => Ok(Method::HEAD),
        "POST" => Ok(Method::POST),
        "PUT" => Ok(Method::PUT),
        _ => Err("Metodo API non consentito dal Transport Manager.".to_string()),
    }
}

fn normalize_api_path(value: &str) -> Result<String, String> {
    let path = value.trim();
    if !path.starts_with("/api/") || path.starts_with("//") {
        return Err("Il Transport Manager accetta soltanto path relativi /api/.".to_string());
    }
    if path.contains('\\') || path.contains('#') {
        return Err("Path API non valido.".to_string());
    }

    let parsed = Url::parse(&format!("http://baia.invalid{path}"))
        .map_err(|_| "Path API non valido.".to_string())?;
    if !parsed.path().starts_with("/api/") || parsed.fragment().is_some() {
        return Err("Il Transport Manager accetta soltanto path relativi /api/.".to_string());
    }

    Ok(match parsed.query() {
        Some(query) => format!("{}?{query}", parsed.path()),
        None => parsed.path().to_string(),
    })
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
    let parsed = Url::parse(base_url)
        .map_err(|_| "Endpoint Node configurato non valido per la Fase 3 locale.".to_string())?;
    if parsed.scheme() != "http"
        || !is_loopback_host(&parsed)
        || parsed.port_or_known_default() != Some(3000)
        || parsed.path() != "/"
    {
        return Err(
            "La Fase 3A locale richiede Node su http://127.0.0.1:3000 (o loopback equivalente)."
                .to_string(),
        );
    }
    Ok(())
}

fn build_signature_target(base_url: &str, path: &str) -> Result<Url, String> {
    let target = Url::parse(&format!("{base_url}{path}"))
        .map_err(|_| "Impossibile costruire la destinazione API Baia.".to_string())?;
    if target.origin().ascii_serialization() != base_url || !target.path().starts_with("/api/") {
        return Err("Destinazione API fuori dal server Baia configurato.".to_string());
    }
    Ok(target)
}

fn normalize_request_headers(headers: BTreeMap<String, String>) -> Result<BTreeMap<String, String>, String> {
    let mut accepted = BTreeMap::new();
    for (name, value) in headers {
        let normalized = name.trim().to_ascii_lowercase();
        if normalized.starts_with("x-baia-") {
            return Err("Gli header X-Baia vengono generati esclusivamente dal Core.".to_string());
        }
        if !ALLOWED_REQUEST_HEADERS.contains(&normalized.as_str()) {
            return Err(format!("Header API non consentito dal Transport Manager: {name}."));
        }
        if value.contains('\r') || value.contains('\n') {
            return Err("Valore header API non valido.".to_string());
        }
        accepted.insert(normalized, value);
    }
    Ok(accepted)
}

fn normalize_body(method: &Method, body: Option<String>) -> Result<Option<String>, String> {
    let body = body.filter(|value| !value.is_empty());
    if matches!(*method, Method::GET | Method::HEAD) && body.is_some() {
        return Err("GET e HEAD non possono avere un body nel Transport Manager.".to_string());
    }
    if body.as_ref().is_some_and(|value| value.len() > MAX_REQUEST_BODY_BYTES) {
        return Err("Il body della richiesta API è troppo grande.".to_string());
    }
    Ok(body)
}

fn validate_connector_response(
    response: &ConnectorProtocolResponse,
    expected_request_id: &str,
) -> Result<(), String> {
    if response.protocol_version != PROTOCOL_VERSION {
        return Err(format!(
            "Versione protocollo Host Connector incompatibile: {}.",
            response.protocol_version
        ));
    }
    if response.request_id != expected_request_id {
        return Err("Request ID Host Connector non corrispondente.".to_string());
    }
    if !(100..=599).contains(&response.status) {
        return Err("Status upstream Host Connector non valido.".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn baia_core_api_request(
    request: ApiTransportRequest,
    core_state: State<'_, CoreState>,
    transport: State<'_, TransportManager>,
) -> Result<ApiTransportResponse, String> {
    transport.connector_api_request(request, &core_state).await
}

#[cfg(test)]
mod tests {
    use super::{
        ensure_local_connector_server, normalize_api_path, normalize_body, normalize_method,
        normalize_request_headers, validate_connector_response, ConnectorProtocolResponse,
        PROTOCOL_VERSION,
    };
    use std::collections::BTreeMap;
    use uuid::Uuid;

    #[test]
    fn api_path_accepts_only_relative_api_routes() {
        assert_eq!(normalize_api_path("/api/movies?limit=10").unwrap(), "/api/movies?limit=10");
        assert!(normalize_api_path("https://evil.invalid/api/movies").is_err());
        assert!(normalize_api_path("/admin").is_err());
        assert!(normalize_api_path("/api/../admin").is_err());
        assert!(normalize_api_path("/api/movies#fragment").is_err());
    }

    #[test]
    fn api_headers_reject_device_auth_from_frontend() {
        let mut headers = BTreeMap::new();
        headers.insert("Content-Type".to_string(), "application/json".to_string());
        assert_eq!(normalize_request_headers(headers).unwrap().get("content-type").map(String::as_str), Some("application/json"));

        let mut forged = BTreeMap::new();
        forged.insert("X-Baia-Signature".to_string(), "forged".to_string());
        assert!(normalize_request_headers(forged).is_err());
    }

    #[test]
    fn api_method_and_body_contract_is_restricted() {
        let get = normalize_method("get").unwrap();
        assert!(normalize_body(&get, None).is_ok());
        assert!(normalize_body(&get, Some("payload".to_string())).is_err());
        assert!(normalize_method("DELETE").is_err());
    }

    #[test]
    fn phase3a_connector_mode_requires_node_loopback_port_3000() {
        assert!(ensure_local_connector_server("http://127.0.0.1:3000").is_ok());
        assert!(ensure_local_connector_server("http://localhost:3000").is_ok());
        assert!(ensure_local_connector_server("http://192.168.1.50:3000").is_err());
        assert!(ensure_local_connector_server("http://127.0.0.1:3001").is_err());
        assert!(ensure_local_connector_server("https://127.0.0.1:3000").is_err());
    }

    #[test]
    fn connector_response_requires_protocol_and_matching_request_id() {
        let request_id = Uuid::new_v4().to_string();
        let good = ConnectorProtocolResponse {
            protocol_version: PROTOCOL_VERSION,
            request_id: request_id.clone(),
            status: 200,
            headers: BTreeMap::new(),
            body: "{}".to_string(),
        };
        assert!(validate_connector_response(&good, &request_id).is_ok());

        let bad_version = ConnectorProtocolResponse {
            protocol_version: 2,
            request_id: request_id.clone(),
            status: 200,
            headers: BTreeMap::new(),
            body: "{}".to_string(),
        };
        assert!(validate_connector_response(&bad_version, &request_id).is_err());

        let bad_id = ConnectorProtocolResponse {
            protocol_version: PROTOCOL_VERSION,
            request_id: Uuid::new_v4().to_string(),
            status: 200,
            headers: BTreeMap::new(),
            body: "{}".to_string(),
        };
        assert!(validate_connector_response(&bad_id, &request_id).is_err());
    }
}
