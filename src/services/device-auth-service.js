const crypto = require('node:crypto');
const { ensurePairingSchema } = require('./pairing-service');

const REQUEST_CONTEXT = 'BAIA-REQ-V1';
const MEDIA_CONTEXT = 'BAIA-MEDIA-V1';
const REQUEST_CLOCK_SKEW_SECONDS = 90;
const MEDIA_MAX_TTL_SECONDS = 8 * 60 * 60;
const NONCE_BYTES = 16;
const SIGNATURE_BYTES = 64;
const MAX_TARGET_LENGTH = 4096;

class DeviceAuthError extends Error {
  constructor(code, message, status = 401) {
    super(message);
    this.name = 'DeviceAuthError';
    this.code = code;
    this.status = status;
  }
}

function isUuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function decodeBase64Url(value, expectedBytes, fieldName) {
  if (typeof value !== 'string' || !value || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new DeviceAuthError('AUTH_INVALID', `${fieldName} non valido.`);
  }

  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== expectedBytes || bytes.toString('base64url') !== value) {
    throw new DeviceAuthError('AUTH_INVALID', `${fieldName} non valido.`);
  }
  return bytes;
}

function normalizeMethod(value) {
  const method = String(value || '').trim().toUpperCase();
  if (!['GET', 'HEAD', 'POST', 'PUT'].includes(method)) {
    throw new DeviceAuthError('AUTH_INVALID', 'Metodo richiesta non autorizzabile.');
  }
  return method;
}

function normalizeTarget(value) {
  const target = String(value || '');
  if (!target.startsWith('/api/') || target.length > MAX_TARGET_LENGTH || /[\r\n]/.test(target)) {
    throw new DeviceAuthError('AUTH_INVALID', 'Percorso richiesta non valido.');
  }
  return target;
}

function publicKeyObject(publicKey) {
  const keyBytes = decodeBase64Url(publicKey, 32, 'Chiave pubblica dispositivo');
  return crypto.createPublicKey({
    key: {
      kty: 'OKP',
      crv: 'Ed25519',
      x: keyBytes.toString('base64url'),
    },
    format: 'jwk',
  });
}

function requestProofMessage({ deviceId, timestamp, nonce, method, target }) {
  return Buffer.from([
    REQUEST_CONTEXT,
    deviceId,
    String(timestamp),
    nonce,
    normalizeMethod(method),
    normalizeTarget(target),
  ].join('\n'), 'utf8');
}

function mediaProofMessage({ deviceId, expires, path }) {
  return Buffer.from([
    MEDIA_CONTEXT,
    deviceId,
    String(expires),
    'GET',
    normalizeTarget(path),
  ].join('\n'), 'utf8');
}

function loadActiveDevice(db, deviceId) {
  ensurePairingSchema(db);
  if (!isUuid(deviceId)) {
    throw new DeviceAuthError('AUTH_INVALID', 'ID dispositivo non valido.');
  }

  const row = db.prepare(`
    SELECT id, public_key, fingerprint, installation_id, device_name,
           paired_at, last_seen_at, revoked_at, active_account_id,
           active_account_auth_version, account_authenticated_at, account_binding_source
    FROM paired_devices
    WHERE id = ?
    LIMIT 1
  `).get(deviceId);

  if (!row) {
    throw new DeviceAuthError('DEVICE_UNKNOWN', 'Dispositivo non associato al server.');
  }
  if (row.revoked_at !== null) {
    throw new DeviceAuthError('DEVICE_REVOKED', 'Questo dispositivo è stato revocato.', 403);
  }

  return {
    id: row.id,
    publicKey: row.public_key,
    fingerprint: row.fingerprint,
    installationId: row.installation_id,
    deviceName: row.device_name,
    pairedAt: Number(row.paired_at),
    lastSeenAt: Number(row.last_seen_at),
    activeAccountId: row.active_account_id,
    activeAccountAuthVersion: row.active_account_auth_version === null
      ? null
      : Number(row.active_account_auth_version),
    accountAuthenticatedAt: row.account_authenticated_at === null
      ? null
      : Number(row.account_authenticated_at),
    accountBindingSource: row.account_binding_source,
  };
}

