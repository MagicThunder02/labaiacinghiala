const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const {
  DeviceAuthError,
  requestProofMessage,
  mediaProofMessage,
  verifyRequestAuthorization,
  verifyMediaAuthorization,
  isAuthorizedMediaPath,
} = require('../src/services/device-auth-service');
const { ensurePairingSchema } = require('../src/services/pairing-service');
const { ensureAccountSchema } = require('../src/services/account-service');
const { getProfileKey } = require('../src/utils/profile-key');

function fixture() {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  ensurePairingSchema(db);
  ensureAccountSchema(db);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  const now = 1_700_000_000_000;
  const device = {
    id: crypto.randomUUID(),
    publicKey: jwk.x,
  };
  db.prepare(`
    INSERT INTO paired_devices (
      id, public_key, fingerprint, installation_id, device_name,
      paired_at, last_seen_at, revoked_at, pairing_invite_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
  `).run(
    device.id,
    device.publicKey,
    'SHA256:test',
    crypto.randomUUID(),
    'PC test',
    now,
    now,
  );
  return { db, privateKey, device };
}

function signedRequest(privateKey, deviceId, { nowSeconds, nonce, method, target }) {
  const message = requestProofMessage({
    deviceId,
    timestamp: nowSeconds,
    nonce,
    method,
    target,
  });
  return {
    deviceId,
    timestamp: nowSeconds,
    nonce,
    signature: crypto.sign(null, message, privateKey).toString('base64url'),
  };
}

test('autentica una richiesta firmata e impedisce il replay del nonce', () => {
  const { db, privateKey, device } = fixture();
  const nowSeconds = 1_700_000_000;
  const nonce = crypto.randomBytes(16).toString('base64url');
  const auth = signedRequest(privateKey, device.id, {
    nowSeconds,
    nonce,
    method: 'GET',
    target: '/api/movies?limit=10',
  });
  const replayCache = new Map();

  const verified = verifyRequestAuthorization(db, auth, {
    method: 'GET',
    target: '/api/movies?limit=10',
    nowSeconds,
    replayCache,
  });
  assert.equal(verified.id, device.id);
  assert.equal(Object.hasOwn(verified, 'profileKey'), false);

  assert.throws(
    () => verifyRequestAuthorization(db, auth, {
      method: 'GET',
      target: '/api/movies?limit=10',
      nowSeconds,
      replayCache,
    }),
    (error) => error instanceof DeviceAuthError && error.code === 'AUTH_REPLAY',
  );
  db.close();
});

test('firma metodo e query: una richiesta modificata viene rifiutata', () => {
  const { db, privateKey, device } = fixture();
  const nowSeconds = 1_700_000_000;
  const auth = signedRequest(privateKey, device.id, {
    nowSeconds,
    nonce: crypto.randomBytes(16).toString('base64url'),
    method: 'GET',
    target: '/api/movies?limit=10',
  });

  assert.throws(
    () => verifyRequestAuthorization(db, auth, {
      method: 'GET',
      target: '/api/movies?limit=50',
      nowSeconds,
      replayCache: new Map(),
    }),
    (error) => error instanceof DeviceAuthError && error.code === 'AUTH_INVALID',
  );
  db.close();
});

test('la revoca blocca immediatamente una richiesta firmata valida', () => {
  const { db, privateKey, device } = fixture();
  const nowSeconds = 1_700_000_000;
  db.prepare('UPDATE paired_devices SET revoked_at = ? WHERE id = ?').run(nowSeconds * 1000, device.id);
  const auth = signedRequest(privateKey, device.id, {
    nowSeconds,
    nonce: crypto.randomBytes(16).toString('base64url'),
    method: 'GET',
    target: '/api/movies',
  });

  assert.throws(
    () => verifyRequestAuthorization(db, auth, {
      method: 'GET',
      target: '/api/movies',
      nowSeconds,
      replayCache: new Map(),
    }),
    (error) => error instanceof DeviceAuthError && error.code === 'DEVICE_REVOKED' && error.status === 403,
  );
  db.close();
});

test('allowlist media Node resta allineata al Core per Reading e Musica', () => {
  assert.equal(isAuthorizedMediaPath('/api/reading/21/file'), true);
  assert.equal(isAuthorizedMediaPath('/api/reading/21/cover'), true);
  assert.equal(isAuthorizedMediaPath('/api/reading/21/reader/entry/0'), true);
  assert.equal(isAuthorizedMediaPath('/api/reading/21/reader/manifest'), false);
  assert.equal(isAuthorizedMediaPath('/api/reading/21/reader/entry/not-a-number'), false);
  assert.equal(isAuthorizedMediaPath('/api/reading/21/bookmark'), false);
  assert.equal(isAuthorizedMediaPath('/api/reading/not-a-number/cover'), false);

  assert.equal(
    isAuthorizedMediaPath('/api/music/tracks/123e4567-e89b-42d3-a456-426614174000/stream'),
    true,
  );
  assert.equal(
    isAuthorizedMediaPath('/api/music/albums/123e4567-e89b-42d3-a456-426614174000/cover'),
    true,
  );
  assert.equal(isAuthorizedMediaPath('/api/music/albums/not-a-uuid/cover'), false);
  assert.equal(
    isAuthorizedMediaPath('/api/music/albums/123e4567-e89b-42d3-a456-426614174000/file'),
    false,
  );
  assert.equal(isAuthorizedMediaPath('/api/music/tracks/not-a-uuid/stream'), false);
  assert.equal(
    isAuthorizedMediaPath('/api/music/tracks/123e4567-e89b-42d3-a456-426614174000/file'),
    false,
  );
});

test('URL multimediale firmato consente Range multipli ma scade e rispetta la revoca', () => {
  const { db, privateKey, device } = fixture();
  const nowSeconds = 1_700_000_000;
  const expires = nowSeconds + 3600;
  const path = '/api/movies/42/stream';
  const signature = crypto.sign(
    null,
    mediaProofMessage({ deviceId: device.id, expires, path }),
    privateKey,
  ).toString('base64url');
  const auth = { deviceId: device.id, expires, signature };

  assert.equal(verifyMediaAuthorization(db, auth, { path, nowSeconds }).id, device.id);
  assert.equal(verifyMediaAuthorization(db, auth, { path, nowSeconds: nowSeconds + 10 }).id, device.id);
  assert.throws(
    () => verifyMediaAuthorization(db, auth, { path, nowSeconds: expires + 1 }),
    (error) => error instanceof DeviceAuthError && error.code === 'AUTH_EXPIRED',
  );

  db.prepare('UPDATE paired_devices SET revoked_at = ? WHERE id = ?').run((nowSeconds + 20) * 1000, device.id);
  assert.throws(
    () => verifyMediaAuthorization(db, auth, { path, nowSeconds: nowSeconds + 20 }),
    (error) => error instanceof DeviceAuthError && error.code === 'DEVICE_REVOKED',
  );
  db.close();
});

test('il profilo dati deriva esclusivamente dall account autenticato', () => {
  assert.equal(getProfileKey({ baiaAccount: { accountKey: 'Pietro-Data' } }), 'pietro-data');
  assert.throws(() => getProfileKey({
    baiaDevice: { profileKey: 'vecchio-device' },
    get() { return 'header-falso'; },
  }), /Account Baia non risolto/);
});
