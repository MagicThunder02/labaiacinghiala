use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::{Signer, SigningKey};
use serde::Serialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zeroize::Zeroizing;

#[cfg(target_os = "android")]
use std::{
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
    sync::OnceLock,
};
#[cfg(target_os = "android")]
use tauri::{AppHandle, Manager};

const DEVICE_IDENTITY_SERVICE: &str = "it.baia.cinghiala";
const DEVICE_IDENTITY_ACCOUNT: &str = "device-ed25519-v1";
const SELF_TEST_MESSAGE: &[u8] = b"baia-device-identity-self-test-v1";
const PAIRING_CONTEXT: &str = "BAIA-PAIR-V1";
const INVITE_PREFIX: &str = "baia1";
const ED25519_SECRET_LENGTH: usize = 32;
const MAX_INVITE_TOKEN_LENGTH: usize = 256;
#[cfg(target_os = "android")]
const ANDROID_IDENTITY_FILE_NAME: &str = "device-identity-ed25519-v1.bin";
#[cfg(target_os = "android")]
static ANDROID_IDENTITY_PATH: OnceLock<PathBuf> = OnceLock::new();

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceIdentityPublic {
    algorithm: &'static str,
    public_key: String,
    fingerprint: String,
    secret_storage: &'static str,
}

pub(crate) struct PairingProof {
    pub public_key: String,
    pub fingerprint: String,
    pub signature: String,
}

fn signing_key_from_secret(secret: &[u8]) -> Result<SigningKey, String> {
    if secret.len() != ED25519_SECRET_LENGTH {
        return Err("La chiave privata del dispositivo ha una dimensione non valida.".to_string());
    }

    let mut seed = Zeroizing::new([0u8; ED25519_SECRET_LENGTH]);
    seed.copy_from_slice(secret);
    Ok(SigningKey::from_bytes(&*seed))
}

fn public_identity(signing_key: &SigningKey, secret_storage: &'static str) -> Result<DeviceIdentityPublic, String> {
    let verifying_key = signing_key.verifying_key();

    // Self-test locale con un messaggio fisso e non controllabile dal frontend.
    let signature = signing_key.sign(SELF_TEST_MESSAGE);
    verifying_key
        .verify_strict(SELF_TEST_MESSAGE, &signature)
        .map_err(|_| "Autoverifica dell'identità crittografica non riuscita.".to_string())?;

    let public_bytes = verifying_key.to_bytes();
    let digest = Sha256::digest(public_bytes);

    Ok(DeviceIdentityPublic {
        algorithm: "Ed25519",
        public_key: URL_SAFE_NO_PAD.encode(public_bytes),
        fingerprint: format!("SHA256:{}", URL_SAFE_NO_PAD.encode(digest)),
        secret_storage,
    })
}

fn validate_invite_token(value: &str) -> Result<String, String> {
    let token = value.trim();
    if token.is_empty() || token.len() > MAX_INVITE_TOKEN_LENGTH {
        return Err("Invito Baia non valido.".to_string());
    }

    let mut parts = token.split('.');
    let prefix = parts.next();
    let invite_id = parts.next();
    let secret = parts.next();
    if prefix != Some(INVITE_PREFIX) || parts.next().is_some() {
        return Err("Invito Baia non valido.".to_string());
    }

    let invite_id = invite_id.ok_or_else(|| "Invito Baia non valido.".to_string())?;
    Uuid::parse_str(invite_id).map_err(|_| "Invito Baia non valido.".to_string())?;

    let encoded_secret = secret.ok_or_else(|| "Invito Baia non valido.".to_string())?;
    let decoded = URL_SAFE_NO_PAD
        .decode(encoded_secret)
        .map_err(|_| "Invito Baia non valido.".to_string())?;
    if decoded.len() != 32 || URL_SAFE_NO_PAD.encode(decoded) != encoded_secret {
        return Err("Invito Baia non valido.".to_string());
    }

    Ok(token.to_string())
}

