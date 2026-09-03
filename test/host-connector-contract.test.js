const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const connector = fs.readFileSync(
  path.join(__dirname, '..', 'host-connector', 'src', 'main.rs'),
  'utf8',
);
const connectorTls = fs.readFileSync(
  path.join(__dirname, '..', 'src-tauri', 'src', 'connector_tls.rs'),
  'utf8',
);
const hostTls = fs.readFileSync(
  path.join(__dirname, '..', 'host-connector', 'src', 'tls.rs'),
  'utf8',
);
const serverIdentity = fs.readFileSync(
  path.join(__dirname, '..', 'host-connector', 'src', 'server_identity.rs'),
  'utf8',
);
const transport = fs.readFileSync(
  path.join(__dirname, '..', 'src-tauri', 'src', 'transport', 'mod.rs'),
  'utf8',
);
const core = fs.readFileSync(
  path.join(__dirname, '..', 'src-tauri', 'src', 'core.rs'),
  'utf8',
);
const mediaBridge = fs.readFileSync(
  path.join(__dirname, '..', 'src-tauri', 'src', 'media_bridge.rs'),
  'utf8',
);
const auth = fs.readFileSync(
  path.join(__dirname, '..', 'src-tauri', 'src', 'auth.rs'),
  'utf8',
);
const pairing = fs.readFileSync(
  path.join(__dirname, '..', 'src-tauri', 'src', 'pairing.rs'),
  'utf8',
);
const nativeUpload = fs.readFileSync(
  path.join(__dirname, '..', 'src-tauri', 'src', 'native_upload.rs'),
  'utf8',
);
const accessGrant = fs.readFileSync(
  path.join(__dirname, '..', 'host-connector', 'src', 'access_grant.rs'),
  'utf8',
);

test('Host Connector v1 usa bind controllato e un solo upstream Node fisso', () => {
  assert.match(connector, /const DEFAULT_BIND_IP: &str = "127\.0\.0\.1";/);
  assert.match(connector, /const BIND_IP_ENV: &str = "BAIA_CONNECTOR_BIND_IP";/);
  assert.match(connector, /address\.is_loopback\(\) \|\| address\.is_private\(\)/);
  assert.match(connector, /const UPSTREAM_BASE_URL: &str = "http:\/\/127\.0\.0\.1:3000";/);
  assert.doesNotMatch(connector, /upstream_url:\s*String/);
  assert.match(connector, /build_upstream_target/);
});

