use std::{
    convert::TryFrom,
    fmt,
    io::{self, ErrorKind, Read, Write},
    time::Duration,
};

pub const RELAY_PROTOCOL_VERSION: u8 = 1;
pub const FRAME_HEADER_BYTES: usize = 16;

pub const MAX_DATA_PAYLOAD_BYTES: u32 = 64 * 1024;
pub const MAX_CONTROL_PAYLOAD_BYTES: u32 = 16 * 1024;
pub const MAX_CONCURRENT_STREAMS_PER_CLIENT_SESSION: usize = 64;
pub const MAX_PENDING_OPENS: usize = 32;
pub const MAX_STREAM_BUFFER_BYTES: usize = 256 * 1024;
pub const MAX_SESSION_BUFFER_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_FRAMES_PER_SECOND_PER_SESSION: u32 = 4096;

pub const AUTH_TIMEOUT: Duration = Duration::from_secs(10);
pub const STREAM_OPEN_TIMEOUT: Duration = Duration::from_secs(5);
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(20);
pub const SESSION_DEAD_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum FrameType {
    ServerHello = 0x01,
    ClientHello = 0x02,
    Challenge = 0x03,
    ServerAuth = 0x04,
    ClientAuth = 0x05,
    AuthOk = 0x06,
    Error = 0x07,
    Open = 0x10,
    OpenOk = 0x11,
    Data = 0x12,
    Fin = 0x13,
    Reset = 0x14,
    Ping = 0x20,
    Pong = 0x21,
}

impl FrameType {
    pub fn is_stream_frame(self) -> bool {
        matches!(
            self,
            Self::Open | Self::OpenOk | Self::Data | Self::Fin | Self::Reset
        )
    }
}

impl TryFrom<u8> for FrameType {
    type Error = ProtocolError;

    fn try_from(value: u8) -> Result<Self, ProtocolError> {
        match value {
            0x01 => Ok(Self::ServerHello),
            0x02 => Ok(Self::ClientHello),
            0x03 => Ok(Self::Challenge),
            0x04 => Ok(Self::ServerAuth),
            0x05 => Ok(Self::ClientAuth),
            0x06 => Ok(Self::AuthOk),
            0x07 => Ok(Self::Error),
            0x10 => Ok(Self::Open),
            0x11 => Ok(Self::OpenOk),
            0x12 => Ok(Self::Data),
            0x13 => Ok(Self::Fin),
            0x14 => Ok(Self::Reset),
            0x20 => Ok(Self::Ping),
            0x21 => Ok(Self::Pong),
            other => Err(ProtocolError::UnknownFrameType(other)),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameHeader {
    pub version: u8,
    pub frame_type: FrameType,
    pub flags: u16,
    pub stream_id: u64,
    pub payload_len: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub header: FrameHeader,
    pub payload: Vec<u8>,
}

#[derive(Debug)]
pub enum FrameIoError {
    Protocol(ProtocolError),
    TruncatedHeader { actual: usize },
    TruncatedPayload { expected: u32, actual: usize },
    PayloadLengthMismatch { declared: u32, actual: usize },
    Io(io::Error),
}

impl fmt::Display for FrameIoError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Protocol(error) => write!(formatter, "{error}"),
            Self::TruncatedHeader { actual } => write!(
                formatter,
                "Header frame relay troncato: {actual} byte ricevuti, attesi {FRAME_HEADER_BYTES}."
            ),
            Self::TruncatedPayload { expected, actual } => write!(
                formatter,
                "Payload frame relay troncato: {actual} byte ricevuti, attesi {expected}."
            ),
            Self::PayloadLengthMismatch { declared, actual } => write!(
                formatter,
                "Lunghezza payload frame relay incoerente: header={declared}, payload={actual}."
            ),
            Self::Io(error) => write!(formatter, "Errore I/O frame relay: {error}"),
        }
    }
}

impl std::error::Error for FrameIoError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Protocol(error) => Some(error),
            Self::Io(error) => Some(error),
            _ => None,
        }
    }
}