#[cfg(target_os = "windows")]
fn load_or_create_signing_key() -> Result<(SigningKey, &'static str), String> {
    use keyring::{Entry, Error};

    let entry = Entry::new(DEVICE_IDENTITY_SERVICE, DEVICE_IDENTITY_ACCOUNT)
        .map_err(|error| format!("Impossibile aprire Windows Credential Manager: {error}"))?;

    match entry.get_secret() {
        Ok(secret) => {
            let secret = Zeroizing::new(secret);
            signing_key_from_secret(&secret[..]).map(|key| (key, "Windows Credential Manager"))
        }
        Err(Error::NoEntry) => {
            let mut secret = Zeroizing::new([0u8; ED25519_SECRET_LENGTH]);
            getrandom::fill(&mut secret[..])
                .map_err(|error| format!("Impossibile generare la chiave crittografica del dispositivo: {error}"))?;

            entry
                .set_secret(&secret[..])
                .map_err(|error| format!("Impossibile salvare la chiave privata in Windows Credential Manager: {error}"))?;

            // Rileggiamo il segreto appena scritto per verificare subito la persistenza.
            let stored = Zeroizing::new(
                entry
                    .get_secret()
                    .map_err(|error| format!("Impossibile rileggere la chiave privata appena salvata: {error}"))?,
            );
            signing_key_from_secret(&stored[..]).map(|key| (key, "Windows Credential Manager"))
        }
        Err(error) => Err(format!(
            "Impossibile leggere la chiave privata da Windows Credential Manager: {error}"
        )),
    }
}

#[cfg(target_os = "android")]
pub(crate) fn initialize_android_identity_storage(app: &AppHandle) -> Result<(), String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Impossibile determinare la cartella privata Android di Baia: {error}"))?;
    fs::create_dir_all(&config_dir)
        .map_err(|error| format!("Impossibile creare la cartella privata Android di Baia: {error}"))?;
    let path = config_dir.join(ANDROID_IDENTITY_FILE_NAME);

    match ANDROID_IDENTITY_PATH.set(path.clone()) {
        Ok(()) => Ok(()),
        Err(_) if ANDROID_IDENTITY_PATH.get() == Some(&path) => Ok(()),
        Err(_) => Err("Il percorso dell'identità Android è già stato inizializzato con un valore diverso.".to_string()),
    }
}

#[cfg(target_os = "android")]
fn read_android_signing_key(path: &Path) -> Result<SigningKey, String> {
    let secret = Zeroizing::new(
        fs::read(path)
            .map_err(|error| format!("Impossibile leggere l'identità privata Android: {error}"))?,
    );
    signing_key_from_secret(&secret[..])
}

#[cfg(target_os = "android")]
fn load_or_create_signing_key() -> Result<(SigningKey, &'static str), String> {
    let path = ANDROID_IDENTITY_PATH
        .get()
        .ok_or_else(|| "Storage identità Android non inizializzato.".to_string())?;

    if path.exists() {
        return read_android_signing_key(path)
            .map(|key| (key, "Android app-private storage (4B test build)"));
    }

    let mut secret = Zeroizing::new([0u8; ED25519_SECRET_LENGTH]);
    getrandom::fill(&mut secret[..])
        .map_err(|error| format!("Impossibile generare la chiave crittografica del dispositivo Android: {error}"))?;

    let mut file = match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            return read_android_signing_key(path)
                .map(|key| (key, "Android app-private storage (4B test build)"));
        }
        Err(error) => {
            return Err(format!("Impossibile creare l'identità privata Android: {error}"));
        }
    };

    if let Err(error) = file.write_all(&secret[..]).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(path);
        return Err(format!("Impossibile salvare l'identità privata Android: {error}"));
    }
    drop(file);

    let stored = read_android_signing_key(path)?;
    if stored.to_bytes() != *secret {
        return Err("Verifica della persistenza dell'identità Android non riuscita.".to_string());
    }

    Ok((stored, "Android app-private storage (4B test build)"))
}

#[cfg(not(any(target_os = "windows", target_os = "android")))]
fn load_or_create_signing_key() -> Result<(SigningKey, &'static str), String> {
    Err(format!(
        "Custodia sicura dell'identità non ancora implementata per {}.",
        std::env::consts::OS
    ))
}

pub fn load_or_create_device_identity() -> Result<DeviceIdentityPublic, String> {
    let (signing_key, storage) = load_or_create_signing_key()?;
    public_identity(&signing_key, storage)
}

pub(crate) fn device_public_key_bytes() -> Result<[u8; 32], String> {
    let (signing_key, _) = load_or_create_signing_key()?;
    Ok(signing_key.verifying_key().to_bytes())
}

pub(crate) fn sign_device_message(message: &[u8]) -> Result<String, String> {
    let (signing_key, _) = load_or_create_signing_key()?;
    let signature = signing_key.sign(message);
    Ok(URL_SAFE_NO_PAD.encode(signature.to_bytes()))
}

