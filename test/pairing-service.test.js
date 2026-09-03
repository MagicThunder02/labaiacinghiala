const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const {
  PairingError,
  ensurePairingSchema,
  createPairingInvite,
  redeemPairingInvite,
  listPairedDevices,
  revokePairedDevice,
  pairingProofMessage,
} = require('../src/services/pairing-service');
const { ensureAccountSchema, createAccount } = require('../src/services/account-service');

function newDb() {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  ensurePairingSchema(db);
  return db;
}

function newDevice() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicJwk = publicKey.export({ format: 'jwk' });
  return { publicKey: publicJwk.x, privateKey };
}

function signedPayload(inviteToken, device, {
  installationId = crypto.randomUUID(),
  deviceName = 'PC test',
} = {}) {
  const message = pairingProofMessage({
    inviteToken,
    installationId,
    publicKey: device.publicKey,
  });
  const signature = crypto.sign(null, message, device.privateKey).toString('base64url');
  return {
    inviteToken,
    installationId,
    publicKey: device.publicKey,
    signature,
    deviceName,
  };
}

function assertPairingCode(fn, code) {
  assert.throws(fn, (error) => error instanceof PairingError && error.code === code);
}

test('crea un invito monouso senza salvare il bearer secret nel database', () => {
  const db = newDb();
  const invite = createPairingInvite(db, { profileKey: 'ignorato', ttlMinutes: 10, now: 1_000_000 });
  const row = db.prepare('SELECT id, token_hash, expires_at FROM pairing_invites').get();

  assert.match(invite.token, /^baia1\.[0-9a-f-]+\.[A-Za-z0-9_-]+$/i);
  assert.equal(row.id, invite.inviteId);
  assert.equal(Object.hasOwn(invite, 'profileKey'), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('pairing_invites') WHERE name = 'profile_key'").get().count, 0);
  assert.equal(row.expires_at, 1_600_000);
  assert.equal(typeof row.token_hash, 'string');
  assert.equal(row.token_hash.length, 64);
  assert.equal(JSON.stringify(row).includes(invite.token), false);
  db.close();
});

test('associa un dispositivo solo con invito valido e prova Ed25519 corretta', () => {
  const db = newDb();
  const invite = createPairingInvite(db, { ttlMinutes: 15, now: 2_000_000 });
  const device = newDevice();
  const payload = signedPayload(invite.token, device);

  const paired = redeemPairingInvite(db, payload, { now: 2_100_000 });
  assert.equal(paired.publicKey, device.publicKey);
  assert.equal(paired.deviceName, 'PC test');
  assert.equal(paired.profileKey, 'default'); // shim temporaneo per i client pre-Step 7
  assert.match(paired.fingerprint, /^SHA256:/);

  const inviteRow = db.prepare('SELECT used_at FROM pairing_invites WHERE id = ?').get(invite.inviteId);
  assert.equal(inviteRow.used_at, 2_100_000);
  const listed = listPairedDevices(db);
  assert.equal(listed.length, 1);
  assert.equal(Object.hasOwn(listed[0], 'profileKey'), false);
  db.close();
});

test('un invito usato non può essere riutilizzato', () => {
  const db = newDb();
  const invite = createPairingInvite(db, { now: 3_000_000 });
  const first = newDevice();
  const second = newDevice();
  redeemPairingInvite(db, signedPayload(invite.token, first), { now: 3_010_000 });

  assertPairingCode(
    () => redeemPairingInvite(db, signedPayload(invite.token, second), { now: 3_020_000 }),
    'INVITE_INVALID',
  );
  const listed = listPairedDevices(db);
  assert.equal(listed.length, 1);
  assert.equal(Object.hasOwn(listed[0], 'profileKey'), false);
  db.close();
});

test('rifiuta una firma non prodotta dalla chiave pubblica dichiarata', () => {
  const db = newDb();
  const invite = createPairingInvite(db, { now: 4_000_000 });
  const claimed = newDevice();
  const attacker = newDevice();
  const installationId = crypto.randomUUID();
  const message = pairingProofMessage({
    inviteToken: invite.token,
    installationId,
    publicKey: claimed.publicKey,
  });
  const signature = crypto.sign(null, message, attacker.privateKey).toString('base64url');

  assertPairingCode(() => redeemPairingInvite(db, {
    inviteToken: invite.token,
    installationId,
    publicKey: claimed.publicKey,
    signature,
    deviceName: 'falso',
  }, { now: 4_010_000 }), 'PROOF_INVALID');

  const inviteRow = db.prepare('SELECT used_at FROM pairing_invites WHERE id = ?').get(invite.inviteId);
  assert.equal(inviteRow.used_at, null);
  db.close();
});

test('rifiuta un invito scaduto senza consumarlo', () => {
  const db = newDb();
  const invite = createPairingInvite(db, { ttlMinutes: 1, now: 5_000_000 });
  const device = newDevice();

  assertPairingCode(
    () => redeemPairingInvite(db, signedPayload(invite.token, device), { now: 5_060_001 }),
    'INVITE_INVALID',
  );
  const row = db.prepare('SELECT used_at FROM pairing_invites WHERE id = ?').get(invite.inviteId);
  assert.equal(row.used_at, null);
  db.close();
});

test('la revoca disattiva il dispositivo e un nuovo invito consente il re-pairing della stessa chiave', () => {
  const db = newDb();
  const device = newDevice();
  const installationId = crypto.randomUUID();
  const firstInvite = createPairingInvite(db, { now: 6_000_000 });
  const first = redeemPairingInvite(
    db,
    signedPayload(firstInvite.token, device, { installationId }),
    { now: 6_010_000 },
  );

  revokePairedDevice(db, first.id, { now: 6_020_000 });
  assert.notEqual(listPairedDevices(db)[0].revokedAt, null);

  const secondInvite = createPairingInvite(db, { now: 6_030_000 });
  const second = redeemPairingInvite(
    db,
    signedPayload(secondInvite.token, device, { installationId, deviceName: 'PC ripristinato' }),
    { now: 6_040_000 },
  );

  assert.equal(second.id, first.id);
  const devices = listPairedDevices(db);
  assert.equal(devices.length, 1);
  assert.equal(devices[0].revokedAt, null);
  assert.equal(devices[0].deviceName, 'PC ripristinato');
  db.close();
});


test('revoca e re-pairing eliminano ogni binding account precedente dal dispositivo', () => {
  const db = newDb();
  ensureAccountSchema(db);
  const account = createAccount(db, {
    username: 'account-test',
    passwordHash: 'scrypt$fixture',
  });
  const device = newDevice();
  const installationId = crypto.randomUUID();
  const firstInvite = createPairingInvite(db, { now: 7_000_000 });
  const paired = redeemPairingInvite(
    db,
    signedPayload(firstInvite.token, device, { installationId }),
    { now: 7_010_000 },
  );
  db.prepare(`
    UPDATE paired_devices SET
      active_account_id = ?, active_account_auth_version = 1,
      account_authenticated_at = ?, account_binding_source = 'login'
    WHERE id = ?
  `).run(account.id, 7_015_000, paired.id);

  revokePairedDevice(db, paired.id, { now: 7_020_000 });
  let row = db.prepare(`
    SELECT active_account_id, active_account_auth_version,
           account_authenticated_at, account_binding_source
    FROM paired_devices WHERE id = ?
  `).get(paired.id);
  assert.deepEqual({ ...row }, {
    active_account_id: null,
    active_account_auth_version: null,
    account_authenticated_at: null,
    account_binding_source: null,
  });

  // Anche un eventuale binding residuo su una riga revocata viene azzerato dal re-pairing.
  db.prepare(`
    UPDATE paired_devices SET
      active_account_id = ?, active_account_auth_version = 1,
      account_authenticated_at = ?, account_binding_source = 'legacy'
    WHERE id = ?
  `).run(account.id, 7_025_000, paired.id);
  const secondInvite = createPairingInvite(db, { now: 7_030_000 });
  redeemPairingInvite(
    db,
    signedPayload(secondInvite.token, device, { installationId }),
    { now: 7_040_000 },
  );
  row = db.prepare(`
    SELECT revoked_at, active_account_id, active_account_auth_version,
           account_authenticated_at, account_binding_source
    FROM paired_devices WHERE id = ?
  `).get(paired.id);
  assert.deepEqual({ ...row }, {
    revoked_at: null,
    active_account_id: null,
    active_account_auth_version: null,
    account_authenticated_at: null,
    account_binding_source: null,
  });
  db.close();
});
