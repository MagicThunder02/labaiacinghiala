use std::fmt;

use crate::{
    client_auth::{
        AuthenticatedClient, ClientAuthError, ClientAuthSession, ClientHello,
    },
    protocol::{Frame, FrameHeader, FrameType, ProtocolError},
    server_auth::ServerId,
    server_registry::ServerRegistry,
};

#[derive(Debug)]
pub struct ClientHandshake {
    auth: Option<ClientAuthSession>,
}

impl ClientHandshake {
    pub fn new() -> Self {
        Self { auth: None }
    }

    pub fn accept_hello(
        &mut self,
        frame: Frame,
        registry: &ServerRegistry,
    ) -> Result<Frame, ClientHandshakeError> {
        if self.auth.is_some() {
            return Err(ClientHandshakeError::UnexpectedHandshakeState);
        }

        validate_control_frame(&frame, FrameType::ClientHello)?;

        let hello = ClientHello::decode(&frame.payload)?;
        let server_id = ServerId::from_bytes(hello.server_id);
        let server = registry
            .get(server_id)
            .ok_or(ClientHandshakeError::ServerUnavailable(server_id))?;

        let mut auth = ClientAuthSession::new(server.public_key);
        let challenge = auth.accept_hello(&frame.payload)?;
        self.auth = Some(auth);

        Ok(control_frame(FrameType::Challenge, challenge.to_vec()))
    }

    pub fn accept_auth(
        &mut self,
        frame: Frame,
    ) -> Result<(Frame, AuthenticatedClient), ClientHandshakeError> {
        validate_control_frame(&frame, FrameType::ClientAuth)?;

        let auth = self
            .auth
            .as_mut()
            .ok_or(ClientHandshakeError::UnexpectedHandshakeState)?;
        let authenticated = auth.accept_auth(&frame.payload)?;

        Ok((control_frame(FrameType::AuthOk, Vec::new()), authenticated))
    }
}

impl Default for ClientHandshake {
    fn default() -> Self {
        Self::new()
    }
}

fn validate_control_frame(
    frame: &Frame,
    expected: FrameType,
) -> Result<(), ClientHandshakeError> {
    frame
        .header
        .validate_v1()
        .map_err(ClientHandshakeError::Protocol)?;

    if frame.header.frame_type != expected {
        return Err(ClientHandshakeError::UnexpectedFrameType {
            expected,
            actual: frame.header.frame_type,
        });
    }

    if frame.header.payload_len as usize != frame.payload.len() {
        return Err(ClientHandshakeError::PayloadLengthMismatch {
            declared: frame.header.payload_len,
            actual: frame.payload.len(),
        });
    }

    Ok(())
}

fn control_frame(frame_type: FrameType, payload: Vec<u8>) -> Frame {
    let payload_len = u32::try_from(payload.len())
        .expect("Payload handshake relay deve essere rappresentabile come u32");
    Frame {
        header: FrameHeader::new(frame_type, 0, payload_len),
        payload,
    }
}

#[derive(Debug)]
pub enum ClientHandshakeError {
    Protocol(ProtocolError),
    Auth(ClientAuthError),
    UnexpectedFrameType {
        expected: FrameType,
        actual: FrameType,
    },
    PayloadLengthMismatch {
        declared: u32,
        actual: usize,
    },
    ServerUnavailable(ServerId),
    UnexpectedHandshakeState,
}

impl fmt::Display for ClientHandshakeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Protocol(error) => write!(formatter, "{error}"),
            Self::Auth(error) => write!(formatter, "{error}"),
            Self::UnexpectedFrameType { expected, actual } => write!(
                formatter,
                "Frame handshake client inatteso: ricevuto {actual:?}, atteso {expected:?}."
            ),
            Self::PayloadLengthMismatch { declared, actual } => write!(
                formatter,
                "Payload frame handshake client incoerente: header={declared}, payload={actual}."
            ),
            Self::ServerUnavailable(server_id) => write!(
                formatter,
                "Server richiesto dal CLIENT_HELLO non disponibile nel relay: {}.",
                server_id.to_text()
            ),
            Self::UnexpectedHandshakeState => {
                write!(formatter, "Sequenza handshake client relay non valida.")
            }
        }
    }
}

impl std::error::Error for ClientHandshakeError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Protocol(error) => Some(error),
            Self::Auth(error) => Some(error),
            _ => None,
        }
    }
}