impl From<ProtocolError> for FrameIoError {
    fn from(error: ProtocolError) -> Self {
        Self::Protocol(error)
    }
}

fn read_exact_count<R: Read>(reader: &mut R, buffer: &mut [u8]) -> Result<usize, io::Error> {
    let mut filled = 0usize;
    while filled < buffer.len() {
        match reader.read(&mut buffer[filled..]) {
            Ok(0) => break,
            Ok(read) => filled += read,
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    Ok(filled)
}

pub fn read_frame<R: Read>(reader: &mut R) -> Result<Frame, FrameIoError> {
    let mut header_bytes = [0u8; FRAME_HEADER_BYTES];
    let header_read = read_exact_count(reader, &mut header_bytes).map_err(FrameIoError::Io)?;
    if header_read != FRAME_HEADER_BYTES {
        return Err(FrameIoError::TruncatedHeader { actual: header_read });
    }

    let header = FrameHeader::decode(header_bytes)?;
    header.validate_v1()?;

    let payload_len = usize::try_from(header.payload_len)
        .expect("u32 payload_len deve essere rappresentabile come usize");
    let mut payload = vec![0u8; payload_len];
    let payload_read = read_exact_count(reader, &mut payload).map_err(FrameIoError::Io)?;
    if payload_read != payload_len {
        return Err(FrameIoError::TruncatedPayload {
            expected: header.payload_len,
            actual: payload_read,
        });
    }

    Ok(Frame { header, payload })
}

pub fn write_frame<W: Write>(
    writer: &mut W,
    header: FrameHeader,
    payload: &[u8],
) -> Result<(), FrameIoError> {
    header.validate_v1()?;

    if payload.len() != header.payload_len as usize {
        return Err(FrameIoError::PayloadLengthMismatch {
            declared: header.payload_len,
            actual: payload.len(),
        });
    }

    writer.write_all(&header.encode()).map_err(FrameIoError::Io)?;
    writer.write_all(payload).map_err(FrameIoError::Io)?;
    Ok(())
}

#[cfg(feature = "async-io")]
pub async fn read_frame_async<R>(reader: &mut R) -> Result<Frame, FrameIoError>
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt;

    let mut header_bytes = [0u8; FRAME_HEADER_BYTES];
    reader
        .read_exact(&mut header_bytes)
        .await
        .map_err(FrameIoError::Io)?;

    let header = FrameHeader::decode(header_bytes)?;
    header.validate_v1()?;

    let payload_len = usize::try_from(header.payload_len)
        .expect("u32 payload_len deve essere rappresentabile come usize");
    let mut payload = vec![0u8; payload_len];
    if payload_len != 0 {
        reader
            .read_exact(&mut payload)
            .await
            .map_err(FrameIoError::Io)?;
    }

    Ok(Frame { header, payload })
}

#[cfg(feature = "async-io")]
pub async fn write_frame_async<W>(writer: &mut W, frame: &Frame) -> Result<(), FrameIoError>
where
    W: tokio::io::AsyncWrite + Unpin,
{
    use tokio::io::AsyncWriteExt;

    frame.header.validate_v1()?;
    if frame.payload.len() != frame.header.payload_len as usize {
        return Err(FrameIoError::PayloadLengthMismatch {
            declared: frame.header.payload_len,
            actual: frame.payload.len(),
        });
    }

    writer
        .write_all(&frame.header.encode())
        .await
        .map_err(FrameIoError::Io)?;
    if !frame.payload.is_empty() {
        writer
            .write_all(&frame.payload)
            .await
            .map_err(FrameIoError::Io)?;
    }
    writer.flush().await.map_err(FrameIoError::Io)?;
    Ok(())
}

pub fn frame(frame_type: FrameType, stream_id: u64, payload: Vec<u8>) -> Frame {
    let payload_len = u32::try_from(payload.len())
        .expect("Payload frame relay deve essere rappresentabile come u32");
    Frame {
        header: FrameHeader::new(frame_type, stream_id, payload_len),
        payload,
    }
}

impl FrameHeader {
    pub fn new(frame_type: FrameType, stream_id: u64, payload_len: u32) -> Self {
        Self {
            version: RELAY_PROTOCOL_VERSION,
            frame_type,
            flags: 0,
            stream_id,
            payload_len,
        }
    }

    pub fn encode(self) -> [u8; FRAME_HEADER_BYTES] {
        let mut bytes = [0u8; FRAME_HEADER_BYTES];
        bytes[0] = self.version;
        bytes[1] = self.frame_type as u8;
        bytes[2..4].copy_from_slice(&self.flags.to_be_bytes());
        bytes[4..12].copy_from_slice(&self.stream_id.to_be_bytes());
        bytes[12..16].copy_from_slice(&self.payload_len.to_be_bytes());
        bytes
    }

    pub fn decode(bytes: [u8; FRAME_HEADER_BYTES]) -> Result<Self, ProtocolError> {
        let frame_type = FrameType::try_from(bytes[1])?;
        let flags = u16::from_be_bytes([bytes[2], bytes[3]]);
        let stream_id = u64::from_be_bytes(
            bytes[4..12]
                .try_into()
                .expect("slice stream_id con lunghezza fissa"),
        );
        let payload_len = u32::from_be_bytes(
            bytes[12..16]
                .try_into()
                .expect("slice payload_len con lunghezza fissa"),
        );

        Ok(Self {
            version: bytes[0],
            frame_type,
            flags,
            stream_id,
            payload_len,
        })
    }

    pub fn validate_v1(self) -> Result<(), ProtocolError> {
        if self.version != RELAY_PROTOCOL_VERSION {
            return Err(ProtocolError::UnsupportedVersion(self.version));
        }
        if self.flags != 0 {
            return Err(ProtocolError::UnsupportedFlags(self.flags));
        }

        if self.frame_type.is_stream_frame() {
            if self.stream_id == 0 {
                return Err(ProtocolError::InvalidStreamId);
            }
        } else if self.stream_id != 0 {
            return Err(ProtocolError::InvalidStreamId);
        }

        let max_payload = if self.frame_type == FrameType::Data {
            MAX_DATA_PAYLOAD_BYTES
        } else {
            MAX_CONTROL_PAYLOAD_BYTES
        };
        if self.payload_len > max_payload {
            return Err(ProtocolError::PayloadTooLarge {
                actual: self.payload_len,
                max: max_payload,
            });
        }

        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtocolError {
    UnknownFrameType(u8),
    UnsupportedVersion(u8),
    UnsupportedFlags(u16),
    InvalidStreamId,
    PayloadTooLarge { actual: u32, max: u32 },
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownFrameType(value) => {
                write!(formatter, "Tipo frame relay sconosciuto: {value:#04x}.")
            }
            Self::UnsupportedVersion(value) => {
                write!(formatter, "Versione protocollo relay non supportata: {value}.")
            }
            Self::UnsupportedFlags(value) => {
                write!(formatter, "Flag protocollo relay non supportati: {value:#06x}.")
            }
            Self::InvalidStreamId => {
                write!(formatter, "Stream ID non valido per il tipo di frame relay.")
            }
            Self::PayloadTooLarge { actual, max } => write!(
                formatter,
                "Payload frame relay troppo grande: {actual} byte, massimo {max} byte."
            ),
        }
    }
}

impl std::error::Error for ProtocolError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_header_is_exactly_16_bytes_and_big_endian() {
        let header = FrameHeader {
            version: RELAY_PROTOCOL_VERSION,
            frame_type: FrameType::Data,
            flags: 0x1234,
            stream_id: 0x0102_0304_0506_0708,
            payload_len: 0x0001_0000,
        };

        assert_eq!(
            header.encode(),
            [
                0x01, 0x12, 0x12, 0x34, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
                0x00, 0x01, 0x00, 0x00,
            ]
        );
    }

    #[test]
    fn frame_header_round_trip_preserves_fields() {
        let header = FrameHeader::new(FrameType::Open, 42, 0);
        let decoded = FrameHeader::decode(header.encode()).unwrap();

        assert_eq!(decoded, header);
        assert!(decoded.validate_v1().is_ok());
    }

    #[test]
    fn decoder_rejects_unknown_frame_type() {
        let mut bytes = FrameHeader::new(FrameType::Ping, 0, 0).encode();
        bytes[1] = 0xff;

        assert_eq!(
            FrameHeader::decode(bytes),
            Err(ProtocolError::UnknownFrameType(0xff))
        );
    }

    #[test]
    fn validation_rejects_stream_id_on_control_frame() {
        let header = FrameHeader::new(FrameType::Ping, 7, 0);

        assert_eq!(header.validate_v1(), Err(ProtocolError::InvalidStreamId));
    }

    #[test]
    fn validation_rejects_zero_stream_id_on_stream_frame() {
        let header = FrameHeader::new(FrameType::Data, 0, 1);

        assert_eq!(header.validate_v1(), Err(ProtocolError::InvalidStreamId));
    }

    #[test]
    fn validation_applies_distinct_control_and_data_payload_limits() {
        let control = FrameHeader::new(FrameType::ClientHello, 0, MAX_CONTROL_PAYLOAD_BYTES + 1);
        let data = FrameHeader::new(FrameType::Data, 1, MAX_DATA_PAYLOAD_BYTES + 1);

        assert_eq!(
            control.validate_v1(),
            Err(ProtocolError::PayloadTooLarge {
                actual: MAX_CONTROL_PAYLOAD_BYTES + 1,
                max: MAX_CONTROL_PAYLOAD_BYTES,
            })
        );
        assert_eq!(
            data.validate_v1(),
            Err(ProtocolError::PayloadTooLarge {
                actual: MAX_DATA_PAYLOAD_BYTES + 1,
                max: MAX_DATA_PAYLOAD_BYTES,
            })
        );
    }
    #[test]
    fn frame_io_round_trip_preserves_header_and_payload() {
        let payload = b"baia-relay";
        let header = FrameHeader::new(FrameType::Data, 9, payload.len() as u32);
        let mut encoded = Vec::new();

        write_frame(&mut encoded, header, payload).unwrap();
        let decoded = read_frame(&mut encoded.as_slice()).unwrap();

        assert_eq!(decoded.header, header);
        assert_eq!(decoded.payload, payload);
    }

    #[test]
    fn reader_rejects_oversized_payload_before_reading_body() {
        let header = FrameHeader::new(FrameType::Data, 1, MAX_DATA_PAYLOAD_BYTES + 1);
        let encoded_header = header.encode();

        let error = read_frame(&mut encoded_header.as_slice()).unwrap_err();

        assert!(matches!(
            error,
            FrameIoError::Protocol(ProtocolError::PayloadTooLarge {
                actual,
                max: MAX_DATA_PAYLOAD_BYTES,
            }) if actual == MAX_DATA_PAYLOAD_BYTES + 1
        ));
    }

    #[test]
    fn reader_rejects_truncated_payload() {
        let header = FrameHeader::new(FrameType::Data, 1, 4);
        let mut bytes = header.encode().to_vec();
        bytes.extend_from_slice(&[0xaa, 0xbb]);

        let error = read_frame(&mut bytes.as_slice()).unwrap_err();

        assert!(matches!(
            error,
            FrameIoError::TruncatedPayload {
                expected: 4,
                actual: 2,
            }
        ));
    }

    #[test]
    fn writer_rejects_payload_length_mismatch() {
        let header = FrameHeader::new(FrameType::Data, 1, 4);
        let mut encoded = Vec::new();

        let error = write_frame(&mut encoded, header, &[0xaa, 0xbb]).unwrap_err();

        assert!(matches!(
            error,
            FrameIoError::PayloadLengthMismatch {
                declared: 4,
                actual: 2,
            }
        ));
        assert!(encoded.is_empty());
    }

}
