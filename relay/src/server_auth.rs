use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ring::{
    digest::{Context, SHA256},
    rand::{SecureRandom, SystemRandom},
    signature::{UnparsedPublicKey, ED25519},
};
use std::fmt;

use crate::protocol::RELAY_PROTOCOL_VERSION;

const SERVER_ID_DOMAIN: &[u8] = b"baia-server-id-v1\0";
const SERVER_AUTH_DOMAIN: &[u8] = b"baia-relay-server-auth-v1\0";

pub const SERVER_ID_BYTES: usize = 32;
pub const SERVER_PUBLIC_KEY_BYTES: usize = 32;
pub const SERVER_CHALLENGE_BYTES: usize = 32;
pub const SERVER_SIGNATURE_BYTES: usize = 64;
pub const SERVER_HELLO_PAYLOAD_BYTES: usize = SERVER_ID_BYTES + SERVER_PUBLIC_KEY_BYTES;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ServerId([u8; SERVER_ID_BYTES]);

impl ServerId {
    pub fn derive(public_key: &[u8; SERVER_PUBLIC_KEY_BYTES]) -> Self {
        let mut context = Context::new(&SHA256);
        context.update(SERVER_ID_DOMAIN);
        context.update(public_key);
        let digest = context.finish();

        let mut bytes = [0u8; SERVER_ID_BYTES];
        bytes.copy_from_slice(digest.as_ref());
        Self(bytes)
    }

    pub fn as_bytes(&self) -> &[u8; SERVER_ID_BYTES] {
        &self.0
    }

    pub fn from_bytes(bytes: [u8; SERVER_ID_BYTES]) -> Self {
        Self(bytes)
    }

