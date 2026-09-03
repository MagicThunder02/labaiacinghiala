use ring::{
    digest::{Context, SHA256},
    rand::{SecureRandom, SystemRandom},
    signature::{UnparsedPublicKey, ED25519},
};
use std::fmt;

use crate::{
    protocol::RELAY_PROTOCOL_VERSION,
    server_auth::{ServerId, SERVER_ID_BYTES, SERVER_PUBLIC_KEY_BYTES, SERVER_SIGNATURE_BYTES},
};

const RELAY_ACCESS_GRANT_DOMAIN: &[u8] = b"baia-relay-access-grant-v1\0";
const CLIENT_AUTH_DOMAIN: &[u8] = b"baia-relay-client-auth-v1\0";

pub const RELAY_ACCESS_GRANT_VERSION: u8 = 1;
pub const DEVICE_ID_BYTES: usize = 16;
pub const DEVICE_PUBLIC_KEY_BYTES: usize = 32;
pub const GRANT_ID_BYTES: usize = 16;
pub const CLIENT_CHALLENGE_BYTES: usize = 32;
pub const CLIENT_SIGNATURE_BYTES: usize = 64;
pub const RELAY_ACCESS_GRANT_UNSIGNED_BYTES: usize =
    1 + SERVER_ID_BYTES + DEVICE_ID_BYTES + DEVICE_PUBLIC_KEY_BYTES + GRANT_ID_BYTES + 8 + 2;
pub const RELAY_ACCESS_GRANT_BYTES: usize =
    RELAY_ACCESS_GRANT_UNSIGNED_BYTES + SERVER_SIGNATURE_BYTES;
pub const CLIENT_HELLO_PAYLOAD_BYTES: usize =
    SERVER_ID_BYTES + DEVICE_PUBLIC_KEY_BYTES + RELAY_ACCESS_GRANT_BYTES;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RelayAccessGrantFields {
    pub grant_version: u8,
    pub server_id: [u8; SERVER_ID_BYTES],
    pub device_id: [u8; DEVICE_ID_BYTES],
    pub device_public_key: [u8; DEVICE_PUBLIC_KEY_BYTES],
    pub grant_id: [u8; GRANT_ID_BYTES],
    pub issued_at: u64,
    pub protocol_version: u16,
}

impl RelayAccessGrantFields {
    pub fn new(
        server_id: ServerId,
        device_id: [u8; DEVICE_ID_BYTES],
        device_public_key: [u8; DEVICE_PUBLIC_KEY_BYTES],
        grant_id: [u8; GRANT_ID_BYTES],
        issued_at: u64,
    ) -> Self {
        Self {
            grant_version: RELAY_ACCESS_GRANT_VERSION,
            server_id: *server_id.as_bytes(),
            device_id,
            device_public_key,
            grant_id,
            issued_at,
            protocol_version: RELAY_PROTOCOL_VERSION as u16,
        }
    }

    pub fn encode(self) -> [u8; RELAY_ACCESS_GRANT_UNSIGNED_BYTES] {
        let mut payload = [0u8; RELAY_ACCESS_GRANT_UNSIGNED_BYTES];
        let mut offset = 0usize;

        payload[offset] = self.grant_version;
        offset += 1;

        payload[offset..offset + SERVER_ID_BYTES].copy_from_slice(&self.server_id);
        offset += SERVER_ID_BYTES;

        payload[offset..offset + DEVICE_ID_BYTES].copy_from_slice(&self.device_id);
        offset += DEVICE_ID_BYTES;

        payload[offset..offset + DEVICE_PUBLIC_KEY_BYTES]
            .copy_from_slice(&self.device_public_key);
        offset += DEVICE_PUBLIC_KEY_BYTES;

        payload[offset..offset + GRANT_ID_BYTES].copy_from_slice(&self.grant_id);
        offset += GRANT_ID_BYTES;

        payload[offset..offset + 8].copy_from_slice(&self.issued_at.to_be_bytes());
        offset += 8;

        payload[offset..offset + 2].copy_from_slice(&self.protocol_version.to_be_bytes());

        payload
    }