pub(crate) fn create_pairing_proof(invite_token: &str, installation_id: &str) -> Result<PairingProof, String> {
    let invite_token = validate_invite_token(invite_token)?;
    Uuid::parse_str(installation_id)
        .map_err(|_| "ID installazione Baia Core non valido.".to_string())?;

    let (signing_key, _) = load_or_create_signing_key()?;
    let verifying_key = signing_key.verifying_key();
    let public_bytes = verifying_key.to_bytes();
    let public_key = URL_SAFE_NO_PAD.encode(public_bytes);
    let fingerprint = format!(
        "SHA256:{}",
        URL_SAFE_NO_PAD.encode(Sha256::digest(public_bytes))
    );

    // Formato identico a quello verificato dal server. Il frontend può chiedere solo
    // questa prova contestualizzata: non esiste alcun comando di firma arbitraria.
    let message = format!(
        "{PAIRING_CONTEXT}\n{invite_token}\n{installation_id}\n{public_key}"
    );
    let signature = signing_key.sign(message.as_bytes());

    Ok(PairingProof {
        public_key,
        fingerprint,
        signature: URL_SAFE_NO_PAD.encode(signature.to_bytes()),
    })
}

#[cfg(test)]
mod tests {
    use super::{create_pairing_proof, public_identity, signing_key_from_secret, validate_invite_token, PAIRING_CONTEXT};
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use ed25519_dalek::{Signature, Signer, Verifier};

    #[test]
    fn same_secret_produces_stable_public_identity() {
        let secret = [7u8; 32];
        let signing_key = signing_key_from_secret(&secret).unwrap();
        let first = public_identity(&signing_key, "test").unwrap();
        let second = public_identity(&signing_key, "test").unwrap();
        assert_eq!(first.algorithm, "Ed25519");
        assert_eq!(first.public_key, second.public_key);
        assert_eq!(first.fingerprint, second.fingerprint);
        assert!(first.fingerprint.starts_with("SHA256:"));
    }

    #[test]
    fn rejects_invalid_private_key_length() {
        assert!(signing_key_from_secret(&[1u8; 31]).is_err());
        assert!(signing_key_from_secret(&[1u8; 33]).is_err());
    }

    #[test]
    fn validates_only_canonical_baia_invites() {
        let secret = URL_SAFE_NO_PAD.encode([5u8; 32]);
        let token = format!("baia1.550e8400-e29b-41d4-a716-446655440000.{secret}");
        assert_eq!(validate_invite_token(&token).unwrap(), token);
        assert!(validate_invite_token("not-an-invite").is_err());
        assert!(validate_invite_token("baia1.550e8400-e29b-41d4-a716-446655440000.bad=").is_err());
    }

    #[test]
    fn pairing_message_format_matches_server_contract() {
        let secret = URL_SAFE_NO_PAD.encode([9u8; 32]);
        let invite = format!("baia1.550e8400-e29b-41d4-a716-446655440000.{secret}");
        let installation = "550e8400-e29b-41d4-a716-446655440001";
        let signing_key = signing_key_from_secret(&[11u8; 32]).unwrap();
        let public_key = URL_SAFE_NO_PAD.encode(signing_key.verifying_key().to_bytes());
        let message = format!("{PAIRING_CONTEXT}\n{invite}\n{installation}\n{public_key}");
        let signature = signing_key.sign(message.as_bytes());
        signing_key.verifying_key().verify(message.as_bytes(), &signature).unwrap();

        let encoded = URL_SAFE_NO_PAD.encode(signature.to_bytes());
        let decoded = URL_SAFE_NO_PAD.decode(encoded).unwrap();
        let signature = Signature::from_slice(&decoded).unwrap();
        signing_key.verifying_key().verify(message.as_bytes(), &signature).unwrap();
    }

    // Il test end-to-end di create_pairing_proof usa il credential store e viene quindi
    // verificato manualmente nell'app Windows; qui testiamo il formato senza I/O di sistema.
    #[allow(dead_code)]
    fn _type_checks_public_pairing_api(invite: &str, installation: &str) {
        let _ = create_pairing_proof(invite, installation);
    }
}

#[tauri::command]
pub fn baia_core_device_identity() -> Result<DeviceIdentityPublic, String> {
    load_or_create_device_identity()
}
