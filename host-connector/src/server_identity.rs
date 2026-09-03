use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ring::{
    digest::{digest, SHA256},
    rand::SystemRandom,
    signature::{Ed25519KeyPair, KeyPair},
};
use std::{
    env,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};
use uuid::Uuid;
use zeroize::Zeroizing;

const SERVER_IDENTITY_FILENAME: &str = "server-identity-ed25519-v1.pk8";
const SERVER_IDENTITY_ALGORITHM: &str = "Ed25519";
const SERVER_DATA_DIR_ENV: &str = "BAIA_CONNECTOR_DATA_DIR";

pub struct ServerIdentity {
    private_key_pkcs8: Zeroizing<Vec<u8>>,
    public_key: [u8; 32],
    fingerprint: String,
}

impl ServerIdentity {
    pub fn algorithm(&self) -> &'static str {
        SERVER_IDENTITY_ALGORITHM
    }

    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }

    pub fn private_key_pkcs8(&self) -> &[u8] {
        self.private_key_pkcs8.as_slice()
    }

    pub fn public_key(&self) -> &[u8; 32] {
        &self.public_key
    }

    pub fn sign_message(&self, message: &[u8]) -> Result<[u8; 64], String> {
        let key_pair = Ed25519KeyPair::from_pkcs8(self.private_key_pkcs8.as_slice())
            .map_err(|_| "Identita server/Connector persistente non valida durante la firma.".to_string())?;
        key_pair
            .sign(message)
            .as_ref()
            .try_into()
            .map_err(|_| "Firma Ed25519 del Connector di lunghezza inattesa.".to_string())
    }

    pub fn subject_public_key_info_der(&self) -> Vec<u8> {
        // RFC 8410 SubjectPublicKeyInfo per Ed25519:
        // SEQUENCE { SEQUENCE { OID 1.3.101.112 }, BIT STRING <32-byte public key> }
        const ED25519_SPKI_PREFIX: &[u8] = &[
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        ];
        let mut spki = Vec::with_capacity(ED25519_SPKI_PREFIX.len() + self.public_key.len());
        spki.extend_from_slice(ED25519_SPKI_PREFIX);
        spki.extend_from_slice(&self.public_key);
        spki
    }
}

fn identity_from_pkcs8(bytes: Vec<u8>) -> Result<ServerIdentity, String> {
    let private_key_pkcs8 = Zeroizing::new(bytes);
    let key_pair = Ed25519KeyPair::from_pkcs8(private_key_pkcs8.as_slice())
        .map_err(|_| "Identita server/Connector persistente non valida.".to_string())?;
    let public_key_bytes = key_pair.public_key().as_ref();
    let public_key: [u8; 32] = public_key_bytes
        .try_into()
        .map_err(|_| "Chiave pubblica Ed25519 del Connector di lunghezza inattesa.".to_string())?;
    let fingerprint = format!(
        "SHA256:{}",
        URL_SAFE_NO_PAD.encode(digest(&SHA256, &public_key).as_ref())
    );

    Ok(ServerIdentity {
        private_key_pkcs8,
        public_key,
        fingerprint,
    })
}

fn create_identity_bytes() -> Result<Vec<u8>, String> {
    let rng = SystemRandom::new();
    Ed25519KeyPair::generate_pkcs8(&rng)
        .map(|document| document.as_ref().to_vec())
        .map_err(|_| "Impossibile generare l'identita server/Connector Ed25519.".to_string())
}

fn write_new_identity_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Percorso identita server non valido.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Impossibile creare la directory dell'identita server: {error}"))?;

    let temporary = parent.join(format!(".{SERVER_IDENTITY_FILENAME}.{}.tmp", Uuid::new_v4()));
    let write_result = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("Impossibile creare il file temporaneo dell'identita server: {error}"))?;
        file.write_all(bytes)
            .map_err(|error| format!("Impossibile scrivere l'identita server: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("Impossibile sincronizzare l'identita server: {error}"))?;
        Ok(())
    })();

    if let Err(error) = write_result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }

    match fs::rename(&temporary, path) {
        Ok(()) => Ok(()),
        Err(_error) if path.exists() => {
            let _ = fs::remove_file(&temporary);
            Ok(())
        }
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            Err(format!("Impossibile rendere persistente l'identita server: {error}"))
        }
    }
}

