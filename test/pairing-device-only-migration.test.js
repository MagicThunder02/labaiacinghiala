'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const {
  migratePairingSchemaToDeviceOnly,
  redeemPairingInvite,
  pairingProofMessage,
} = require('../src/services/pairing-service');
const { ensureAccountSchema, createAccount } = require('../src/services/account-service');

function legacyDatabase() {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  db.exec(`
    CREATE TABLE pairing_invites (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      profile_key TEXT NOT NULL,
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
      profile_key TEXT NOT NULL,
      paired_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      revoked_at INTEGER,
      pairing_invite_id TEXT,
      FOREIGN KEY (pairing_invite_id) REFERENCES pairing_invites(id) ON DELETE SET NULL
    );
  `);
  ensureAccountSchema(db);
  return db;
}

function columns(db, tableName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().map((column) => column.name);
}

test('migrazione device-only conserva inviti, dispositivi e binding eliminando il profilo dal pairing', () => {
  const db = legacyDatabase();
  const account = createAccount(db, {
    accountKey: 'pietro-data',
    username: 'pietro',
    passwordHash: 'scrypt$fixture',
    role: 'admin',
  });
  const inviteId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO pairing_invites (id, token_hash, profile_key, expires_at, used_at, created_at)
    VALUES (?, ?, ?, ?, NULL, ?)
  `).run(inviteId, 'a'.repeat(64), 'vecchio-profilo', 9_000_000, 1_000_000);
  const deviceId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO paired_devices (
      id, public_key, fingerprint, installation_id, device_name, profile_key,
      paired_at, last_seen_at, revoked_at, pairing_invite_id,
      active_account_id, active_account_auth_version,
      account_authenticated_at, account_binding_source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
  `).run(
    deviceId,
    crypto.randomBytes(32).toString('base64url'),
    'SHA256:fixture',
    crypto.randomUUID(),
    'PC esistente',
    'vecchio-profilo',
    2_000_000,
    2_100_000,
    inviteId,
    account.id,
    1,
    2_050_000,
    'login',
  );

  assert.equal(migratePairingSchemaToDeviceOnly(db), true);
  assert.equal(migratePairingSchemaToDeviceOnly(db), false);
  assert.equal(columns(db, 'pairing_invites').includes('profile_key'), false);
  assert.equal(columns(db, 'paired_devices').includes('profile_key'), false);

  assert.deepEqual({ ...db.prepare(`
    SELECT id, token_hash, expires_at, used_at, created_at
    FROM pairing_invites WHERE id = ?
  `).get(inviteId) }, {
    id: inviteId,
    token_hash: 'a'.repeat(64),
    expires_at: 9_000_000,
    used_at: null,
    created_at: 1_000_000,
  });
  assert.deepEqual({ ...db.prepare(`
    SELECT id, device_name, pairing_invite_id, active_account_id,
           active_account_auth_version, account_authenticated_at,
           account_binding_source, revoked_at
    FROM paired_devices WHERE id = ?
  `).get(deviceId) }, {
    id: deviceId,
    device_name: 'PC esistente',
    pairing_invite_id: inviteId,
    active_account_id: account.id,
    active_account_auth_version: 1,
    account_authenticated_at: 2_050_000,
    account_binding_source: 'login',
    revoked_at: null,
  });
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.equal(
    db.prepare("PRAGMA foreign_key_list(paired_devices)").all()
      .some((row) => row.table === 'pairing_invites'),
    true,
  );
  db.close();
});

test('un invito legacy ancora pendente resta riscattabile come invito del solo dispositivo', () => {
  const db = legacyDatabase();
  const inviteId = crypto.randomUUID();
  const secret = crypto.randomBytes(32);
  const inviteToken = `baia1.${inviteId}.${secret.toString('base64url')}`;
  db.prepare(`
    INSERT INTO pairing_invites (id, token_hash, profile_key, expires_at, used_at, created_at)
    VALUES (?, ?, ?, ?, NULL, ?)
  `).run(
    inviteId,
    crypto.createHash('sha256').update(secret).digest('hex'),
    'account-che-non-va-collegato',
    5_000_000,
    1_000_000,
  );
  migratePairingSchemaToDeviceOnly(db);

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyText = publicKey.export({ format: 'jwk' }).x;
  const installationId = crypto.randomUUID();
  const signature = crypto.sign(null, pairingProofMessage({
    inviteToken,
    installationId,
    publicKey: publicKeyText,
  }), privateKey).toString('base64url');

  const paired = redeemPairingInvite(db, {
    inviteToken,
    installationId,
    publicKey: publicKeyText,
    signature,
    deviceName: 'Nuovo PC',
  }, { now: 2_000_000 });

  const row = db.prepare(`
    SELECT active_account_id, account_binding_source
    FROM paired_devices WHERE id = ?
  `).get(paired.id);
  assert.equal(row.active_account_id, null);
  assert.equal(row.account_binding_source, null);
  assert.equal(paired.profileKey, 'default');
  db.close();
});
