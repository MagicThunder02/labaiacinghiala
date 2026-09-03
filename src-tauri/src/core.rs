use crate::{connector_tls, relay_bridge};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State};
use url::Url;
use uuid::Uuid;

pub const DEFAULT_API_BASE_URL: &str = "http://127.0.0.1:3000";
const CONFIG_FILE_NAME: &str = "connection.json";
const CONFIG_SCHEMA_VERSION: u32 = 1;
const PROBE_TIMEOUT: Duration = Duration::from_millis(1200);

// Bootstrap pubblico, deliberatamente temporaneo, solo per l'APK di prova Fase 4B.
// Non contiene segreti: endpoint LAN e fingerprint pubblica del Connector.
#[cfg(target_os = "android")]
const ANDROID_TEST_CONNECTOR_ENDPOINT: &str = "https://10.239.168.236:43127";
#[cfg(target_os = "android")]
const ANDROID_TEST_CONNECTOR_FINGERPRINT: &str =
    "SHA256:tFv0VGkaNeUB7khsLolKtsYg076d1eVpkcZEZIdnj4k";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PairingRecord {
    pub server_base_url: String,
    pub device_id: String,
    pub device_name: String,
    pub fingerprint: String,
    pub paired_at: String,
    #[serde(default)]
    pub relay_server_id: Option<String>,
    #[serde(default)]
    pub relay_access_grant: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionConfig {
    schema_version: u32,
    installation_id: String,
    server_base_url: String,
    #[serde(default = "default_connector_endpoint")]
    connector_endpoint: String,
    #[serde(default = "default_connector_server_fingerprint")]
    connector_server_fingerprint: Option<String>,
    #[serde(default)]
    relay_endpoint: Option<String>,
    #[serde(default)]
    relay_cert_fingerprint: Option<String>,
    #[serde(default)]
    pairing: Option<PairingRecord>,
}

pub struct CoreState {
    config_path: PathBuf,
    config: Mutex<ConnectionConfig>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreBootstrap {
    core_version: &'static str,
    platform: &'static str,
    api_base_url: String,
    transport: &'static str,
    installation_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerProbe {
    reachable: bool,
    elapsed_ms: u64,
    api_base_url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectorHealth {
    protocol_version: u16,
    status: String,
    node_reachable: bool,
}

impl CoreState {
    pub fn initialize(app: &AppHandle) -> Result<Self, String> {
        let config_dir = app
            .path()
            .app_config_dir()
            .map_err(|error| format!("Impossibile determinare la cartella di configurazione Baia: {error}"))?;
        fs::create_dir_all(&config_dir)
            .map_err(|error| format!("Impossibile creare la cartella di configurazione Baia: {error}"))?;

        let config_path = config_dir.join(CONFIG_FILE_NAME);
        let mut config = load_or_create_config(&config_path)?;

        let mut config_changed = false;

        let runtime_connector_endpoint = match std::env::var(connector_tls::CONNECTOR_ENDPOINT_ENV) {
            Ok(value) => Some(value),
            Err(std::env::VarError::NotPresent) => None,
            Err(std::env::VarError::NotUnicode(_)) => {
                return Err(format!(
                    "{} deve contenere un endpoint UTF-8 valido.",
                    connector_tls::CONNECTOR_ENDPOINT_ENV
                ));
            }
        };
        let compiled_connector_endpoint = option_env!("BAIA_CONNECTOR_ENDPOINT").map(str::to_string);
        if let Some(value) = runtime_connector_endpoint.or(compiled_connector_endpoint) {
            let normalized = connector_tls::normalize_connector_endpoint(&value)?;
            if config.connector_endpoint != normalized {
                config.connector_endpoint = normalized;
                config_changed = true;
            }
        }

        let runtime_connector_fingerprint = match std::env::var(connector_tls::CONNECTOR_FINGERPRINT_ENV) {
            Ok(value) => Some(value),
            Err(std::env::VarError::NotPresent) => None,
            Err(std::env::VarError::NotUnicode(_)) => {
                return Err(format!(
                    "{} deve contenere una fingerprint UTF-8 valida.",
                    connector_tls::CONNECTOR_FINGERPRINT_ENV
                ));
            }
        };
        let compiled_connector_fingerprint =
            option_env!("BAIA_CONNECTOR_SERVER_FINGERPRINT").map(str::to_string);
        if let Some(value) = runtime_connector_fingerprint.or(compiled_connector_fingerprint) {
            let normalized = connector_tls::normalize_server_fingerprint(&value)?;
            if config.connector_server_fingerprint.as_deref() != Some(normalized.as_str()) {
                config.connector_server_fingerprint = Some(normalized);
                config_changed = true;
            }
        }

        let runtime_relay_endpoint = match std::env::var(relay_bridge::RELAY_ENDPOINT_ENV) {
            Ok(value) => Some(value),
            Err(std::env::VarError::NotPresent) => None,
            Err(std::env::VarError::NotUnicode(_)) => {
                return Err(format!(
                    "{} deve contenere un endpoint UTF-8 valido.",
                    relay_bridge::RELAY_ENDPOINT_ENV
                ));
            }
        };
        let compiled_relay_endpoint = option_env!("BAIA_RELAY_ENDPOINT").map(str::to_string);
        if let Some(value) = runtime_relay_endpoint.or(compiled_relay_endpoint) {
            let normalized = relay_bridge::normalize_relay_endpoint(&value)?;
            if config.relay_endpoint.as_deref() != Some(normalized.as_str()) {
                config.relay_endpoint = Some(normalized);
                config_changed = true;
            }
        }

        let runtime_relay_fingerprint = match std::env::var(relay_bridge::RELAY_CERT_FINGERPRINT_ENV) {
            Ok(value) => Some(value),
            Err(std::env::VarError::NotPresent) => None,
            Err(std::env::VarError::NotUnicode(_)) => {
                return Err(format!(
                    "{} deve contenere una fingerprint UTF-8 valida.",
                    relay_bridge::RELAY_CERT_FINGERPRINT_ENV
                ));
            }
        };
        let compiled_relay_fingerprint = option_env!("BAIA_RELAY_CERT_FINGERPRINT").map(str::to_string);
        if let Some(value) = runtime_relay_fingerprint.or(compiled_relay_fingerprint) {
            let normalized = relay_bridge::normalize_relay_cert_fingerprint(&value)?;
            if config.relay_cert_fingerprint.as_deref() != Some(normalized.as_str()) {
                config.relay_cert_fingerprint = Some(normalized);
                config_changed = true;
            }
        }

        if config_changed {
            persist_config(&config_path, &config)?;
        }

        Ok(Self {
            config_path,
            config: Mutex::new(config),
        })
    }

    fn snapshot(&self) -> Result<ConnectionConfig, String> {
        self.config
            .lock()
            .map(|config| config.clone())
            .map_err(|_| "Configurazione Baia Core non disponibile.".to_string())
    }

    fn set_server_endpoint(&self, endpoint: &str) -> Result<ConnectionConfig, String> {
        let normalized = normalize_server_endpoint(endpoint)?;
        let mut guard = self
            .config
            .lock()
            .map_err(|_| "Configurazione Baia Core non disponibile.".to_string())?;

        let mut next = guard.clone();
        next.server_base_url = normalized;
        persist_config(&self.config_path, &next)?;
        *guard = next.clone();
        Ok(next)
    }

    fn reset_server_endpoint(&self) -> Result<ConnectionConfig, String> {
        self.set_server_endpoint(DEFAULT_API_BASE_URL)
    }

    pub(crate) fn connector_endpoint(&self) -> Result<String, String> {
        let config = self.snapshot()?;
        Ok(selected_connector_endpoint(&config))
    }

    pub(crate) fn connector_context(&self) -> Result<(String, String), String> {
        let config = self.snapshot()?;
        let fingerprint = config.connector_server_fingerprint.clone().ok_or_else(|| {
            format!(
                "Pin Host Connector non configurato. Avvia Baia con {}=SHA256:<fingerprint>.",
                connector_tls::CONNECTOR_FINGERPRINT_ENV
            )
        })?;
        Ok((selected_connector_endpoint(&config), fingerprint))
    }

    pub(crate) fn relay_context(&self) -> Result<Option<(String, String, String, String)>, String> {
        let config = self.snapshot()?;
        // Direct Internet ha precedenza esplicita sul fallback relay.
        if direct_connector_ready(&config) || !relay_ready(&config) {
            return Ok(None);
        }
        let pairing = config.pairing.ok_or_else(|| "Pairing relay non disponibile.".to_string())?;
        Ok(Some((
            config.relay_endpoint.expect("relay_ready richiede relay_endpoint"),
            config.relay_cert_fingerprint.expect("relay_ready richiede relay_cert_fingerprint"),
            pairing.relay_access_grant.expect("relay_ready richiede relay_access_grant"),
            pairing.relay_server_id.expect("relay_ready richiede relay_server_id"),
        )))
    }

    pub(crate) fn pairing_context(&self) -> Result<(String, String, Option<PairingRecord>), String> {
        let config = self.snapshot()?;
        Ok((config.server_base_url, config.installation_id, config.pairing))
    }

    pub(crate) fn transport_access_grant(&self) -> Result<String, String> {
        let config = self.snapshot()?;
        let pairing = config
            .pairing
            .ok_or_else(|| "Questo client Baia non è ancora associato al server.".to_string())?;
        pairing.relay_access_grant.ok_or_else(|| {
            "Il pairing salvato non contiene il grant di accesso trasporto. Genera un nuovo invito e associa nuovamente questo dispositivo.".to_string()
        })
    }

    pub(crate) fn store_pairing(&self, record: PairingRecord) -> Result<(), String> {
        let mut guard = self
            .config
            .lock()
            .map_err(|_| "Configurazione Baia Core non disponibile.".to_string())?;

        let mut next = guard.clone();
        next.pairing = Some(record);
        persist_config(&self.config_path, &next)?;
        *guard = next;
        Ok(())
    }

    pub(crate) fn store_direct_pairing(
        &self,
        record: PairingRecord,
        connector_endpoint: &str,
        connector_fingerprint: &str,
    ) -> Result<(), String> {
        let endpoint = connector_tls::normalize_connector_endpoint(connector_endpoint)?;
        if connector_tls::classify_connector_endpoint(&endpoint)?
            != connector_tls::ConnectorEndpointKind::DirectInternet
        {
            return Err("Il bootstrap Direct deve indicare un endpoint Internet HTTPS su TCP 443.".to_string());
        }
        let fingerprint = connector_tls::normalize_server_fingerprint(connector_fingerprint)?;

        let mut guard = self
            .config
            .lock()
            .map_err(|_| "Configurazione Baia Core non disponibile.".to_string())?;
        let mut next = guard.clone();
        next.connector_endpoint = endpoint;
        next.connector_server_fingerprint = Some(fingerprint);
        next.pairing = Some(record);
        persist_config(&self.config_path, &next)?;
        *guard = next;
        Ok(())
    }
}

fn default_connector_endpoint() -> String {
    #[cfg(target_os = "android")]
    {
        return ANDROID_TEST_CONNECTOR_ENDPOINT.to_string();
    }

    #[cfg(not(target_os = "android"))]
    {
        connector_tls::DEFAULT_CONNECTOR_ENDPOINT.to_string()
    }
}

fn default_connector_server_fingerprint() -> Option<String> {
    #[cfg(target_os = "android")]
    {
        return Some(ANDROID_TEST_CONNECTOR_FINGERPRINT.to_string());
    }

    #[cfg(not(target_os = "android"))]
    {
        None
    }
}

fn default_config() -> ConnectionConfig {
    ConnectionConfig {
        schema_version: CONFIG_SCHEMA_VERSION,
        installation_id: Uuid::new_v4().to_string(),
        server_base_url: DEFAULT_API_BASE_URL.to_string(),
        connector_endpoint: default_connector_endpoint(),
        connector_server_fingerprint: default_connector_server_fingerprint(),
        relay_endpoint: None,
        relay_cert_fingerprint: None,
        pairing: None,
    }
}

fn load_or_create_config(path: &Path) -> Result<ConnectionConfig, String> {
    if !path.exists() {
        let config = default_config();
        persist_config(path, &config)?;
        return Ok(config);
    }

    let loaded = fs::read_to_string(path)
        .map_err(|error| format!("Impossibile leggere la configurazione Baia Core: {error}"))
        .and_then(|contents| {
            serde_json::from_str::<ConnectionConfig>(&contents)
                .map_err(|error| format!("Configurazione Baia Core non valida: {error}"))
        })
        .and_then(validate_loaded_config);

    match loaded {
        Ok(config) => Ok(config),
        Err(error) => {
            backup_invalid_config(path)?;
            eprintln!("{error} È stata conservata una copia della configurazione non valida.");
            let config = default_config();
            persist_config(path, &config)?;
            Ok(config)
        }
    }
}

fn validate_loaded_config(mut config: ConnectionConfig) -> Result<ConnectionConfig, String> {
    if config.schema_version != CONFIG_SCHEMA_VERSION {
        return Err(format!(
            "Versione configurazione Baia Core non supportata: {}.",
            config.schema_version
        ));
    }

    Uuid::parse_str(&config.installation_id)
        .map_err(|_| "Identificatore installazione Baia Core non valido.".to_string())?;
    config.server_base_url = normalize_server_endpoint(&config.server_base_url)?;
    config.connector_endpoint =
        connector_tls::normalize_connector_endpoint(&config.connector_endpoint)?;
    if let Some(fingerprint) = config.connector_server_fingerprint.as_mut() {
        *fingerprint = connector_tls::normalize_server_fingerprint(fingerprint)?;
    }
    if let Some(endpoint) = config.relay_endpoint.as_mut() {
        *endpoint = relay_bridge::normalize_relay_endpoint(endpoint)?;
    }
    if let Some(fingerprint) = config.relay_cert_fingerprint.as_mut() {
        *fingerprint = relay_bridge::normalize_relay_cert_fingerprint(fingerprint)?;
    }
    if config.relay_endpoint.is_some() != config.relay_cert_fingerprint.is_some() {
        return Err("Configurazione relay incompleta: endpoint e pin TLS devono essere presenti insieme.".to_string());
    }

    if let Some(pairing) = config.pairing.as_mut() {
        pairing.server_base_url = normalize_server_endpoint(&pairing.server_base_url)?;
        Uuid::parse_str(&pairing.device_id)
            .map_err(|_| "ID dispositivo associato non valido.".to_string())?;
        if pairing.device_name.trim().is_empty()
            || !pairing.fingerprint.starts_with("SHA256:")
            || pairing.paired_at.trim().is_empty()
        {
            return Err("Dati locali del pairing non validi.".to_string());
        }
        if pairing.relay_server_id.is_some() != pairing.relay_access_grant.is_some() {
            return Err("Dati relay del pairing incompleti.".to_string());
        }
        if let Some(server_id) = pairing.relay_server_id.as_deref() {
            if !server_id.starts_with("srv1_") || server_id.len() < 16 {
                return Err("server_id relay locale non valido.".to_string());
            }
        }
    }

    Ok(config)
}

fn backup_invalid_config(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let backup_name = format!("connection.invalid-{timestamp}.json");
    let backup_path = path.with_file_name(backup_name);

    fs::rename(path, &backup_path).or_else(|_| {
        fs::copy(path, &backup_path)?;
        fs::remove_file(path)
    })
    .map_err(|error| format!("Impossibile mettere al sicuro la configurazione Baia Core non valida: {error}"))
}

fn persist_config(path: &Path, config: &ConnectionConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Impossibile creare la cartella di configurazione Baia Core: {error}"))?;
    }

    let payload = serde_json::to_vec_pretty(config)
        .map_err(|error| format!("Impossibile serializzare la configurazione Baia Core: {error}"))?;
    let temp_path = path.with_extension("json.tmp");

    fs::write(&temp_path, payload)
        .map_err(|error| format!("Impossibile scrivere la configurazione temporanea Baia Core: {error}"))?;

    if path.exists() {
        fs::remove_file(path)
            .map_err(|error| format!("Impossibile sostituire la configurazione Baia Core: {error}"))?;
    }

    fs::rename(&temp_path, path)
        .map_err(|error| format!("Impossibile finalizzare la configurazione Baia Core: {error}"))
}

fn normalize_server_endpoint(value: &str) -> Result<String, String> {
    let input = value.trim();
    if input.is_empty() {
        return Err("Inserisci l'indirizzo del server Baia.".to_string());
    }

    let parsed = Url::parse(input).map_err(|_| "Indirizzo server non valido.".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Il server Baia deve usare http:// o https://.".to_string());
    }
    if parsed.host_str().is_none() {
        return Err("L'indirizzo server deve contenere un host.".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("L'indirizzo server non deve contenere credenziali.".to_string());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("L'indirizzo server non deve contenere query o frammenti.".to_string());
    }
    if parsed.path() != "/" {
        return Err("Inserisci solo l'origine del server, senza percorso aggiuntivo.".to_string());
    }

    Ok(parsed.origin().ascii_serialization())
}

fn direct_connector_ready(config: &ConnectionConfig) -> bool {
    matches!(
        connector_tls::classify_connector_endpoint(&config.connector_endpoint),
        Ok(connector_tls::ConnectorEndpointKind::DirectInternet)
    )
}

fn relay_ready(config: &ConnectionConfig) -> bool {
    config.relay_endpoint.is_some()
        && config.relay_cert_fingerprint.is_some()
        && config.pairing.as_ref().is_some_and(|pairing| {
            pairing.relay_server_id.is_some() && pairing.relay_access_grant.is_some()
        })
}

fn selected_connector_endpoint(config: &ConnectionConfig) -> String {
    if direct_connector_ready(config) {
        return config.connector_endpoint.clone();
    }
    if relay_ready(config) {
        return relay_bridge::LOCAL_RELAY_CONNECTOR_ENDPOINT.to_string();
    }
    config.connector_endpoint.clone()
}

fn transport_for_config(config: &ConnectionConfig) -> &'static str {
    if direct_connector_ready(config) {
        "direct-internet-tls-v1"
    } else if relay_ready(config) {
        "relay-tls-mux-v1"
    } else {
        match connector_tls::classify_connector_endpoint(&config.connector_endpoint) {
            Ok(connector_tls::ConnectorEndpointKind::RelayBridge) => "relay-local-bridge-v1",
            _ => "connector-lan-tls-v1",
        }
    }
}

fn bootstrap_from_config(config: ConnectionConfig) -> CoreBootstrap {
    let transport = transport_for_config(&config);
    CoreBootstrap {
        core_version: env!("CARGO_PKG_VERSION"),
        platform: std::env::consts::OS,
        transport,
        api_base_url: config.server_base_url,
        installation_id: config.installation_id,
    }
}

async fn probe_connector(endpoint: &str, fingerprint: &str) -> bool {
    let client = match connector_tls::async_client(
        fingerprint,
        PROBE_TIMEOUT,
        Some(PROBE_TIMEOUT),
    ) {
        Ok(client) => client,
        Err(_) => return false,
    };
    let url = match connector_tls::connector_url(endpoint, connector_tls::HEALTH_PATH) {
        Ok(url) => url,
        Err(_) => return false,
    };

    let response = match client.get(url).send().await {
        Ok(response) if response.status().is_success() => response,
        _ => return false,
    };
    match response.json::<ConnectorHealth>().await {
        Ok(health) => {
            health.protocol_version == 1
                && health.status == "ready"
                && health.node_reachable
        }
        Err(_) => false,
    }
}

#[tauri::command]
pub fn baia_core_bootstrap(state: State<'_, CoreState>) -> Result<CoreBootstrap, String> {
    state.snapshot().map(bootstrap_from_config)
}

#[tauri::command]
pub fn baia_core_set_server_endpoint(
    endpoint: String,
    state: State<'_, CoreState>,
) -> Result<CoreBootstrap, String> {
    state.set_server_endpoint(&endpoint).map(bootstrap_from_config)
}

#[tauri::command]
pub fn baia_core_reset_server_endpoint(
    state: State<'_, CoreState>,
) -> Result<CoreBootstrap, String> {
    state.reset_server_endpoint().map(bootstrap_from_config)
}

#[tauri::command]
pub async fn baia_core_probe_server(state: State<'_, CoreState>) -> Result<ServerProbe, String> {
    let config = state.snapshot()?;
    let api_base_url = config.server_base_url;
    let started = Instant::now();
    let reachable = match state.connector_context() {
        Ok((endpoint, fingerprint)) => probe_connector(&endpoint, &fingerprint).await,
        Err(_) => false,
    };

    Ok(ServerProbe {
        reachable,
        elapsed_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
        api_base_url,
    })
}

#[cfg(test)]
mod tests {
    use super::{default_connector_endpoint, normalize_server_endpoint, transport_for_config};

    #[test]
    fn normalizes_supported_server_origins() {
        assert_eq!(
            normalize_server_endpoint("http://127.0.0.1:3000/").unwrap(),
            "http://127.0.0.1:3000"
        );
        assert_eq!(
            normalize_server_endpoint("https://example.test").unwrap(),
            "https://example.test"
        );
    }

    #[test]
    fn rejects_unsafe_or_non_origin_values() {
        assert!(normalize_server_endpoint("file:///tmp/baia").is_err());
        assert!(normalize_server_endpoint("http://user:pass@127.0.0.1:3000").is_err());
        assert!(normalize_server_endpoint("http://127.0.0.1:3000/api").is_err());
        assert!(normalize_server_endpoint("http://127.0.0.1:3000/?x=1").is_err());
    }


    #[test]
    fn direct_internet_endpoint_has_priority_over_relay_fallback() {
        let mut config = super::default_config();
        config.connector_endpoint = "https://baia.example.test".to_string();
        config.connector_server_fingerprint = Some(
            "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_string(),
        );
        config.relay_endpoint = Some("tls://relay.example.test:443".to_string());
        config.relay_cert_fingerprint = Some(
            "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_string(),
        );
        config.pairing = Some(super::PairingRecord {
            server_base_url: "http://127.0.0.1:3000".to_string(),
            device_id: "660e8400-e29b-41d4-a716-446655440000".to_string(),
            device_name: "Fixture".to_string(),
            fingerprint: "SHA256:device".to_string(),
            paired_at: "2026-08-22T12:00:00Z".to_string(),
            relay_server_id: Some("srv1_fixturefixture".to_string()),
            relay_access_grant: Some("grant".to_string()),
        });

        assert_eq!(transport_for_config(&config), "direct-internet-tls-v1");
        assert_eq!(super::selected_connector_endpoint(&config), "https://baia.example.test");
    }

    #[test]
    fn connection_config_without_pairing_remains_backward_compatible() {
        let json = r#"{
          "schemaVersion": 1,
          "installationId": "550e8400-e29b-41d4-a716-446655440000",
          "serverBaseUrl": "http://127.0.0.1:3000"
        }"#;
        let config: super::ConnectionConfig = serde_json::from_str(json).unwrap();
        assert!(config.pairing.is_none());
        assert_eq!(config.connector_endpoint, default_connector_endpoint());
        assert!(config.connector_server_fingerprint.is_none());
    }

    #[test]
    fn phase4a4_connection_config_accepts_private_connector_endpoint() {
        let json = r#"{
          "schemaVersion": 1,
          "installationId": "550e8400-e29b-41d4-a716-446655440000",
          "serverBaseUrl": "http://127.0.0.1:3000",
          "connectorEndpoint": "https://192.168.1.50:43127",
          "connectorServerFingerprint": "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        }"#;
        let config: super::ConnectionConfig = serde_json::from_str(json).unwrap();
        let config = super::validate_loaded_config(config).unwrap();
        assert_eq!(config.server_base_url, "http://127.0.0.1:3000");
        assert_eq!(config.connector_endpoint, "https://192.168.1.50:43127");
    }

    #[test]
    fn legacy_pairing_profile_key_is_ignored_without_losing_the_device() {
        let json = r#"{
          "schemaVersion": 1,
          "installationId": "550e8400-e29b-41d4-a716-446655440000",
          "serverBaseUrl": "http://127.0.0.1:3000",
          "pairing": {
            "serverBaseUrl": "http://127.0.0.1:3000",
            "deviceId": "660e8400-e29b-41d4-a716-446655440000",
            "deviceName": "PC legacy",
            "profileKey": "default",
            "fingerprint": "SHA256:fixture",
            "pairedAt": "2026-08-05T12:00:00.000Z"
          }
        }"#;
        let config: super::ConnectionConfig = serde_json::from_str(json).unwrap();
        let config = super::validate_loaded_config(config).unwrap();
        let pairing = config.pairing.unwrap();
        assert_eq!(pairing.device_name, "PC legacy");
        assert_eq!(pairing.device_id, "660e8400-e29b-41d4-a716-446655440000");
    }
}
