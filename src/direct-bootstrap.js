'use strict';

const DIRECT_BOOTSTRAP_PREFIX = 'baia-direct1.';
const PUBLIC_ENDPOINT_ENV = 'BAIA_PUBLIC_CONNECTOR_ENDPOINT';
const CONNECTOR_FINGERPRINT_ENV = 'BAIA_CONNECTOR_SERVER_FINGERPRINT';

function isPrivateIpv4(hostname) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((value) => value < 0 || value > 255)) return true;
  const [a, b] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a >= 224;
}

function normalizePublicConnectorEndpoint(value) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    throw new Error('Endpoint pubblico Baia non valido.');
  }

  if (parsed.protocol !== 'https:'
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
      || parsed.pathname !== '/') {
    throw new Error('Endpoint pubblico Baia deve essere una sola origine https:// su TCP 443.');
  }
  const port = parsed.port || '443';
  const hostname = parsed.hostname.toLowerCase();
  const ipv6Literal = hostname.startsWith('[') || hostname.includes(':');
  const localhostName = hostname === 'localhost' || hostname === 'localhost.' || hostname.endsWith('.localhost');
  if (port !== '443' || !hostname || localhostName || ipv6Literal || isPrivateIpv4(hostname)) {
    throw new Error('Endpoint pubblico Baia deve essere raggiungibile su TCP 443 e non può essere loopback/LAN privata.');
  }
  return parsed.origin;
}

function normalizeConnectorFingerprint(value) {
  const input = String(value || '').trim();
  if (!input.startsWith('SHA256:')) {
    throw new Error('Fingerprint Host Connector non valida.');
  }
  const encoded = input.slice('SHA256:'.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error('Fingerprint Host Connector non valida.');
  }
  let bytes;
  try {
    bytes = Buffer.from(encoded, 'base64url');
  } catch {
    throw new Error('Fingerprint Host Connector non valida.');
  }
  if (bytes.length !== 32 || bytes.toString('base64url') !== encoded) {
    throw new Error('Fingerprint Host Connector non valida.');
  }
  return `SHA256:${encoded}`;
}

function createDirectBootstrapInvite({ inviteToken, connectorEndpoint, serverFingerprint }) {
  const token = String(inviteToken || '').trim();
  if (!token.startsWith('baia1.') || token.length > 4096) {
    throw new Error('Token invito Baia non valido per il bootstrap Direct.');
  }
  const payload = {
    version: 1,
    connectorEndpoint: normalizePublicConnectorEndpoint(connectorEndpoint),
    serverFingerprint: normalizeConnectorFingerprint(serverFingerprint),
    inviteToken: token,
  };
  return `${DIRECT_BOOTSTRAP_PREFIX}${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
}

function directBootstrapFromEnvironment(inviteToken, env = process.env) {
  const endpoint = env[PUBLIC_ENDPOINT_ENV];
  const fingerprint = env[CONNECTOR_FINGERPRINT_ENV];
  if (!endpoint && !fingerprint) return null;
  if (!endpoint || !fingerprint) {
    throw new Error(`${PUBLIC_ENDPOINT_ENV} e ${CONNECTOR_FINGERPRINT_ENV} devono essere configurate insieme.`);
  }
  return createDirectBootstrapInvite({
    inviteToken,
    connectorEndpoint: endpoint,
    serverFingerprint: fingerprint,
  });
}

module.exports = {
  DIRECT_BOOTSTRAP_PREFIX,
  PUBLIC_ENDPOINT_ENV,
  CONNECTOR_FINGERPRINT_ENV,
  normalizePublicConnectorEndpoint,
  normalizeConnectorFingerprint,
  createDirectBootstrapInvite,
  directBootstrapFromEnvironment,
};