    pub fn to_text(self) -> String {
        format!("srv1_{}", URL_SAFE_NO_PAD.encode(self.0))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ServerHello {
    server_id: ServerId,
    public_key: [u8; SERVER_PUBLIC_KEY_BYTES],
}

impl ServerHello {
    pub fn new(public_key: [u8; SERVER_PUBLIC_KEY_BYTES]) -> Self {
        Self {
            server_id: ServerId::derive(&public_key),
            public_key,
        }
    }

    pub fn server_id(&self) -> ServerId {
        self.server_id
    }

    pub fn public_key(&self) -> &[u8; SERVER_PUBLIC_KEY_BYTES] {
        &self.public_key
    }

    pub fn encode(self) -> [u8; SERVER_HELLO_PAYLOAD_BYTES] {
        let mut payload = [0u8; SERVER_HELLO_PAYLOAD_BYTES];
        payload[..SERVER_ID_BYTES].copy_from_slice(self.server_id.as_bytes());
        payload[SERVER_ID_BYTES..].copy_from_slice(&self.public_key);
        payload
    }

    pub fn decode(payload: &[u8]) -> Result<Self, ServerAuthError> {
        if payload.len() != SERVER_HELLO_PAYLOAD_BYTES {
            return Err(ServerAuthError::InvalidServerHelloLength {
                actual: payload.len(),
            });
        }

        let mut server_id_bytes = [0u8; SERVER_ID_BYTES];
        server_id_bytes.copy_from_slice(&payload[..SERVER_ID_BYTES]);

        let mut public_key = [0u8; SERVER_PUBLIC_KEY_BYTES];
        public_key.copy_from_slice(&payload[SERVER_ID_BYTES..]);

        let hello = Self {
            server_id: ServerId(server_id_bytes),
            public_key,
        };
        hello.validate()?;
        Ok(hello)
    }

    pub fn validate(&self) -> Result<(), ServerAuthError> {
        let expected = ServerId::derive(&self.public_key);
        if self.server_id != expected {
            return Err(ServerAuthError::ServerIdMismatch);
        }
        Ok(())
    }
}

pub fn generate_server_challenge() -> Result<[u8; SERVER_CHALLENGE_BYTES], ServerAuthError> {
    let mut challenge = [0u8; SERVER_CHALLENGE_BYTES];
    SystemRandom::new()
        .fill(&mut challenge)
        .map_err(|_| ServerAuthError::RandomGenerationFailed)?;
    Ok(challenge)
}

pub fn build_server_auth_message(
    hello: &ServerHello,
    challenge: &[u8; SERVER_CHALLENGE_BYTES],
) -> Result<Vec<u8>, ServerAuthError> {
    hello.validate()?;

    let mut message = Vec::with_capacity(
        SERVER_AUTH_DOMAIN.len()
            + 1
            + SERVER_ID_BYTES
            + SERVER_PUBLIC_KEY_BYTES
            + SERVER_CHALLENGE_BYTES,
    );
    message.extend_from_slice(SERVER_AUTH_DOMAIN);
    message.push(RELAY_PROTOCOL_VERSION);
    message.extend_from_slice(hello.server_id.as_bytes());
    message.extend_from_slice(&hello.public_key);
    message.extend_from_slice(challenge);
    Ok(message)
}

pub fn verify_server_auth_signature(
    hello: &ServerHello,
    challenge: &[u8; SERVER_CHALLENGE_BYTES],
    signature: &[u8],
) -> Result<(), ServerAuthError> {
    if signature.len() != SERVER_SIGNATURE_BYTES {
        return Err(ServerAuthError::InvalidServerSignatureLength {
            actual: signature.len(),
        });
    }

    let message = build_server_auth_message(hello, challenge)?;
    UnparsedPublicKey::new(&ED25519, hello.public_key())
        .verify(&message, signature)
        .map_err(|_| ServerAuthError::InvalidServerSignature)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ServerAuthState {
    AwaitingHello,
    AwaitingProof {
        hello: ServerHello,
        challenge: [u8; SERVER_CHALLENGE_BYTES],
    },
    Authenticated(AuthenticatedServer),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AuthenticatedServer {
    pub server_id: ServerId,
    pub public_key: [u8; SERVER_PUBLIC_KEY_BYTES],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ServerAuthSession {
    state: ServerAuthState,
}

impl ServerAuthSession {
    pub fn new() -> Self {
        Self {
            state: ServerAuthState::AwaitingHello,
        }
    }

    pub fn accept_hello(
        &mut self,
        payload: &[u8],
    ) -> Result<[u8; SERVER_CHALLENGE_BYTES], ServerAuthError> {
        if !matches!(self.state, ServerAuthState::AwaitingHello) {
            return Err(ServerAuthError::UnexpectedHandshakeState);
        }

        let hello = ServerHello::decode(payload)?;
        let challenge = generate_server_challenge()?;
        self.state = ServerAuthState::AwaitingProof { hello, challenge };
        Ok(challenge)
    }

    pub fn accept_auth(&mut self, signature: &[u8]) -> Result<ServerId, ServerAuthError> {
        let ServerAuthState::AwaitingProof { hello, challenge } = self.state else {
            return Err(ServerAuthError::UnexpectedHandshakeState);
        };

        verify_server_auth_signature(&hello, &challenge, signature)?;
        let authenticated = AuthenticatedServer {
            server_id: hello.server_id(),
            public_key: *hello.public_key(),
        };
        self.state = ServerAuthState::Authenticated(authenticated);
        Ok(authenticated.server_id)
    }

    pub fn authenticated_server(&self) -> Option<AuthenticatedServer> {
        match self.state {
            ServerAuthState::Authenticated(server) => Some(server),
            _ => None,
        }
    }

    pub fn authenticated_server_id(&self) -> Option<ServerId> {
        self.authenticated_server().map(|server| server.server_id)
    }
}

impl Default for ServerAuthSession {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServerAuthError {
    InvalidServerHelloLength { actual: usize },
    ServerIdMismatch,
    RandomGenerationFailed,
    InvalidServerSignatureLength { actual: usize },
    InvalidServerSignature,
    UnexpectedHandshakeState,
}

impl fmt::Display for ServerAuthError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidServerHelloLength { actual } => write!(
                formatter,
                "SERVER_HELLO relay non valido: {actual} byte, attesi {SERVER_HELLO_PAYLOAD_BYTES}."
            ),
            Self::ServerIdMismatch => write!(
                formatter,
                "SERVER_HELLO relay non valido: server_id non corrisponde alla chiave pubblica."
            ),
            Self::RandomGenerationFailed => {
                write!(formatter, "Impossibile generare la challenge casuale del relay.")
            }
            Self::InvalidServerSignatureLength { actual } => write!(
                formatter,
                "Firma SERVER_AUTH non valida: {actual} byte, attesi {SERVER_SIGNATURE_BYTES}."
            ),
            Self::InvalidServerSignature => {
                write!(formatter, "Firma SERVER_AUTH Ed25519 non valida.")
            }
            Self::UnexpectedHandshakeState => {
                write!(formatter, "Sequenza handshake SERVER_AUTH relay non valida.")
            }
        }
    }
}

impl std::error::Error for ServerAuthError {}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{Ed25519KeyPair, KeyPair};

    #[test]
    fn server_id_from_bytes_preserves_wire_value() {
        let bytes = [0x5au8; SERVER_ID_BYTES];

        let server_id = ServerId::from_bytes(bytes);

        assert_eq!(server_id.as_bytes(), &bytes);
    }

    #[test]
    fn server_id_derivation_matches_known_vector() {
        let public_key = [0u8; SERVER_PUBLIC_KEY_BYTES];
        let server_id = ServerId::derive(&public_key);

        assert_eq!(
            server_id.as_bytes(),
            &[
                0xb0, 0x47, 0x8c, 0xd1, 0x07, 0x27, 0xf3, 0xfe,
                0xcf, 0x40, 0x9b, 0x1a, 0xbd, 0xd1, 0xeb, 0xe4,
                0x2d, 0x44, 0x27, 0x8a, 0x69, 0x2b, 0x58, 0x9a,
                0xbf, 0x38, 0xec, 0xd2, 0xcb, 0x58, 0x6b, 0xf6,
            ]
        );
        assert_eq!(
            server_id.to_text(),
            "srv1_sEeM0Qcn8_7PQJsavdHr5C1EJ4ppK1iavzjs0stYa_Y"
        );
    }

    #[test]
    fn server_hello_round_trip_preserves_binding() {
        let public_key = [0x5au8; SERVER_PUBLIC_KEY_BYTES];
        let hello = ServerHello::new(public_key);

        let decoded = ServerHello::decode(&hello.encode()).unwrap();

        assert_eq!(decoded, hello);
        assert_eq!(decoded.server_id(), ServerId::derive(&public_key));
    }

    #[test]
    fn server_hello_rejects_wrong_payload_length() {
        let payload = [0u8; SERVER_HELLO_PAYLOAD_BYTES - 1];

        assert_eq!(
            ServerHello::decode(&payload),
            Err(ServerAuthError::InvalidServerHelloLength {
                actual: SERVER_HELLO_PAYLOAD_BYTES - 1,
            })
        );
    }

    #[test]
    fn server_hello_rejects_tampered_server_id() {
        let hello = ServerHello::new([0x11u8; SERVER_PUBLIC_KEY_BYTES]);
        let mut payload = hello.encode();
        payload[0] ^= 0x80;

        assert_eq!(
            ServerHello::decode(&payload),
            Err(ServerAuthError::ServerIdMismatch)
        );
    }

    #[test]
    fn server_auth_message_has_canonical_layout() {
        let public_key = [0x22u8; SERVER_PUBLIC_KEY_BYTES];
        let hello = ServerHello::new(public_key);
        let challenge = [0x33u8; SERVER_CHALLENGE_BYTES];

        let message = build_server_auth_message(&hello, &challenge).unwrap();

        let mut offset = 0usize;
        assert_eq!(
            &message[offset..offset + SERVER_AUTH_DOMAIN.len()],
            SERVER_AUTH_DOMAIN
        );
        offset += SERVER_AUTH_DOMAIN.len();

        assert_eq!(message[offset], RELAY_PROTOCOL_VERSION);
        offset += 1;

        assert_eq!(
            &message[offset..offset + SERVER_ID_BYTES],
            hello.server_id().as_bytes()
        );
        offset += SERVER_ID_BYTES;

        assert_eq!(
            &message[offset..offset + SERVER_PUBLIC_KEY_BYTES],
            &public_key
        );
        offset += SERVER_PUBLIC_KEY_BYTES;

        assert_eq!(
            &message[offset..offset + SERVER_CHALLENGE_BYTES],
            &challenge
        );
        offset += SERVER_CHALLENGE_BYTES;

        assert_eq!(offset, message.len());
    }

    #[test]
    fn server_auth_message_rejects_unbound_server_id() {
        let public_key = [0x44u8; SERVER_PUBLIC_KEY_BYTES];
        let hello = ServerHello {
            server_id: ServerId([0x55u8; SERVER_ID_BYTES]),
            public_key,
        };
        let challenge = [0x66u8; SERVER_CHALLENGE_BYTES];

        assert_eq!(
            build_server_auth_message(&hello, &challenge),
            Err(ServerAuthError::ServerIdMismatch)
        );
    }
    #[test]
    fn server_auth_verification_accepts_valid_signature() {
        let rng = SystemRandom::new();
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let key_pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();

        let public_key: [u8; SERVER_PUBLIC_KEY_BYTES] =
            key_pair.public_key().as_ref().try_into().unwrap();
        let hello = ServerHello::new(public_key);
        let challenge = [0x77u8; SERVER_CHALLENGE_BYTES];
        let message = build_server_auth_message(&hello, &challenge).unwrap();
        let signature = key_pair.sign(&message);

        assert!(verify_server_auth_signature(
            &hello,
            &challenge,
            signature.as_ref()
        )
        .is_ok());
    }

    #[test]
    fn server_auth_verification_rejects_tampered_challenge() {
        let rng = SystemRandom::new();
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let key_pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();

        let public_key: [u8; SERVER_PUBLIC_KEY_BYTES] =
            key_pair.public_key().as_ref().try_into().unwrap();
        let hello = ServerHello::new(public_key);
        let challenge = [0x88u8; SERVER_CHALLENGE_BYTES];
        let message = build_server_auth_message(&hello, &challenge).unwrap();
        let signature = key_pair.sign(&message);

        let mut tampered_challenge = challenge;
        tampered_challenge[0] ^= 0x01;

        assert_eq!(
            verify_server_auth_signature(
                &hello,
                &tampered_challenge,
                signature.as_ref()
            ),
            Err(ServerAuthError::InvalidServerSignature)
        );
    }

    #[test]
    fn server_auth_verification_rejects_wrong_signature_length() {
        let hello = ServerHello::new([0x99u8; SERVER_PUBLIC_KEY_BYTES]);
        let challenge = [0xaau8; SERVER_CHALLENGE_BYTES];
        let signature = [0u8; SERVER_SIGNATURE_BYTES - 1];

        assert_eq!(
            verify_server_auth_signature(&hello, &challenge, &signature),
            Err(ServerAuthError::InvalidServerSignatureLength {
                actual: SERVER_SIGNATURE_BYTES - 1,
            })
        );
    }

    #[test]
    fn server_auth_session_authenticates_valid_server() {
        let rng = SystemRandom::new();
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let key_pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();

        let public_key: [u8; SERVER_PUBLIC_KEY_BYTES] =
            key_pair.public_key().as_ref().try_into().unwrap();
        let hello = ServerHello::new(public_key);

        let mut session = ServerAuthSession::new();
        let challenge = session.accept_hello(&hello.encode()).unwrap();
        let message = build_server_auth_message(&hello, &challenge).unwrap();
        let signature = key_pair.sign(&message);

        let server_id = session.accept_auth(signature.as_ref()).unwrap();

        assert_eq!(server_id, hello.server_id());
        assert_eq!(session.authenticated_server_id(), Some(hello.server_id()));
        assert_eq!(
            session.authenticated_server(),
            Some(AuthenticatedServer {
                server_id: hello.server_id(),
                public_key,
            })
        );
    }

    #[test]
    fn server_auth_session_rejects_auth_before_hello() {
        let mut session = ServerAuthSession::new();
        let signature = [0u8; SERVER_SIGNATURE_BYTES];

        assert_eq!(
            session.accept_auth(&signature),
            Err(ServerAuthError::UnexpectedHandshakeState)
        );
        assert_eq!(session.authenticated_server_id(), None);
    }

    #[test]
    fn server_auth_session_does_not_authenticate_invalid_signature() {
        let hello = ServerHello::new([0xabu8; SERVER_PUBLIC_KEY_BYTES]);
        let mut session = ServerAuthSession::new();

        session.accept_hello(&hello.encode()).unwrap();
        let signature = [0u8; SERVER_SIGNATURE_BYTES];

        assert_eq!(
            session.accept_auth(&signature),
            Err(ServerAuthError::InvalidServerSignature)
        );
        assert_eq!(session.authenticated_server_id(), None);
    }

}