function verifyEd25519(publicKey, message, signature) {
  const signatureBytes = decodeBase64Url(signature, SIGNATURE_BYTES, 'Firma dispositivo');
  try {
    return crypto.verify(null, message, publicKeyObject(publicKey), signatureBytes);
  } catch {
    return false;
  }
}

function cleanReplayCache(cache, nowSeconds) {
  for (const [key, expires] of cache) {
    if (expires < nowSeconds) cache.delete(key);
  }
}

function verifyRequestAuthorization(db, auth, {
  method,
  target,
  nowSeconds = Math.floor(Date.now() / 1000),
  replayCache = new Map(),
} = {}) {
  const deviceId = String(auth?.deviceId || '');
  const timestamp = Number(auth?.timestamp);
  const nonce = String(auth?.nonce || '');
  const signature = String(auth?.signature || '');

  if (!Number.isSafeInteger(timestamp)) {
    throw new DeviceAuthError('AUTH_INVALID', 'Timestamp dispositivo non valido.');
  }
  if (Math.abs(nowSeconds - timestamp) > REQUEST_CLOCK_SKEW_SECONDS) {
    throw new DeviceAuthError('AUTH_EXPIRED', 'Autorizzazione dispositivo scaduta.');
  }
  decodeBase64Url(nonce, NONCE_BYTES, 'Nonce dispositivo');

  const device = loadActiveDevice(db, deviceId);
  const message = requestProofMessage({ deviceId, timestamp, nonce, method, target });
  if (!verifyEd25519(device.publicKey, message, signature)) {
    throw new DeviceAuthError('AUTH_INVALID', 'Firma dispositivo non valida.');
  }

  cleanReplayCache(replayCache, nowSeconds);
  const replayKey = `${deviceId}:${nonce}`;
  if (replayCache.has(replayKey)) {
    throw new DeviceAuthError('AUTH_REPLAY', 'Autorizzazione dispositivo già utilizzata.');
  }
  replayCache.set(replayKey, timestamp + REQUEST_CLOCK_SKEW_SECONDS);
  return device;
}

function isAuthorizedMediaPath(pathname) {
  const path = String(pathname || '');
  return /^\/api\/movies\/\d+\/(?:stream|poster)$/.test(path)
    || /^\/api\/series\/[^/]+\/poster$/.test(path)
    || /^\/api\/metadata\/items\/\d+\/automatic-poster$/.test(path)
    || /^\/api\/reading\/\d+\/(?:file|cover)$/.test(path)
    || /^\/api\/reading\/\d+\/reader\/entry\/\d+$/.test(path)
    || /^\/api\/music\/albums\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/cover$/i.test(path)
    || /^\/api\/music\/tracks\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/stream$/i.test(path);
}

function verifyMediaAuthorization(db, auth, {
  path,
  nowSeconds = Math.floor(Date.now() / 1000),
} = {}) {
  const deviceId = String(auth?.deviceId || '');
  const expires = Number(auth?.expires);
  const signature = String(auth?.signature || '');
  const normalizedPath = normalizeTarget(path);

  if (!isAuthorizedMediaPath(normalizedPath)) {
    throw new DeviceAuthError('AUTH_INVALID', 'Risorsa multimediale non autorizzabile.');
  }
  if (!Number.isSafeInteger(expires) || expires < nowSeconds) {
    throw new DeviceAuthError('AUTH_EXPIRED', 'URL multimediale scaduto.');
  }
  if (expires - nowSeconds > MEDIA_MAX_TTL_SECONDS + REQUEST_CLOCK_SKEW_SECONDS) {
    throw new DeviceAuthError('AUTH_INVALID', 'Durata URL multimediale non valida.');
  }

  const device = loadActiveDevice(db, deviceId);
  const message = mediaProofMessage({ deviceId, expires, path: normalizedPath });
  if (!verifyEd25519(device.publicKey, message, signature)) {
    throw new DeviceAuthError('AUTH_INVALID', 'Firma URL multimediale non valida.');
  }
  return device;
}

module.exports = {
  REQUEST_CONTEXT,
  MEDIA_CONTEXT,
  REQUEST_CLOCK_SKEW_SECONDS,
  MEDIA_MAX_TTL_SECONDS,
  DeviceAuthError,
  requestProofMessage,
  mediaProofMessage,
  verifyRequestAuthorization,
  verifyMediaAuthorization,
  isAuthorizedMediaPath,
};
