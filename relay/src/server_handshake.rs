use std::fmt;

use crate::{
    protocol::{Frame, FrameHeader, FrameType, ProtocolError},
    server_auth::{
        AuthenticatedServer, ServerAuthError, ServerAuthSession, SERVER_CHALLENGE_BYTES,
    },
};

#[derive(Debug)]
pub struct ServerHandshake {
    auth: ServerAuthSession,
}

impl ServerHandshake {
    pub fn new() -> Self {
        Self {
            auth: ServerAuthSession::new(),
        }
    }

    pub fn accept_hello(&mut self, frame: Frame) -> Result<Frame, ServerHandshakeError> {
        validate_control_frame(&frame, FrameType::ServerHello)?;

        let challenge = self.auth.accept_hello(&frame.payload)?;
        Ok(control_frame(FrameType::Challenge, challenge.to_vec()))
    }

    pub fn accept_auth(
        &mut self,
        frame: Frame,
    ) -> Result<(Frame, AuthenticatedServer), ServerHandshakeError> {
        validate_control_frame(&frame, FrameType::ServerAuth)?;

        self.auth.accept_auth(&frame.payload)?;
        let authenticated = self
            .auth
            .authenticated_server()
            .ok_or(ServerHandshakeError::AuthenticationStateMissing)?;

        Ok((
            control_frame(FrameType::AuthOk, Vec::new()),
            authenticated,
        ))
    }
}

impl Default for ServerHandshake {
    fn default() -> Self {
        Self::new()
    }
}

fn validate_control_frame(
    frame: &Frame,
    expected: FrameType,
) -> Result<(), ServerHandshakeError> {
    frame
        .header
        .validate_v1()
        .map_err(ServerHandshakeError::Protocol)?;

    if frame.header.frame_type != expected {
        return Err(ServerHandshakeError::UnexpectedFrameType {
            expected,
            actual: frame.header.frame_type,
        });
    }

    if frame.header.payload_len as usize != frame.payload.len() {
        return Err(ServerHandshakeError::PayloadLengthMismatch {
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
pub enum ServerHandshakeError {
    Protocol(ProtocolError),
    Auth(ServerAuthError),
    UnexpectedFrameType {
        expected: FrameType,
        actual: FrameType,
    },
    PayloadLengthMismatch {
        declared: u32,
        actual: usize,
    },
    AuthenticationStateMissing,
}

impl fmt::Display for ServerHandshakeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Protocol(error) => write!(formatter, "{error}"),
            Self::Auth(error) => write!(formatter, "{error}"),
            Self::UnexpectedFrameType { expected, actual } => write!(
                formatter,
                "Frame handshake server inatteso: ricevuto {actual:?}, atteso {expected:?}."
            ),
            Self::PayloadLengthMismatch { declared, actual } => write!(
                formatter,
                "Payload frame handshake server incoerente: header={declared}, payload={actual}."
            ),
            Self::AuthenticationStateMissing => write!(
                formatter,
                "Handshake server completato senza identità autenticata disponibile."
            ),
        }
    }
}

impl std::error::Error for ServerHandshakeError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Protocol(error) => Some(error),
            Self::Auth(error) => Some(error),
            _ => None,
        }
    }
}

impl From<ServerAuthError> for ServerHandshakeError {
    fn from(error: ServerAuthError) -> Self {
        Self::Auth(error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server_auth::{
        build_server_auth_message, ServerHello, SERVER_PUBLIC_KEY_BYTES, SERVER_SIGNATURE_BYTES,
    };
    use ring::{
        rand::SystemRandom,
        signature::{Ed25519KeyPair, KeyPair},
    };

    fn frame(frame_type: FrameType, stream_id: u64, payload: Vec<u8>) -> Frame {
        Frame {
            header: FrameHeader::new(frame_type, stream_id, payload.len() as u32),
            payload,
        }
    }

    #[test]
    fn server_handshake_maps_wire_frames_to_authenticated_server() {
        let rng = SystemRandom::new();
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let key_pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
        let public_key: [u8; SERVER_PUBLIC_KEY_BYTES] =
            key_pair.public_key().as_ref().try_into().unwrap();
        let hello = ServerHello::new(public_key);

        let mut handshake = ServerHandshake::new();

        let challenge_frame = handshake
            .accept_hello(frame(
                FrameType::ServerHello,
                0,
                hello.encode().to_vec(),
            ))
            .unwrap();

        assert_eq!(challenge_frame.header.frame_type, FrameType::Challenge);
        assert_eq!(challenge_frame.header.stream_id, 0);
        assert_eq!(challenge_frame.payload.len(), SERVER_CHALLENGE_BYTES);

        let challenge: [u8; SERVER_CHALLENGE_BYTES] =
            challenge_frame.payload.as_slice().try_into().unwrap();
        let message = build_server_auth_message(&hello, &challenge).unwrap();
        let signature = key_pair.sign(&message);

        let (auth_ok, authenticated) = handshake
            .accept_auth(frame(
                FrameType::ServerAuth,
                0,
                signature.as_ref().to_vec(),
            ))
            .unwrap();

        assert_eq!(auth_ok.header.frame_type, FrameType::AuthOk);
        assert_eq!(auth_ok.header.stream_id, 0);
        assert!(auth_ok.payload.is_empty());
        assert_eq!(authenticated.server_id, hello.server_id());
        assert_eq!(authenticated.public_key, public_key);
    }

    #[test]
    fn server_handshake_rejects_wrong_first_frame_type() {
        let mut handshake = ServerHandshake::new();
        let payload = vec![0u8; 1];

        let error = handshake
            .accept_hello(frame(FrameType::ClientHello, 0, payload))
            .unwrap_err();

        assert!(matches!(
            error,
            ServerHandshakeError::UnexpectedFrameType {
                expected: FrameType::ServerHello,
                actual: FrameType::ClientHello,
            }
        ));
    }

    #[test]
    fn server_handshake_rejects_nonzero_stream_id_on_control_frame() {
        let mut handshake = ServerHandshake::new();
        let hello = ServerHello::new([0x11u8; SERVER_PUBLIC_KEY_BYTES]);

        let error = handshake
            .accept_hello(frame(
                FrameType::ServerHello,
                7,
                hello.encode().to_vec(),
            ))
            .unwrap_err();

        assert!(matches!(
            error,
            ServerHandshakeError::Protocol(ProtocolError::InvalidStreamId)
        ));
    }

    #[test]
    fn server_handshake_rejects_invalid_signature() {
        let mut handshake = ServerHandshake::new();
        let hello = ServerHello::new([0x22u8; SERVER_PUBLIC_KEY_BYTES]);

        handshake
            .accept_hello(frame(
                FrameType::ServerHello,
                0,
                hello.encode().to_vec(),
            ))
            .unwrap();

        let signature = [0u8; SERVER_SIGNATURE_BYTES];
        let error = handshake
            .accept_auth(frame(
                FrameType::ServerAuth,
                0,
                signature.to_vec(),
            ))
            .unwrap_err();

        assert!(matches!(
            error,
            ServerHandshakeError::Auth(ServerAuthError::InvalidServerSignature)
        ));
    }
}
