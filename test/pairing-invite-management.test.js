'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const {
  PairingError,
  ensurePairingSchema,
  migratePairingInvitesToRevocable,
  createPairingInvite,
  listPairingInvites,
  revokePairingInvite,
  redeemPairingInvite,
  pairingProofMessage,
} = require('../src/services/pairing-service');

function newDb() {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  ensurePairingSchema(db);
  return db;
}

function newDevice() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ format: 'jwk' }).x,
    privateKey,
  };
}

function signedPayload(inviteToken, device, {
  installationId = crypto.randomUUID(),
  deviceName = 'PC invitato',
} = {}) {
  const message = pairingProofMessage({
    inviteToken,
    installationId,
    publicKey: device.publicKey,
  });
  return {
    inviteToken,
    installationId,
    publicKey: device.publicKey,
    signature: crypto.sign(null, message, device.privateKey).toString('base64url'),
    deviceName,
  };
}

test('migrazione inviti revocabili aggiunge revoked_at senza perdere gli inviti esistenti', () => {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  db.exec(`
    CREATE TABLE pairing_invites (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE paired_devices (
      id TEXT PRIMARY KEY,
      public_key TEXT NOT NULL UNIQUE,
      fingerprint TEXT NOT NULL UNIQUE,
      installation_id TEXT NOT NULL,
      device_name TEXT NOT NULL,
      paired_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      revoked_at INTEGER,
      pairing_invite_id TEXT,
      FOREIGN KEY (pairing_invite_id) REFERENCES pairing_invites(id) ON DELETE SET NULL
    );
  `);
  const inviteId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO pairing_invites (id, token_hash, expires_at, used_at, created_at)
    VALUES (?, ?, ?, NULL, ?)
  `).run(inviteId, 'a'.repeat(64), 2_000, 1_000);

  assert.equal(migratePairingInvitesToRevocable(db), true);
  assert.equal(migratePairingInvitesToRevocable(db), false);
  const columns = db.prepare('PRAGMA table_info(pairing_invites)').all().map((row) => row.name);
  const row = db.prepare('SELECT id, revoked_at FROM pairing_invites').get();
  assert.equal(columns.includes('revoked_at'), true);
  assert.deepEqual({ ...row }, { id: inviteId, revoked_at: null });
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();
});

test('elenco inviti espone stati e dispositivo senza token o hash', () => {
  const db = newDb();
  const now = 1_000_000;
  const active = createPairingInvite(db, { ttlMinutes: 15, now });
  const expired = createPairingInvite(db, { ttlMinutes: 1, now: now - 120_000 });
  const revoked = createPairingInvite(db, { ttlMinutes: 15, now: now - 10_000 });
  revokePairingInvite(db, revoked.inviteId, { now });
  const used = createPairingInvite(db, { ttlMinutes: 15, now: now - 5_000 });
  redeemPairingInvite(db, signedPayload(used.token, newDevice()), { now: now + 1_000 });

  const invites = listPairingInvites(db, { now: now + 2_000 });
  const byId = new Map(invites.map((invite) => [invite.id, invite]));
  assert.equal(byId.get(active.inviteId).status, 'active');
  assert.equal(byId.get(expired.inviteId).status, 'expired');
  assert.equal(byId.get(revoked.inviteId).status, 'revoked');
  assert.equal(byId.get(used.inviteId).status, 'used');
  assert.equal(byId.get(used.inviteId).device.deviceName, 'PC invitato');
  assert.equal(JSON.stringify(invites).includes('token'), false);
  assert.equal(JSON.stringify(invites).includes('token_hash'), false);
  assert.equal(JSON.stringify(invites).includes(used.token), false);
  assert.throws(
    () => revokePairingInvite(db, used.inviteId, { now: now + 2_000 }),
    (error) => error instanceof PairingError && error.code === 'INVITE_NOT_ACTIVE',
  );
  assert.throws(
    () => revokePairingInvite(db, expired.inviteId, { now: now + 2_000 }),
    (error) => error instanceof PairingError && error.code === 'INVITE_NOT_ACTIVE',
  );
  db.close();
});

test('un invito revocato non può essere riscattato e non può essere revocato due volte', () => {
  const db = newDb();
  const invite = createPairingInvite(db, { ttlMinutes: 15, now: 2_000_000 });
  const revoked = revokePairingInvite(db, invite.inviteId, { now: 2_010_000 });
  assert.equal(revoked.status, 'revoked');

  assert.throws(
    () => redeemPairingInvite(db, signedPayload(invite.token, newDevice()), { now: 2_020_000 }),
    (error) => error instanceof PairingError && error.code === 'INVITE_INVALID',
  );
  assert.throws(
    () => revokePairingInvite(db, invite.inviteId, { now: 2_030_000 }),
    (error) => error instanceof PairingError && error.code === 'INVITE_NOT_ACTIVE' && error.status === 409,
  );
  db.close();
});