    pub fn decode(payload: &[u8]) -> Result<Self, ClientAuthError> {
        if payload.len() != RELAY_ACCESS_GRANT_UNSIGNED_BYTES {
            return Err(ClientAuthError::InvalidGrantFieldsLength {
                actual: payload.len(),
            });
        }

        let mut offset = 0usize;

        let grant_version = payload[offset];
        offset += 1;

        let mut server_id = [0u8; SERVER_ID_BYTES];
        server_id.copy_from_slice(&payload[offset..offset + SERVER_ID_BYTES]);
        offset += SERVER_ID_BYTES;

        let mut device_id = [0u8; DEVICE_ID_BYTES];
        device_id.copy_from_slice(&payload[offset..offset + DEVICE_ID_BYTES]);
        offset += DEVICE_ID_BYTES;

        let mut device_public_key = [0u8; DEVICE_PUBLIC_KEY_BYTES];
        device_public_key.copy_from_slice(&payload[offset..offset + DEVICE_PUBLIC_KEY_BYTES]);
        offset += DEVICE_PUBLIC_KEY_BYTES;

        let mut grant_id = [0u8; GRANT_ID_BYTES];
        grant_id.copy_from_slice(&payload[offset..offset + GRANT_ID_BYTES]);
        offset += GRANT_ID_BYTES;

        let issued_at = u64::from_be_bytes(
            payload[offset..offset + 8]
                .try_into()
                .expect("slice issued_at grant con lunghezza fissa"),
        );
        offset += 8;

        let protocol_version = u16::from_be_bytes(
            payload[offset..offset + 2]
                .try_into()
                .expect("slice protocol_version grant con lunghezza fissa"),
        );

        let fields = Self {
            grant_version,
            server_id,
            device_id,
            device_public_key,
            grant_id,
            issued_at,
            protocol_version,
        };
        fields.validate()?;
        Ok(fields)
    }

