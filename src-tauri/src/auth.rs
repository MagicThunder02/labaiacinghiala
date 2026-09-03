use crate::{core::CoreState, identity};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::Serialize;
use std::{net::IpAddr, time::{SystemTime, UNIX_EPOCH}};
use tauri::State;
use url::{Host, Url};

const REQUEST_CONTEXT: &str = "BAIA-REQ-V1";
const MEDIA_CONTEXT: &str = "BAIA-MEDIA-V1";
const MEDIA_TTL_SECONDS: u64 = 8 * 60 * 60;
const NONCE_BYTES: usize = 16;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestAuthorization {
    pub(crate) device_id: String,
    pub(crate) timestamp: u64,
    pub(crate) nonce: String,
    pub(crate) signature: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaAuthorization {
    pub(crate) device_id: String,
    pub(crate) expires: u64,
    pub(crate) signature: String,
}

fn unix_seconds() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .map_err(|_| "Orologio di sistema non valido.".to_string())
}

fn normalize_method(value: &str) -> Result<String, String> {
    let method = value.trim().to_ascii_uppercase();
    if matches!(method.as_str(), "GET" | "HEAD" | "POST" | "PUT") {
        Ok(method)
    } else {
        Err("Metodo richiesta non autorizzabile.".to_string())
    }
}

fn pairing_for_current_server(state: &CoreState) -> Result<(String, crate::core::PairingRecord), String> {
    let (server_base_url, _, pairing) = state.pairing_context()?;
    let pairing = pairing.ok_or_else(|| "Questo client Baia non è ancora associato al server.".to_string())?;
    if pairing.server_base_url != server_base_url {
        return Err("Il pairing salvato appartiene a un altro endpoint server. Associa nuovamente questo dispositivo.".to_string());
    }
    Ok((server_base_url, pairing))
}

fn is_loopback_host(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(address)) => IpAddr::V4(address).is_loopback(),
        Some(Host::Ipv6(address)) => IpAddr::V6(address).is_loopback(),
        None => false,
    }
}

fn validate_api_url(base_url: &str, value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "URL API Baia non valido.".to_string())?;
    if url.origin().ascii_serialization() != base_url {
        return Err("Il Core può autorizzare soltanto richieste verso il server Baia configurato.".to_string());
    }
    if url.scheme() == "http" && !is_loopback_host(&url) {
        return Err("Per sicurezza l'autenticazione device via HTTP è consentita solo verso localhost. Per server remoti serviranno HTTPS o il trasporto privato Baia.".to_string());
    }
    if !url.path().starts_with("/api/") {
        return Err("Il Core può autorizzare soltanto endpoint API Baia.".to_string());
    }
    if url.fragment().is_some() {
        return Err("Un endpoint API non può contenere frammenti URL.".to_string());
    }
    Ok(url)
}

fn path_and_query(url: &Url) -> String {
    match url.query() {
        Some(query) => format!("{}?{}", url.path(), query),
        None => url.path().to_string(),
    }
}

fn request_message(device_id: &str, timestamp: u64, nonce: &str, method: &str, target: &str) -> String {
    format!("{REQUEST_CONTEXT}\n{device_id}\n{timestamp}\n{nonce}\n{method}\n{target}")
}