test('protocollo Connector non accetta host arbitrari e mantiene X-Baia fuori dagli header applicativi', () => {
  assert.match(connector, /Il Connector accetta soltanto path relativi \/api\//);
  assert.match(connector, /normalized\.starts_with\("x-baia-"\)/);
  assert.match(connector, /X-Baia-Device-Id/);
  assert.match(connector, /X-Baia-Signature/);
});

test('TransportManager usa lo stesso canale Connector TLS anche in Direct Internet TCP 443', () => {
  assert.match(connectorTls, /DEFAULT_CONNECTOR_ENDPOINT: &str = "https:\/\/127\.0\.0\.1:43127"/);
  assert.match(connectorTls, /CONNECTOR_ENDPOINT_ENV: &str = "BAIA_CONNECTOR_ENDPOINT"/);
  assert.match(connectorTls, /ConnectorEndpointKind::DirectInternet/);
  assert.match(connectorTls, /\(443, Some\(Host::Domain/);
  assert.match(connectorTls, /REQUEST_PATH: &str = "\/baia\/v1\/request"/);
  assert.match(transport, /connector_url\(&connector_endpoint, connector_tls::REQUEST_PATH\)/);
  assert.match(transport, /connector_client/);
  assert.match(transport, /connector_api_request/);
  assert.doesNotMatch(transport, /direct_api_request/);
  assert.match(core, /direct-internet-tls-v1/);
  assert.match(core, /Direct Internet ha precedenza esplicita sul fallback relay/);
});

test('Host Connector espone health v1 senza accesso a SQLite o filesystem media', () => {
  assert.match(connector, /HEALTH_PATH: &str = "\/baia\/v1\/health"/);
  assert.match(connector, /node_reachable/);
  assert.doesNotMatch(connector, /sqlite|media\.sqlite|LIBRARY_PATH|DATABASE_PATH/i);
});


test('Fase 4A.4 instrada il Media Bridge solo nel canale media del Connector configurato', () => {
  assert.match(connectorTls, /MEDIA_PATH: &str = "\/baia\/v1\/media"/);
  assert.match(mediaBridge, /connector_url\(&connector_endpoint, connector_tls::MEDIA_PATH\)/);
  assert.match(mediaBridge, /connector_client[\s\S]{0,80}\.post\(&connector_url\)/);
  assert.doesNotMatch(mediaBridge, /upstream_url:\s*String/);
  assert.match(auth, /struct MediaAuthorization/);
});

test('canale media Connector usa solo path logici allowlistati e conserva Range', () => {
  assert.match(connector, /const MEDIA_PATH: &str = "\/baia\/v1\/media"/);
  assert.match(connector, /normalize_media_path/);
  assert.match(connector, /reqwest::header::RANGE/);
  assert.match(connector, /reqwest::header::IF_RANGE/);
  assert.match(connector, /_baia_device/);
  assert.match(connector, /_baia_expires/);
  assert.match(connector, /_baia_signature/);
  assert.doesNotMatch(connector, /MEDIA_PATH.*upstream_url/s);
});


test('Fase 4A.4 riscatta il pairing solo tramite il canale specifico del Connector configurato', () => {
  assert.match(connectorTls, /PAIRING_PATH: &str = "\/baia\/v1\/pairing"/);
  assert.match(pairing, /connector_url\(&connector_endpoint, connector_tls::PAIRING_PATH\)/);
  assert.match(pairing, /\.post\(&connector_url\)/);
  assert.doesNotMatch(pairing, /\/api\/pairing\/redeem/);
  assert.match(connector, /const PAIRING_PATH: &str = "\/baia\/v1\/pairing"/);
  assert.match(connector, /const NODE_PAIRING_PATH: &str = "\/api\/pairing\/redeem"/);
  assert.match(connector, /pairing_upstream_target/);
});

test('canale pairing non accetta host upstream dal Core e non registra il token invito', () => {
  assert.doesNotMatch(connector, /struct ConnectorPairingRequest[\s\S]*upstream_url/);
  assert.doesNotMatch(connector, /println!\([\s\S]{0,250}invite_token/);
  assert.match(connector, /deny_unknown_fields/);
  assert.match(connector, /MAX_PAIRING_TOKEN_BYTES/);
});


test('Fase 4A.4 instrada gli upload nativi soltanto nel canale upload del Connector configurato', () => {
  assert.match(connectorTls, /UPLOAD_PATH: &str = "\/baia\/v1\/upload"/);
  assert.match(nativeUpload, /connector_url\(&connector_endpoint, connector_tls::UPLOAD_PATH\)/);
  assert.match(nativeUpload, /\.post\(&connector_url\)/);
  assert.match(nativeUpload, /X-Baia-Upload-Path/);
  assert.doesNotMatch(nativeUpload, /\.post\(node_target\)/);
  assert.match(connector, /const UPLOAD_PATH: &str = "\/baia\/v1\/upload"/);
});

test('canale upload Connector fa streaming raw solo verso endpoint nativi allowlistati', () => {
  assert.match(connector, /Body::sized\(body_reader, content_length\)/);
  assert.match(connector, /normalize_upload_path/);
  assert.match(connector, /"api", "uploads", "movies"/);
  assert.match(connector, /"api", "uploads", "series"/);
  assert.match(connector, /"api", "uploads", "music", "sessions"/);
  assert.match(connector, /"api", "uploads", "reading", category/);
  assert.match(connector, /build_upload_upstream_target/);
  assert.match(connector, /MAX_UPLOAD_BODY_BYTES/);
  assert.doesNotMatch(connector, /upload[\s\S]{0,200}upstream_url/i);
});


test('Direct Internet conserva TLS 1.3 con Raw Public Key Ed25519 pinnata nel Core', () => {
  assert.match(hostTls, /rustls::version::TLS13/);
  assert.match(hostTls, /AlwaysResolvesServerRawPublicKeys/);
  assert.match(serverIdentity, /subject_public_key_info_der/);
  assert.match(connectorTls, /rustls::version::TLS13/);
  assert.match(connectorTls, /requires_raw_public_keys/);
  assert.match(connectorTls, /verify_tls13_signature_with_raw_key/);
  assert.match(connectorTls, /BAIA_CONNECTOR_SERVER_FINGERPRINT/);
  assert.match(core, /connector_server_fingerprint/);
  assert.doesNotMatch(connectorTls, /danger_accept_invalid_certs|danger_accept_invalid_hostnames/);
  assert.doesNotMatch(connectorTls, /http:\/\/127\.0\.0\.1:43127/);
  assert.match(connectorTls, /normalize_connector_endpoint/);
  assert.match(connectorTls, /address\.is_loopback\(\) \|\| address\.is_private\(\)/);
  assert.match(connector, /BAIA_CONNECTOR_BIND_IP/);
  assert.match(connector, /const UPSTREAM_BASE_URL: &str = "http:\/\/127\.0\.0\.1:3000";/);
});


test('Connector Internet-facing limita connessioni, handshake e parser HTTP pre-auth', () => {
  assert.match(connector, /MAX_ACTIVE_CONNECTIONS: usize = 128/);
  assert.match(connector, /MAX_ACTIVE_CONNECTIONS_PER_IP: usize = 16/);
  assert.match(connector, /CONNECTION_START_WINDOW: Duration = Duration::from_secs\(10\)/);
  assert.match(connector, /MAX_CONNECTION_STARTS_PER_WINDOW: usize = 256/);
  assert.match(connector, /starts_in_window/);
  assert.match(connector, /TLS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs\(8\)/);
  assert.match(connector, /HTTP_HEAD_TIMEOUT: Duration = Duration::from_secs\(12\)/);
  assert.match(connector, /ConnectionLimiter/);
  assert.match(connector, /Header HTTP Connector duplicato/);
  assert.match(connector, /Target HTTP Connector deve essere un path origin-form/);
  assert.match(connector, /MAX_HTTP_LINE_BYTES/);
  assert.doesNotMatch(connector, /error=\{error:\?\}/);
});

test('Connector verifica grant server-signed e prova della chiave device prima di inoltrare API/media/upload', () => {
  assert.match(accessGrant, /verify_access_grant/);
  assert.match(accessGrant, /verify_request_authorization/);
  assert.match(accessGrant, /verify_media_authorization/);
  assert.match(accessGrant, /UnparsedPublicKey::new\(&ED25519/);
  assert.match(connector, /CONNECTOR_TRANSPORT_AUTH_REJECTED/);
  assert.match(connector, /server_identity\.public_key\(\)/);
  assert.match(transport, /access_grant/);
  assert.match(mediaBridge, /access_grant/);
  assert.match(nativeUpload, /X-Baia-Access-Grant/);
  assert.match(connector, /x-baia-access-grant/);
});

test('pairing Direct può bootstrapparsi con endpoint pubblico e pin senza rendere il relay obbligatorio', () => {
  assert.match(pairing, /baia-direct1\./);
  assert.match(pairing, /store_direct_pairing/);
  assert.match(pairing, /ConnectorEndpointKind::DirectInternet/);
  assert.match(pairing, /relay_server_id\.is_some\(\) != relay_access_grant\.is_some\(\)/);
  assert.doesNotMatch(pairing, /Host Connector non ha restituito un server_id relay valido/);
});

test('Fase 4A.4 separa endpoint fisico Connector dal Node logico e non lo espone al JavaScript', () => {
  assert.match(core, /connector_endpoint: String/);
  assert.match(core, /CONNECTOR_ENDPOINT_ENV/);
  assert.match(core, /DEFAULT_CONNECTOR_ENDPOINT/);
  assert.doesNotMatch(core, /baia_core_set_connector_endpoint/);
  assert.doesNotMatch(
    transport,
    /pub struct ApiTransportRequest \{[\s\S]{0,500}(?:url|host|endpoint): String/,
  );
  assert.match(connector, /const UPSTREAM_BASE_URL: &str = "http:\/\/127\.0\.0\.1:3000";/);
});

test('profilo Windows Direct usa data dir esplicita e supporta fingerprint senza aprire listener', () => {
  assert.match(serverIdentity, /BAIA_CONNECTOR_DATA_DIR/);
  assert.match(serverIdentity, /data_dir\.is_absolute\(\)/);
  assert.match(connector, /--print-fingerprint/);
  assert.match(connector, /load_or_create_server_identity/);
});