    pub fn validate(&self) -> Result<(), ClientAuthError> {
        if self.grant_version != RELAY_ACCESS_GRANT_VERSION {
            return Err(ClientAuthError::UnsupportedGrantVersion(
                self.grant_version,
            ));
        }
        if self.protocol_version != RELAY_PROTOCOL_VERSION as u16 {
            return Err(ClientAuthError::UnsupportedGrantProtocolVersion(
                self.protocol_version,
            ));
        }
        if self.issued_at == 0 {
            return Err(ClientAuthError::InvalidGrantIssuedAt);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RelayAccessGrant {
    pub fields: RelayAccessGrantFields,
    pub server_signature: [u8; SERVER_SIGNATURE_BYTES],
}

impl RelayAccessGrant {
    pub fn new(
        fields: RelayAccessGrantFields,
        server_signature: [u8; SERVER_SIGNATURE_BYTES],
    ) -> Result<Self, ClientAuthError> {
        fields.validate()?;
        Ok(Self {
            fields,
            server_signature,
        })
    }

    pub fn encode(self) -> [u8; RELAY_ACCESS_GRANT_BYTES] {
        let mut payload = [0u8; RELAY_ACCESS_GRANT_BYTES];
        payload[..RELAY_ACCESS_GRANT_UNSIGNED_BYTES].copy_from_slice(&self.fields.encode());
        payload[RELAY_ACCESS_GRANT_UNSIGNED_BYTES..].copy_from_slice(&self.server_signature);
        payload
    }

    pub fn decode(payload: &[u8]) -> Result<Self, ClientAuthError> {
        if payload.len() != RELAY_ACCESS_GRANT_BYTES {
            return Err(ClientAuthError::InvalidGrantLength {
                actual: payload.len(),
            });
        }

        let fields = RelayAccessGrantFields::decode(
            &payload[..RELAY_ACCESS_GRANT_UNSIGNED_BYTES],
        )?;
        let mut server_signature = [0u8; SERVER_SIGNATURE_BYTES];
        server_signature
            .copy_from_slice(&payload[RELAY_ACCESS_GRANT_UNSIGNED_BYTES..]);

        Self::new(fields, server_signature)
    }
}

pub fn build_relay_access_grant_message(
    fields: &RelayAccessGrantFields,
) -> Result<Vec<u8>, ClientAuthError> {
    fields.validate()?;

    let encoded = fields.encode();
    let mut message = Vec::with_capacity(RELAY_ACCESS_GRANT_DOMAIN.len() + encoded.len());
    message.extend_from_slice(RELAY_ACCESS_GRANT_DOMAIN);
    message.extend_from_slice(&encoded);
    Ok(message)
}

pub fn verify_relay_access_grant_signature(
    grant: &RelayAccessGrant,
    server_public_key: &[u8; SERVER_PUBLIC_KEY_BYTES],
) -> Result<(), ClientAuthError> {
    grant.fields.validate()?;

    let expected_server_id = ServerId::derive(server_public_key);
    if grant.fields.server_id != *expected_server_id.as_bytes() {
        return Err(ClientAuthError::GrantServerMismatch);
    }

    let message = build_relay_access_grant_message(&grant.fields)?;
    UnparsedPublicKey::new(&ED25519, server_public_key)
        .verify(&message, &grant.server_signature)
        .map_err(|_| ClientAuthError::InvalidGrantServerSignature)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClientHello {
    pub server_id: [u8; SERVER_ID_BYTES],
    pub device_public_key: [u8; DEVICE_PUBLIC_KEY_BYTES],
    pub grant: RelayAccessGrant,
}

impl ClientHello {
    pub fn new(grant: RelayAccessGrant) -> Result<Self, ClientAuthError> {
        let hello = Self {
            server_id: grant.fields.server_id,
            device_public_key: grant.fields.device_public_key,
            grant,
        };
        hello.validate_binding()?;
        Ok(hello)
    }

    pub fn encode(self) -> [u8; CLIENT_HELLO_PAYLOAD_BYTES] {
        let mut payload = [0u8; CLIENT_HELLO_PAYLOAD_BYTES];
        let mut offset = 0usize;

        payload[offset..offset + SERVER_ID_BYTES].copy_from_slice(&self.server_id);
        offset += SERVER_ID_BYTES;

        payload[offset..offset + DEVICE_PUBLIC_KEY_BYTES]
            .copy_from_slice(&self.device_public_key);
        offset += DEVICE_PUBLIC_KEY_BYTES;

        payload[offset..].copy_from_slice(&self.grant.encode());
        payload
    }

    pub fn decode(payload: &[u8]) -> Result<Self, ClientAuthError> {
        if payload.len() != CLIENT_HELLO_PAYLOAD_BYTES {
            return Err(ClientAuthError::InvalidClientHelloLength {
                actual: payload.len(),
            });
        }

        let mut offset = 0usize;

        let mut server_id = [0u8; SERVER_ID_BYTES];
        server_id.copy_from_slice(&payload[offset..offset + SERVER_ID_BYTES]);
        offset += SERVER_ID_BYTES;

        let mut device_public_key = [0u8; DEVICE_PUBLIC_KEY_BYTES];
        device_public_key.copy_from_slice(&payload[offset..offset + DEVICE_PUBLIC_KEY_BYTES]);
        offset += DEVICE_PUBLIC_KEY_BYTES;

        let grant = RelayAccessGrant::decode(&payload[offset..])?;

        let hello = Self {
            server_id,
            device_public_key,
            grant,
        };
        hello.validate_binding()?;
        Ok(hello)
    }

    pub fn validate_binding(&self) -> Result<(), ClientAuthError> {
        if self.server_id != self.grant.fields.server_id {
            return Err(ClientAuthError::ClientHelloServerMismatch);
        }
        if self.device_public_key != self.grant.fields.device_public_key {
            return Err(ClientAuthError::ClientHelloDeviceKeyMismatch);
        }
        Ok(())
    }
}

pub fn build_client_auth_message(
    hello: &ClientHello,
    challenge: &[u8; CLIENT_CHALLENGE_BYTES],
) -> Result<Vec<u8>, ClientAuthError> {
    hello.validate_binding()?;

    let encoded_grant = hello.grant.encode();
    let mut digest = Context::new(&SHA256);
    digest.update(&encoded_grant);
    let grant_hash = digest.finish();

    let mut message = Vec::with_capacity(
        CLIENT_AUTH_DOMAIN.len()
            + 1
            + SERVER_ID_BYTES
            + DEVICE_PUBLIC_KEY_BYTES
            + SHA256_OUTPUT_BYTES
            + CLIENT_CHALLENGE_BYTES,
    );
    message.extend_from_slice(CLIENT_AUTH_DOMAIN);
    message.push(RELAY_PROTOCOL_VERSION);
    message.extend_from_slice(&hello.server_id);
    message.extend_from_slice(&hello.device_public_key);
    message.extend_from_slice(grant_hash.as_ref());
    message.extend_from_slice(challenge);
    Ok(message)
}

pub fn verify_client_auth_signature(
    hello: &ClientHello,
    challenge: &[u8; CLIENT_CHALLENGE_BYTES],
    signature: &[u8],
) -> Result<(), ClientAuthError> {
    if signature.len() != CLIENT_SIGNATURE_BYTES {
        return Err(ClientAuthError::InvalidClientSignatureLength {
            actual: signature.len(),
        });
    }

    let message = build_client_auth_message(hello, challenge)?;
    UnparsedPublicKey::new(&ED25519, &hello.device_public_key)
        .verify(&message, signature)
        .map_err(|_| ClientAuthError::InvalidClientSignature)
}

pub fn generate_client_challenge() -> Result<[u8; CLIENT_CHALLENGE_BYTES], ClientAuthError> {
    let mut challenge = [0u8; CLIENT_CHALLENGE_BYTES];
    SystemRandom::new()
        .fill(&mut challenge)
        .map_err(|_| ClientAuthError::RandomGenerationFailed)?;
    Ok(challenge)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AuthenticatedClient {
    pub server_id: [u8; SERVER_ID_BYTES],
    pub device_id: [u8; DEVICE_ID_BYTES],
    pub device_public_key: [u8; DEVICE_PUBLIC_KEY_BYTES],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ClientAuthState {
    AwaitingHello,
    AwaitingProof {
        hello: ClientHello,
        challenge: [u8; CLIENT_CHALLENGE_BYTES],
    },
    Authenticated(AuthenticatedClient),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClientAuthSession {
    server_public_key: [u8; SERVER_PUBLIC_KEY_BYTES],
    state: ClientAuthState,
}

impl ClientAuthSession {
    pub fn new(server_public_key: [u8; SERVER_PUBLIC_KEY_BYTES]) -> Self {
        Self {
            server_public_key,
            state: ClientAuthState::AwaitingHello,
        }
    }

    pub fn accept_hello(
        &mut self,
        payload: &[u8],
    ) -> Result<[u8; CLIENT_CHALLENGE_BYTES], ClientAuthError> {
        if !matches!(self.state, ClientAuthState::AwaitingHello) {
            return Err(ClientAuthError::UnexpectedHandshakeState);
        }

        let hello = ClientHello::decode(payload)?;
        verify_relay_access_grant_signature(&hello.grant, &self.server_public_key)?;

        let challenge = generate_client_challenge()?;
        self.state = ClientAuthState::AwaitingProof { hello, challenge };
        Ok(challenge)
    }

    pub fn accept_auth(
        &mut self,
        signature: &[u8],
    ) -> Result<AuthenticatedClient, ClientAuthError> {
        let ClientAuthState::AwaitingProof { hello, challenge } = self.state else {
            return Err(ClientAuthError::UnexpectedHandshakeState);
        };

        verify_client_auth_signature(&hello, &challenge, signature)?;

        let authenticated = AuthenticatedClient {
            server_id: hello.server_id,
            device_id: hello.grant.fields.device_id,
            device_public_key: hello.device_public_key,
        };
        self.state = ClientAuthState::Authenticated(authenticated);
        Ok(authenticated)
    }

    pub fn authenticated_client(&self) -> Option<AuthenticatedClient> {
        match self.state {
            ClientAuthState::Authenticated(client) => Some(client),
            _ => None,
        }
    }
}

const SHA256_OUTPUT_BYTES: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientAuthError {
    InvalidGrantFieldsLength { actual: usize },
    InvalidGrantLength { actual: usize },
    UnsupportedGrantVersion(u8),
    UnsupportedGrantProtocolVersion(u16),
    InvalidGrantIssuedAt,
    GrantServerMismatch,
    InvalidGrantServerSignature,
    InvalidClientHelloLength { actual: usize },
    ClientHelloServerMismatch,
    ClientHelloDeviceKeyMismatch,
    InvalidClientSignatureLength { actual: usize },
    InvalidClientSignature,
    RandomGenerationFailed,
    UnexpectedHandshakeState,
}

impl fmt::Display for ClientAuthError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidGrantFieldsLength { actual } => write!(
                formatter,
                "Campi RelayAccessGrant non validi: {actual} byte, attesi {RELAY_ACCESS_GRANT_UNSIGNED_BYTES}."
            ),
            Self::InvalidGrantLength { actual } => write!(
                formatter,
                "RelayAccessGrant non valido: {actual} byte, attesi {RELAY_ACCESS_GRANT_BYTES}."
            ),
            Self::UnsupportedGrantVersion(version) => {
                write!(formatter, "Versione RelayAccessGrant non supportata: {version}.")
            }
            Self::UnsupportedGrantProtocolVersion(version) => write!(
                formatter,
                "Versione protocollo relay nel grant non supportata: {version}."
            ),
            Self::InvalidGrantIssuedAt => {
                write!(formatter, "Timestamp issued_at RelayAccessGrant non valido.")
            }
            Self::GrantServerMismatch => {
                write!(formatter, "RelayAccessGrant associato a un server diverso.")
            }
            Self::InvalidGrantServerSignature => {
                write!(formatter, "Firma server del RelayAccessGrant non valida.")
            }
            Self::InvalidClientHelloLength { actual } => write!(
                formatter,
                "CLIENT_HELLO relay non valido: {actual} byte, attesi {CLIENT_HELLO_PAYLOAD_BYTES}."
            ),
            Self::ClientHelloServerMismatch => {
                write!(formatter, "CLIENT_HELLO e RelayAccessGrant indicano server diversi.")
            }
            Self::ClientHelloDeviceKeyMismatch => write!(
                formatter,
                "CLIENT_HELLO e RelayAccessGrant indicano chiavi dispositivo diverse."
            ),
            Self::InvalidClientSignatureLength { actual } => write!(
                formatter,
                "Firma CLIENT_AUTH non valida: {actual} byte, attesi {CLIENT_SIGNATURE_BYTES}."
            ),
            Self::InvalidClientSignature => {
                write!(formatter, "Firma CLIENT_AUTH Ed25519 non valida.")
            }
            Self::RandomGenerationFailed => {
                write!(formatter, "Impossibile generare la challenge casuale client del relay.")
            }
            Self::UnexpectedHandshakeState => {
                write!(formatter, "Sequenza handshake CLIENT_AUTH relay non valida.")
            }
        }
    }
}

impl std::error::Error for ClientAuthError {}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::{
        rand::SystemRandom,
        signature::{Ed25519KeyPair, KeyPair},
    };

    fn signed_grant_fixture() -> (
        RelayAccessGrant,
        [u8; SERVER_PUBLIC_KEY_BYTES],
        Ed25519KeyPair,
    ) {
        let rng = SystemRandom::new();
        let server_pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let server_key_pair = Ed25519KeyPair::from_pkcs8(server_pkcs8.as_ref()).unwrap();
        let server_public_key: [u8; SERVER_PUBLIC_KEY_BYTES] =
            server_key_pair.public_key().as_ref().try_into().unwrap();

        let device_pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let device_key_pair = Ed25519KeyPair::from_pkcs8(device_pkcs8.as_ref()).unwrap();
        let device_public_key: [u8; DEVICE_PUBLIC_KEY_BYTES] =
            device_key_pair.public_key().as_ref().try_into().unwrap();

        let fields = RelayAccessGrantFields::new(
            ServerId::derive(&server_public_key),
            [0x11u8; DEVICE_ID_BYTES],
            device_public_key,
            [0x22u8; GRANT_ID_BYTES],
            1_700_000_000,
        );
        let message = build_relay_access_grant_message(&fields).unwrap();
        let signature = server_key_pair.sign(&message);
        let server_signature: [u8; SERVER_SIGNATURE_BYTES] =
            signature.as_ref().try_into().unwrap();

        (
            RelayAccessGrant::new(fields, server_signature).unwrap(),
            server_public_key,
            device_key_pair,
        )
    }

    #[test]
    fn relay_access_grant_round_trip_preserves_fields_and_signature() {
        let (grant, _, _) = signed_grant_fixture();

        let decoded = RelayAccessGrant::decode(&grant.encode()).unwrap();

        assert_eq!(decoded, grant);
    }

    #[test]
    fn relay_access_grant_rejects_wrong_length() {
        let payload = [0u8; RELAY_ACCESS_GRANT_BYTES - 1];

        assert_eq!(
            RelayAccessGrant::decode(&payload),
            Err(ClientAuthError::InvalidGrantLength {
                actual: RELAY_ACCESS_GRANT_BYTES - 1,
            })
        );
    }

    #[test]
    fn relay_access_grant_rejects_zero_issued_at() {
        let (grant, _, _) = signed_grant_fixture();
        let mut fields = grant.fields;
        fields.issued_at = 0;

        assert_eq!(
            RelayAccessGrant::new(fields, grant.server_signature),
            Err(ClientAuthError::InvalidGrantIssuedAt)
        );
    }

    #[test]
    fn relay_access_grant_signature_accepts_authorized_server() {
        let (grant, server_public_key, _) = signed_grant_fixture();

        assert!(verify_relay_access_grant_signature(&grant, &server_public_key).is_ok());
    }

    #[test]
    fn relay_access_grant_signature_rejects_wrong_server() {
        let (grant, _, _) = signed_grant_fixture();

        let rng = SystemRandom::new();
        let other_pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let other_key_pair = Ed25519KeyPair::from_pkcs8(other_pkcs8.as_ref()).unwrap();
        let other_public_key: [u8; SERVER_PUBLIC_KEY_BYTES] =
            other_key_pair.public_key().as_ref().try_into().unwrap();

        assert_eq!(
            verify_relay_access_grant_signature(&grant, &other_public_key),
            Err(ClientAuthError::GrantServerMismatch)
        );
    }

    #[test]
    fn relay_access_grant_signature_rejects_tampered_fields() {
        let (grant, server_public_key, _) = signed_grant_fixture();
        let mut tampered = grant;
        tampered.fields.device_id[0] ^= 0x01;

        assert_eq!(
            verify_relay_access_grant_signature(&tampered, &server_public_key),
            Err(ClientAuthError::InvalidGrantServerSignature)
        );
    }

    #[test]
    fn client_hello_round_trip_preserves_grant_binding() {
        let (grant, _, _) = signed_grant_fixture();
        let hello = ClientHello::new(grant).unwrap();

        let decoded = ClientHello::decode(&hello.encode()).unwrap();

        assert_eq!(decoded, hello);
    }

    #[test]
    fn client_hello_rejects_server_id_mismatch() {
        let (grant, _, _) = signed_grant_fixture();
        let mut hello = ClientHello::new(grant).unwrap();
        hello.server_id[0] ^= 0x80;

        assert_eq!(
            hello.validate_binding(),
            Err(ClientAuthError::ClientHelloServerMismatch)
        );
    }

    #[test]
    fn client_hello_rejects_device_key_mismatch() {
        let (grant, _, _) = signed_grant_fixture();
        let mut hello = ClientHello::new(grant).unwrap();
        hello.device_public_key[0] ^= 0x80;

        assert_eq!(
            hello.validate_binding(),
            Err(ClientAuthError::ClientHelloDeviceKeyMismatch)
        );
    }

    #[test]
    fn client_auth_message_has_canonical_layout_and_changes_with_challenge() {
        let (grant, _, _) = signed_grant_fixture();
        let hello = ClientHello::new(grant).unwrap();
        let challenge_a = [0x33u8; CLIENT_CHALLENGE_BYTES];
        let challenge_b = [0x34u8; CLIENT_CHALLENGE_BYTES];

        let message_a = build_client_auth_message(&hello, &challenge_a).unwrap();
        let message_b = build_client_auth_message(&hello, &challenge_b).unwrap();

        assert_ne!(message_a, message_b);
        assert!(message_a.starts_with(CLIENT_AUTH_DOMAIN));
        assert_eq!(
            message_a.len(),
            CLIENT_AUTH_DOMAIN.len()
                + 1
                + SERVER_ID_BYTES
                + DEVICE_PUBLIC_KEY_BYTES
                + SHA256_OUTPUT_BYTES
                + CLIENT_CHALLENGE_BYTES
        );
    }
    #[test]
    fn client_auth_verification_accepts_valid_device_signature() {
        let (grant, _, device_key_pair) = signed_grant_fixture();
        let hello = ClientHello::new(grant).unwrap();
        let challenge = [0x41u8; CLIENT_CHALLENGE_BYTES];
        let message = build_client_auth_message(&hello, &challenge).unwrap();
        let signature = device_key_pair.sign(&message);

        assert!(verify_client_auth_signature(
            &hello,
            &challenge,
            signature.as_ref()
        )
        .is_ok());
    }

    #[test]
    fn client_auth_verification_rejects_tampered_challenge() {
        let (grant, _, device_key_pair) = signed_grant_fixture();
        let hello = ClientHello::new(grant).unwrap();
        let challenge = [0x42u8; CLIENT_CHALLENGE_BYTES];
        let message = build_client_auth_message(&hello, &challenge).unwrap();
        let signature = device_key_pair.sign(&message);

        let mut tampered_challenge = challenge;
        tampered_challenge[0] ^= 0x01;

        assert_eq!(
            verify_client_auth_signature(
                &hello,
                &tampered_challenge,
                signature.as_ref()
            ),
            Err(ClientAuthError::InvalidClientSignature)
        );
    }

    #[test]
    fn client_auth_verification_rejects_wrong_signature_length() {
        let (grant, _, _) = signed_grant_fixture();
        let hello = ClientHello::new(grant).unwrap();
        let challenge = [0x43u8; CLIENT_CHALLENGE_BYTES];
        let signature = [0u8; CLIENT_SIGNATURE_BYTES - 1];

        assert_eq!(
            verify_client_auth_signature(&hello, &challenge, &signature),
            Err(ClientAuthError::InvalidClientSignatureLength {
                actual: CLIENT_SIGNATURE_BYTES - 1,
            })
        );
    }

    #[test]
    fn client_auth_session_authenticates_valid_client() {
        let (grant, server_public_key, device_key_pair) = signed_grant_fixture();
        let hello = ClientHello::new(grant).unwrap();
        let mut session = ClientAuthSession::new(server_public_key);

        let challenge = session.accept_hello(&hello.encode()).unwrap();
        let message = build_client_auth_message(&hello, &challenge).unwrap();
        let signature = device_key_pair.sign(&message);

        let authenticated = session.accept_auth(signature.as_ref()).unwrap();

        assert_eq!(authenticated.server_id, hello.server_id);
        assert_eq!(authenticated.device_id, hello.grant.fields.device_id);
        assert_eq!(authenticated.device_public_key, hello.device_public_key);
        assert_eq!(session.authenticated_client(), Some(authenticated));
    }

    #[test]
    fn client_auth_session_rejects_grant_for_different_server() {
        let (grant, _, _) = signed_grant_fixture();
        let hello = ClientHello::new(grant).unwrap();

        let rng = SystemRandom::new();
        let other_pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let other_key_pair = Ed25519KeyPair::from_pkcs8(other_pkcs8.as_ref()).unwrap();
        let other_server_public_key: [u8; SERVER_PUBLIC_KEY_BYTES] =
            other_key_pair.public_key().as_ref().try_into().unwrap();

        let mut session = ClientAuthSession::new(other_server_public_key);

        assert_eq!(
            session.accept_hello(&hello.encode()),
            Err(ClientAuthError::GrantServerMismatch)
        );
        assert_eq!(session.authenticated_client(), None);
    }

    #[test]
    fn client_auth_session_rejects_auth_before_hello() {
        let (_, server_public_key, _) = signed_grant_fixture();
        let mut session = ClientAuthSession::new(server_public_key);
        let signature = [0u8; CLIENT_SIGNATURE_BYTES];

        assert_eq!(
            session.accept_auth(&signature),
            Err(ClientAuthError::UnexpectedHandshakeState)
        );
        assert_eq!(session.authenticated_client(), None);
    }

    #[test]
    fn client_auth_session_does_not_authenticate_invalid_device_signature() {
        let (grant, server_public_key, _) = signed_grant_fixture();
        let hello = ClientHello::new(grant).unwrap();
        let mut session = ClientAuthSession::new(server_public_key);

        session.accept_hello(&hello.encode()).unwrap();
        let signature = [0u8; CLIENT_SIGNATURE_BYTES];

        assert_eq!(
            session.accept_auth(&signature),
            Err(ClientAuthError::InvalidClientSignature)
        );
        assert_eq!(session.authenticated_client(), None);
    }

}