fn media_message(device_id: &str, expires: u64, path: &str) -> String {
    format!("{MEDIA_CONTEXT}\n{device_id}\n{expires}\nGET\n{path}")
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

fn is_media_path(path: &str) -> bool {
    let segments: Vec<_> = path.trim_matches('/').split('/').collect();
    match segments.as_slice() {
        ["api", "movies", id, "stream" | "poster"] => id.chars().all(|ch| ch.is_ascii_digit()),
        ["api", "series", series_id, "poster"] => !series_id.is_empty(),
        ["api", "metadata", "items", id, "automatic-poster"] => id.chars().all(|ch| ch.is_ascii_digit()),
        ["api", "reading", id, "file" | "cover"] => id.chars().all(|ch| ch.is_ascii_digit()),
        ["api", "reading", id, "reader", "entry", entry_id] => {
            id.chars().all(|ch| ch.is_ascii_digit())
                && entry_id.chars().all(|ch| ch.is_ascii_digit())
        }
        ["api", "music", "albums", album_id, "cover"] => is_uuid_path_segment(album_id),
        ["api", "music", "tracks", track_id, "stream"] => is_uuid_path_segment(track_id),
        _ => false,
    }
}

pub(crate) fn authorize_request(
    method: &str,
    url: &str,
    state: &CoreState,
) -> Result<RequestAuthorization, String> {
    let (base_url, pairing) = pairing_for_current_server(state)?;
    let url = validate_api_url(&base_url, url)?;
    let method = normalize_method(method)?;
    let target = path_and_query(&url);
    let timestamp = unix_seconds()?;

    let mut nonce_bytes = [0u8; NONCE_BYTES];
    getrandom::fill(&mut nonce_bytes)
        .map_err(|error| format!("Impossibile generare il nonce della richiesta: {error}"))?;
    let nonce = URL_SAFE_NO_PAD.encode(nonce_bytes);
    let message = request_message(&pairing.device_id, timestamp, &nonce, &method, &target);
    let signature = identity::sign_device_message(message.as_bytes())?;

    Ok(RequestAuthorization {
        device_id: pairing.device_id,
        timestamp,
        nonce,
        signature,
    })
}

#[tauri::command]
pub fn baia_core_authorize_request(
    method: String,
    url: String,
    state: State<'_, CoreState>,
) -> Result<RequestAuthorization, String> {
    authorize_request(&method, &url, &state)
}

pub(crate) fn authorize_media_path(
    path: &str,
    state: &CoreState,
) -> Result<MediaAuthorization, String> {
    let normalized = path.trim();
    if normalized.contains('?')
        || normalized.contains('#')
        || normalized.contains('\\')
        || normalized.starts_with("//")
        || !normalized.starts_with("/api/")
    {
        return Err("Percorso multimediale Baia non valido.".to_string());
    }
    if !is_media_path(normalized) {
        return Err("Questa risorsa non è autorizzabile come media Baia.".to_string());
    }

    let (_, pairing) = pairing_for_current_server(state)?;
    let expires = unix_seconds()?.saturating_add(MEDIA_TTL_SECONDS);
    let message = media_message(&pairing.device_id, expires, normalized);
    let signature = identity::sign_device_message(message.as_bytes())?;

    Ok(MediaAuthorization {
        device_id: pairing.device_id,
        expires,
        signature,
    })
}

#[tauri::command]
pub fn baia_core_authorize_media_url(
    url: String,
    state: State<'_, CoreState>,
) -> Result<String, String> {
    let (base_url, pairing) = pairing_for_current_server(&state)?;
    let mut url = validate_api_url(&base_url, &url)?;
    if !is_media_path(url.path()) {
        return Err("Questa risorsa non è autorizzabile come URL multimediale Baia.".to_string());
    }

    let expires = unix_seconds()?.saturating_add(MEDIA_TTL_SECONDS);
    let message = media_message(&pairing.device_id, expires, url.path());
    let signature = identity::sign_device_message(message.as_bytes())?;

    {
        let mut query = url.query_pairs_mut();
        query.append_pair("_baia_device", &pairing.device_id);
        query.append_pair("_baia_expires", &expires.to_string());
        query.append_pair("_baia_signature", &signature);
    }

    Ok(url.to_string())
}

#[cfg(test)]
mod tests {
    use super::{is_media_path, media_message, normalize_method, request_message};

    #[test]
    fn request_contract_is_stable() {
        assert_eq!(
            request_message("device", 123, "nonce", "GET", "/api/movies?limit=10"),
            "BAIA-REQ-V1\ndevice\n123\nnonce\nGET\n/api/movies?limit=10"
        );
        assert_eq!(normalize_method(" put ").unwrap(), "PUT");
        assert!(normalize_method("DELETE").is_err());
    }

    #[test]
    fn media_contract_accepts_only_media_endpoints() {
        assert!(is_media_path("/api/movies/12/stream"));
        assert!(is_media_path("/api/movies/12/poster"));
        assert!(is_media_path("/api/series/abc-123/poster"));
        assert!(is_media_path("/api/metadata/items/8/automatic-poster"));
        assert!(is_media_path("/api/reading/21/file"));
        assert!(is_media_path("/api/reading/21/cover"));
        assert!(is_media_path("/api/reading/21/reader/entry/0"));
        assert!(!is_media_path("/api/reading/21/reader/manifest"));
        assert!(!is_media_path("/api/reading/21/reader/entry/not-a-number"));
        assert!(is_media_path("/api/music/albums/223e4567-e89b-42d3-a456-426614174000/cover"));
        assert!(!is_media_path("/api/music/albums/not-a-uuid/cover"));
        assert!(!is_media_path("/api/music/albums/223e4567-e89b-42d3-a456-426614174000/file"));
        assert!(is_media_path("/api/music/tracks/123e4567-e89b-42d3-a456-426614174000/stream"));
        assert!(!is_media_path("/api/music/tracks/not-a-uuid/stream"));
        assert!(!is_media_path("/api/music/tracks/123e4567-e89b-42d3-a456-426614174000/file"));
        assert!(!is_media_path("/api/reading/21/bookmark"));
        assert!(!is_media_path("/api/movies/12/progress"));
        assert_eq!(
            media_message("device", 456, "/api/movies/12/stream"),
            "BAIA-MEDIA-V1\ndevice\n456\nGET\n/api/movies/12/stream"
        );
    }
}