fn load_or_create_identity_at(path: &Path) -> Result<ServerIdentity, String> {
    if path.exists() {
        let bytes = fs::read(path)
            .map_err(|error| format!("Impossibile leggere l'identita server persistente: {error}"))?;
        return identity_from_pkcs8(bytes);
    }

    let generated = Zeroizing::new(create_identity_bytes()?);
    write_new_identity_atomically(path, generated.as_slice())?;

    let stored = fs::read(path)
        .map_err(|error| format!("Impossibile rileggere l'identita server appena salvata: {error}"))?;
    identity_from_pkcs8(stored)
}

fn identity_path_in_data_dir(data_dir: &Path) -> Result<PathBuf, String> {
    if !data_dir.is_absolute() {
        return Err(format!(
            "{SERVER_DATA_DIR_ENV} deve essere un percorso assoluto."
        ));
    }
    Ok(data_dir.join(SERVER_IDENTITY_FILENAME))
}

#[cfg(target_os = "windows")]
fn default_identity_path() -> Result<PathBuf, String> {
    let local_app_data = env::var_os("LOCALAPPDATA")
        .ok_or_else(|| "LOCALAPPDATA non disponibile per l'identita server/Connector.".to_string())?;
    Ok(PathBuf::from(local_app_data)
        .join("Baia")
        .join("HostConnector")
        .join(SERVER_IDENTITY_FILENAME))
}

#[cfg(not(target_os = "windows"))]
fn default_identity_path() -> Result<PathBuf, String> {
    Err(format!(
        "Persistenza dell'identita server/Connector non ancora abilitata per {}.",
        env::consts::OS
    ))
}

fn configured_identity_path() -> Result<PathBuf, String> {
    match env::var_os(SERVER_DATA_DIR_ENV) {
        Some(value) => identity_path_in_data_dir(&PathBuf::from(value)),
        None => default_identity_path(),
    }
}

pub fn load_or_create_server_identity() -> Result<ServerIdentity, String> {
    let path = configured_identity_path()?;
    load_or_create_identity_at(&path)
}

#[cfg(test)]
mod tests {
    use super::{identity_from_pkcs8, identity_path_in_data_dir, load_or_create_identity_at, SERVER_IDENTITY_FILENAME};
    use std::fs;
    use uuid::Uuid;

    fn test_identity_path(label: &str) -> std::path::PathBuf {
        std::env::temp_dir()
            .join(format!("baia-host-connector-{label}-{}", Uuid::new_v4()))
            .join("server-identity-ed25519-v1.pk8")
    }

    #[test]
    fn configured_data_dir_uses_fixed_identity_filename_and_requires_absolute_path() {
        let absolute = std::env::temp_dir().join("baia-host-connector-data-dir");
        assert_eq!(
            identity_path_in_data_dir(&absolute).unwrap(),
            absolute.join(SERVER_IDENTITY_FILENAME)
        );
        assert!(identity_path_in_data_dir(std::path::Path::new("relative-data")).is_err());
    }

    #[test]
    fn persisted_server_identity_is_stable() {
        let path = test_identity_path("stable");
        let first = load_or_create_identity_at(&path).unwrap();
        let first_bytes = fs::read(&path).unwrap();
        let second = load_or_create_identity_at(&path).unwrap();
        let second_bytes = fs::read(&path).unwrap();

        assert_eq!(first.algorithm(), "Ed25519");
        assert_eq!(first.fingerprint(), second.fingerprint());
        assert_eq!(first_bytes, second_bytes);
        assert!(first.fingerprint().starts_with("SHA256:"));
        let spki = first.subject_public_key_info_der();
        assert_eq!(spki.len(), 44);
        assert_eq!(&spki[..12], &[0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn independent_server_identity_files_are_distinct() {
        let first_path = test_identity_path("distinct-a");
        let second_path = test_identity_path("distinct-b");
        let first = load_or_create_identity_at(&first_path).unwrap();
        let second = load_or_create_identity_at(&second_path).unwrap();

        assert_ne!(first.fingerprint(), second.fingerprint());

        let _ = fs::remove_dir_all(first_path.parent().unwrap());
        let _ = fs::remove_dir_all(second_path.parent().unwrap());
    }

    #[test]
    fn corrupted_identity_is_rejected_without_replacement() {
        let path = test_identity_path("corrupt");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"not-a-valid-ed25519-pkcs8").unwrap();
        let before = fs::read(&path).unwrap();

        assert!(load_or_create_identity_at(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), before);

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn invalid_pkcs8_is_rejected() {
        assert!(identity_from_pkcs8(vec![1, 2, 3, 4]).is_err());
    }
}