impl From<ClientAuthError> for ClientHandshakeError {
    fn from(error: ClientAuthError) -> Self {
        Self::Auth(error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        client_auth::{
            build_client_auth_message, build_relay_access_grant_message, RelayAccessGrant,
            RelayAccessGrantFields, CLIENT_CHALLENGE_BYTES, CLIENT_SIGNATURE_BYTES,
            DEVICE_ID_BYTES, DEVICE_PUBLIC_KEY_BYTES, GRANT_ID_BYTES,
        },
        server_auth::{
            AuthenticatedServer, SERVER_PUBLIC_KEY_BYTES, SERVER_SIGNATURE_BYTES,
        },
    };
    use ring::{
        rand::SystemRandom,
        signature::{Ed25519KeyPair, KeyPair},
    };

    struct Fixture {
        server: AuthenticatedServer,
        device_key_pair: Ed25519KeyPair,
        hello: ClientHello,
    }

    fn fixture() -> Fixture {
        let rng = SystemRandom::new();

        let server_pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let server_key_pair = Ed25519KeyPair::from_pkcs8(server_pkcs8.as_ref()).unwrap();
        let server_public_key: [u8; SERVER_PUBLIC_KEY_BYTES] =
            server_key_pair.public_key().as_ref().try_into().unwrap();
        let server = AuthenticatedServer {
            server_id: ServerId::derive(&server_public_key),
            public_key: server_public_key,
        };

        let device_pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let device_key_pair = Ed25519KeyPair::from_pkcs8(device_pkcs8.as_ref()).unwrap();
        let device_public_key: [u8; DEVICE_PUBLIC_KEY_BYTES] =
            device_key_pair.public_key().as_ref().try_into().unwrap();

        let fields = RelayAccessGrantFields::new(
            server.server_id,
            [0x11u8; DEVICE_ID_BYTES],
            device_public_key,
            [0x22u8; GRANT_ID_BYTES],
            1_700_000_000,
        );
        let grant_message = build_relay_access_grant_message(&fields).unwrap();
        let grant_signature = server_key_pair.sign(&grant_message);
        let server_signature: [u8; SERVER_SIGNATURE_BYTES] =
            grant_signature.as_ref().try_into().unwrap();
        let grant = RelayAccessGrant::new(fields, server_signature).unwrap();
        let hello = ClientHello::new(grant).unwrap();

        Fixture {
            server,
            device_key_pair,
            hello,
        }
    }

    fn frame(frame_type: FrameType, stream_id: u64, payload: Vec<u8>) -> Frame {
        Frame {
            header: FrameHeader::new(frame_type, stream_id, payload.len() as u32),
            payload,
        }
    }

    #[test]
    fn client_handshake_maps_wire_frames_to_authenticated_client() {
        let fixture = fixture();
        let mut registry = ServerRegistry::new();
        registry.register(fixture.server);
        let mut handshake = ClientHandshake::new();

        let challenge_frame = handshake
            .accept_hello(
                frame(FrameType::ClientHello, 0, fixture.hello.encode().to_vec()),
                &registry,
            )
            .unwrap();

        assert_eq!(challenge_frame.header.frame_type, FrameType::Challenge);
        assert_eq!(challenge_frame.header.stream_id, 0);
        assert_eq!(challenge_frame.payload.len(), CLIENT_CHALLENGE_BYTES);

        let challenge: [u8; CLIENT_CHALLENGE_BYTES] =
            challenge_frame.payload.as_slice().try_into().unwrap();
        let message = build_client_auth_message(&fixture.hello, &challenge).unwrap();
        let signature = fixture.device_key_pair.sign(&message);

        let (auth_ok, authenticated) = handshake
            .accept_auth(frame(
                FrameType::ClientAuth,
                0,
                signature.as_ref().to_vec(),
            ))
            .unwrap();

        assert_eq!(auth_ok.header.frame_type, FrameType::AuthOk);
        assert_eq!(auth_ok.header.stream_id, 0);
        assert!(auth_ok.payload.is_empty());
        assert_eq!(authenticated.server_id, *fixture.server.server_id.as_bytes());
        assert_eq!(authenticated.device_id, fixture.hello.grant.fields.device_id);
        assert_eq!(authenticated.device_public_key, fixture.hello.device_public_key);
    }

    #[test]
    fn client_handshake_rejects_offline_server() {
        let fixture = fixture();
        let registry = ServerRegistry::new();
        let mut handshake = ClientHandshake::new();

        let error = handshake
            .accept_hello(
                frame(FrameType::ClientHello, 0, fixture.hello.encode().to_vec()),
                &registry,
            )
            .unwrap_err();

        assert!(matches!(
            error,
            ClientHandshakeError::ServerUnavailable(server_id)
                if server_id == fixture.server.server_id
        ));
    }

    #[test]
    fn client_handshake_rejects_wrong_first_frame_type() {
        let registry = ServerRegistry::new();
        let mut handshake = ClientHandshake::new();

        let error = handshake
            .accept_hello(frame(FrameType::ServerHello, 0, Vec::new()), &registry)
            .unwrap_err();

        assert!(matches!(
            error,
            ClientHandshakeError::UnexpectedFrameType {
                expected: FrameType::ClientHello,
                actual: FrameType::ServerHello,
            }
        ));
    }

    #[test]
    fn client_handshake_does_not_authenticate_invalid_device_signature() {
        let fixture = fixture();
        let mut registry = ServerRegistry::new();
        registry.register(fixture.server);
        let mut handshake = ClientHandshake::new();

        handshake
            .accept_hello(
                frame(FrameType::ClientHello, 0, fixture.hello.encode().to_vec()),
                &registry,
            )
            .unwrap();

        let signature = [0u8; CLIENT_SIGNATURE_BYTES];
        let error = handshake
            .accept_auth(frame(FrameType::ClientAuth, 0, signature.to_vec()))
            .unwrap_err();

        assert!(matches!(
            error,
            ClientHandshakeError::Auth(ClientAuthError::InvalidClientSignature)
        ));
    }
}
