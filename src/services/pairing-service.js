const crypto = require('node:crypto');
const INVITE_PREFIX = 'baia1';
const DEFAULT_INVITE_MINUTES = 15;
const MAX_INVITE_MINUTES = 24 * 60;
const PUBLIC_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
const MAX_DEVICE_NAME_LENGTH = 80;
const PAIRING_CONTEXT = 'BAIA-PAIR-V1';

class PairingError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'PairingError';
    this.code = code;
    this.status = status;
  }
}

function tableColumns(db, tableName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all();
}

function hasColumn(db, tableName, columnName) {
  return tableColumns(db, tableName).some((column) => column.name === columnName);
}

function ensurePairingSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pairing_invites (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      revoked_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS paired_devices (
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

    CREATE INDEX IF NOT EXISTS idx_pairing_invites_expires_at
      ON pairing_invites(expires_at);
    CREATE INDEX IF NOT EXISTS idx_paired_devices_installation_id
      ON paired_devices(installation_id);
  `);
}

function ensurePairingInviteManagementSchema(db) {
  ensurePairingSchema(db);
  if (!hasColumn(db, 'pairing_invites', 'revoked_at')) {
    db.exec('ALTER TABLE pairing_invites ADD COLUMN revoked_at INTEGER');
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_pairing_invites_status
      ON pairing_invites(used_at, revoked_at, expires_at);
  `);
}

function migratePairingInvitesToRevocable(db) {
  ensurePairingSchema(db);
  if (hasColumn(db, 'pairing_invites', 'revoked_at')) {
    ensurePairingInviteManagementSchema(db);
    return false;
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('ALTER TABLE pairing_invites ADD COLUMN revoked_at INTEGER');
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_pairing_invites_status
        ON pairing_invites(used_at, revoked_at, expires_at);
    `);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw new Error(`Migrazione degli inviti revocabili non riuscita: ${error.message}`);
  }
  return true;
}

function migratePairingSchemaToDeviceOnly(db) {
  ensurePairingSchema(db);
  const inviteHasProfile = hasColumn(db, 'pairing_invites', 'profile_key');
  const deviceHasProfile = hasColumn(db, 'paired_devices', 'profile_key');
  if (!inviteHasProfile && !deviceHasProfile) return false;

  const existingDeviceColumns = new Set(tableColumns(db, 'paired_devices').map((column) => column.name));
  const accountColumnSource = (columnName) => existingDeviceColumns.has(columnName) ? columnName : 'NULL';
  const foreignKeysEnabled = Number(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys || 0) === 1;
  if (foreignKeysEnabled) db.exec('PRAGMA foreign_keys = OFF');

  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      DROP TABLE IF EXISTS pairing_invites_device_only;
      DROP TABLE IF EXISTS paired_devices_device_only;

      CREATE TABLE pairing_invites_device_only (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        revoked_at INTEGER,
        created_at INTEGER NOT NULL
      );

      INSERT INTO pairing_invites_device_only (id, token_hash, expires_at, used_at, revoked_at, created_at)
      SELECT id, token_hash, expires_at, used_at, NULL, created_at
      FROM pairing_invites;

      CREATE TABLE paired_devices_device_only (
        id TEXT PRIMARY KEY,
        public_key TEXT NOT NULL UNIQUE,
        fingerprint TEXT NOT NULL UNIQUE,
        installation_id TEXT NOT NULL,
        device_name TEXT NOT NULL,
        paired_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        revoked_at INTEGER,
        pairing_invite_id TEXT,
        active_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
        active_account_auth_version INTEGER,
        account_authenticated_at INTEGER,
        account_binding_source TEXT CHECK (
          account_binding_source IS NULL OR account_binding_source IN ('legacy', 'login', 'admin')
        ),
        FOREIGN KEY (pairing_invite_id) REFERENCES pairing_invites_device_only(id) ON DELETE SET NULL
      );
    `);

    db.exec(`
      INSERT INTO paired_devices_device_only (
        id, public_key, fingerprint, installation_id, device_name,
        paired_at, last_seen_at, revoked_at, pairing_invite_id,
        active_account_id, active_account_auth_version,
        account_authenticated_at, account_binding_source
      )
      SELECT
        id, public_key, fingerprint, installation_id, device_name,
        paired_at, last_seen_at, revoked_at, pairing_invite_id,
        ${accountColumnSource('active_account_id')},
        ${accountColumnSource('active_account_auth_version')},
        ${accountColumnSource('account_authenticated_at')},
        ${accountColumnSource('account_binding_source')}
      FROM paired_devices;
    `);

    db.exec(`
      DROP TABLE paired_devices;
      DROP TABLE pairing_invites;
      ALTER TABLE pairing_invites_device_only RENAME TO pairing_invites;
      ALTER TABLE paired_devices_device_only RENAME TO paired_devices;
    `);

    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length) {
      throw new Error('La migrazione del pairing ha prodotto riferimenti non validi.');
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw new Error(`Migrazione del pairing device-only non riuscita: ${error.message}`);
  } finally {
    if (foreignKeysEnabled) db.exec('PRAGMA foreign_keys = ON');
  }

  ensurePairingSchema(db);
  return true;
}

function pairedDeviceAccountColumns(db) {
  const columns = tableColumns(db, 'paired_devices');
  const names = new Set(columns.map((column) => column.name));
  return [
    'active_account_id',
    'active_account_auth_version',
    'account_authenticated_at',
    'account_binding_source',
  ].every((name) => names.has(name));
}

function accountBindingResetSql(db) {
  return pairedDeviceAccountColumns(db)
    ? `, active_account_id = NULL,
         active_account_auth_version = NULL,
         account_authenticated_at = NULL,
         account_binding_source = NULL`
    : '';
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function decodeBase64Url(value, expectedBytes, fieldName) {
  if (typeof value !== 'string' || !value || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new PairingError('INVALID_REQUEST', `${fieldName} non valido.`);
  }

  let bytes;
  try {
    bytes = Buffer.from(value, 'base64url');
  } catch {
    throw new PairingError('INVALID_REQUEST', `${fieldName} non valido.`);
  }

  if (bytes.length !== expectedBytes || bytes.toString('base64url') !== value) {
    throw new PairingError('INVALID_REQUEST', `${fieldName} non valido.`);
  }
  return bytes;
}

function parseInviteToken(token) {
  if (typeof token !== 'string') {
    throw new PairingError('INVITE_INVALID', 'Invito non valido o scaduto.');
  }

  const parts = token.trim().split('.');
  if (parts.length !== 3 || parts[0] !== INVITE_PREFIX) {
    throw new PairingError('INVITE_INVALID', 'Invito non valido o scaduto.');
  }

  const inviteId = parts[1];
  if (!isUuid(inviteId)) {
    throw new PairingError('INVITE_INVALID', 'Invito non valido o scaduto.');
  }

  let secret;
  try {
    secret = decodeBase64Url(parts[2], 32, 'Invito');
  } catch {
    throw new PairingError('INVITE_INVALID', 'Invito non valido o scaduto.');
  }
  return { inviteId, secret };
}

function isUuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeDeviceName(value) {
  const normalized = String(value || 'Baia device')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DEVICE_NAME_LENGTH);
  return normalized || 'Baia device';
}

function publicKeyFingerprint(publicKeyBytes) {
  return `SHA256:${crypto.createHash('sha256').update(publicKeyBytes).digest('base64url')}`;
}

function pairingProofMessage({ inviteToken, installationId, publicKey }) {
  return Buffer.from([
    PAIRING_CONTEXT,
    inviteToken,
    installationId,
    publicKey,
  ].join('\n'), 'utf8');
}

function publicKeyObject(publicKey, publicKeyBytes) {
  return crypto.createPublicKey({
    key: {
      kty: 'OKP',
      crv: 'Ed25519',
      x: publicKey || publicKeyBytes.toString('base64url'),
    },
    format: 'jwk',
  });
}

function verifyDeviceProof({ inviteToken, installationId, publicKey, signature }) {
  if (!isUuid(installationId)) {
    throw new PairingError('INVALID_REQUEST', 'ID installazione non valido.');
  }

  const keyBytes = decodeBase64Url(publicKey, PUBLIC_KEY_BYTES, 'Chiave pubblica');
  const signatureBytes = decodeBase64Url(signature, SIGNATURE_BYTES, 'Firma');
  const message = pairingProofMessage({ inviteToken, installationId, publicKey });

  let verified = false;
  try {
    verified = crypto.verify(null, message, publicKeyObject(publicKey, keyBytes), signatureBytes);
  } catch {
    verified = false;
  }

  if (!verified) {
    throw new PairingError('PROOF_INVALID', 'Prova crittografica del dispositivo non valida.');
  }

  return {
    publicKey: keyBytes.toString('base64url'),
    fingerprint: publicKeyFingerprint(keyBytes),
  };
}

function createPairingInvite(db, {
  ttlMinutes = DEFAULT_INVITE_MINUTES,
  now = Date.now(),
} = {}) {
  ensurePairingInviteManagementSchema(db);

  const minutes = Number(ttlMinutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_INVITE_MINUTES) {
    throw new PairingError('INVALID_REQUEST', `La durata dell'invito deve essere tra 1 e ${MAX_INVITE_MINUTES} minuti.`);
  }

  const inviteId = crypto.randomUUID();
  const secret = crypto.randomBytes(32);
  const token = `${INVITE_PREFIX}.${inviteId}.${secret.toString('base64url')}`;
  const expiresAt = now + minutes * 60_000;

  db.prepare(`
    INSERT INTO pairing_invites (id, token_hash, expires_at, used_at, revoked_at, created_at)
    VALUES (?, ?, ?, NULL, NULL, ?)
  `).run(inviteId, sha256Hex(secret), expiresAt, now);

  return {
    token,
    inviteId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

function loadAndValidateInvite(db, inviteId, secret, now) {
  const invite = db.prepare(`
    SELECT id, token_hash, expires_at, used_at, revoked_at
    FROM pairing_invites
    WHERE id = ?
    LIMIT 1
  `).get(inviteId);

  if (!invite || invite.used_at !== null || invite.revoked_at !== null || Number(invite.expires_at) <= now) {
    throw new PairingError('INVITE_INVALID', 'Invito non valido o scaduto.');
  }

  const storedHash = Buffer.from(String(invite.token_hash), 'hex');
  const suppliedHash = Buffer.from(sha256Hex(secret), 'hex');
  if (storedHash.length !== suppliedHash.length || !crypto.timingSafeEqual(storedHash, suppliedHash)) {
    throw new PairingError('INVITE_INVALID', 'Invito non valido o scaduto.');
  }

  return invite;
}

function redeemPairingInvite(db, payload, { now = Date.now() } = {}) {
  ensurePairingInviteManagementSchema(db);

  const inviteToken = payload?.inviteToken;
  const installationId = payload?.installationId;
  const publicKey = payload?.publicKey;
  const signature = payload?.signature;
  const deviceName = normalizeDeviceName(payload?.deviceName);
  const { inviteId, secret } = parseInviteToken(inviteToken);

  // La firma è specifica del pairing e vincola token, installazione e chiave pubblica.
  const proof = verifyDeviceProof({ inviteToken, installationId, publicKey, signature });

  db.exec('BEGIN IMMEDIATE');
  try {
    const invite = loadAndValidateInvite(db, inviteId, secret, now);
    const existing = db.prepare(`
      SELECT id, revoked_at
      FROM paired_devices
      WHERE public_key = ?
      LIMIT 1
    `).get(proof.publicKey);

    let deviceId;
    if (existing && existing.revoked_at === null) {
      throw new PairingError('DEVICE_ALREADY_PAIRED', 'Questo dispositivo è già associato al server.');
    }

    if (existing) {
      deviceId = existing.id;
      db.prepare(`
        UPDATE paired_devices
        SET fingerprint = ?, installation_id = ?, device_name = ?,
            paired_at = ?, last_seen_at = ?, revoked_at = NULL, pairing_invite_id = ?
            ${accountBindingResetSql(db)}
        WHERE id = ?
      `).run(
        proof.fingerprint,
        installationId,
        deviceName,
        now,
        now,
        inviteId,
        deviceId,
      );
    } else {
      deviceId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO paired_devices (
          id, public_key, fingerprint, installation_id, device_name,
          paired_at, last_seen_at, revoked_at, pairing_invite_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
      `).run(
        deviceId,
        proof.publicKey,
        proof.fingerprint,
        installationId,
        deviceName,
        now,
        now,
        inviteId,
      );
    }

    const claimed = db.prepare(`
      UPDATE pairing_invites
      SET used_at = ?
      WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
    `).run(now, inviteId, now);

    if (Number(claimed.changes) !== 1) {
      throw new PairingError('INVITE_INVALID', 'Invito non valido o scaduto.');
    }

    db.exec('COMMIT');

    return {
      id: deviceId,
      deviceName,
      // Compatibilità temporanea con client pre-Step 7: il campo non ha più semantica account.
      profileKey: 'default',
      publicKey: proof.publicKey,
      fingerprint: proof.fingerprint,
      pairedAt: new Date(now).toISOString(),
    };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

function pairingInviteStatus(row, now = Date.now()) {
  if (row.used_at !== null) return 'used';
  if (row.revoked_at !== null) return 'revoked';
  if (Number(row.expires_at) <= now) return 'expired';
  return 'active';
}

function pairingInvitePublicView(row, now = Date.now()) {
  return {
    id: row.id,
    status: pairingInviteStatus(row, now),
    createdAt: new Date(Number(row.created_at)).toISOString(),
    expiresAt: new Date(Number(row.expires_at)).toISOString(),
    usedAt: row.used_at === null ? null : new Date(Number(row.used_at)).toISOString(),
    revokedAt: row.revoked_at === null ? null : new Date(Number(row.revoked_at)).toISOString(),
    device: row.device_id ? {
      id: row.device_id,
      deviceName: row.device_name,
    } : null,
  };
}

function listPairingInvites(db, { now = Date.now() } = {}) {
  ensurePairingInviteManagementSchema(db);
  return db.prepare(`
    SELECT i.id, i.expires_at, i.used_at, i.revoked_at, i.created_at,
           d.id AS device_id, d.device_name
    FROM pairing_invites i
    LEFT JOIN paired_devices d ON d.pairing_invite_id = i.id
    ORDER BY i.created_at DESC, i.id DESC
  `).all().map((row) => pairingInvitePublicView(row, now));
}

function revokePairingInvite(db, inviteId, { now = Date.now() } = {}) {
  ensurePairingInviteManagementSchema(db);
  if (!isUuid(inviteId)) {
    throw new PairingError('INVALID_REQUEST', 'ID invito non valido.');
  }

  const result = db.prepare(`
    UPDATE pairing_invites
    SET revoked_at = ?
    WHERE id = ?
      AND used_at IS NULL
      AND revoked_at IS NULL
      AND expires_at > ?
  `).run(now, inviteId, now);

  if (Number(result.changes) === 1) {
    const row = db.prepare(`
      SELECT i.id, i.expires_at, i.used_at, i.revoked_at, i.created_at,
             d.id AS device_id, d.device_name
      FROM pairing_invites i
      LEFT JOIN paired_devices d ON d.pairing_invite_id = i.id
      WHERE i.id = ?
      LIMIT 1
    `).get(inviteId);
    return pairingInvitePublicView(row, now);
  }

  const existing = db.prepare(`
    SELECT id FROM pairing_invites WHERE id = ? LIMIT 1
  `).get(inviteId);
  if (!existing) {
    throw new PairingError('INVITE_NOT_FOUND', 'Invito non trovato.', 404);
  }
  throw new PairingError('INVITE_NOT_ACTIVE', 'L’invito non è più attivo.', 409);
}

function listPairedDevices(db) {
  ensurePairingSchema(db);
  return db.prepare(`
    SELECT id, device_name, fingerprint, installation_id,
           paired_at, last_seen_at, revoked_at
    FROM paired_devices
    ORDER BY paired_at DESC
  `).all().map((row) => ({
    id: row.id,
    deviceName: row.device_name,
    fingerprint: row.fingerprint,
    installationId: row.installation_id,
    pairedAt: new Date(Number(row.paired_at)).toISOString(),
    lastSeenAt: new Date(Number(row.last_seen_at)).toISOString(),
    revokedAt: row.revoked_at === null ? null : new Date(Number(row.revoked_at)).toISOString(),
  }));
}

function revokePairedDevice(db, deviceId, { now = Date.now() } = {}) {
  if (!isUuid(deviceId)) {
    throw new PairingError('INVALID_REQUEST', 'ID dispositivo non valido.');
  }
  ensurePairingSchema(db);
  const result = db.prepare(`
    UPDATE paired_devices
    SET revoked_at = ?
        ${accountBindingResetSql(db)}
    WHERE id = ? AND revoked_at IS NULL
  `).run(now, deviceId);

  if (Number(result.changes) !== 1) {
    throw new PairingError('DEVICE_NOT_FOUND', 'Dispositivo attivo non trovato.');
  }
  return true;
}

module.exports = {
  DEFAULT_INVITE_MINUTES,
  MAX_INVITE_MINUTES,
  PairingError,
  ensurePairingSchema,
  ensurePairingInviteManagementSchema,
  migratePairingSchemaToDeviceOnly,
  migratePairingInvitesToRevocable,
  createPairingInvite,
  redeemPairingInvite,
  listPairingInvites,
  revokePairingInvite,
  listPairedDevices,
  revokePairedDevice,
  pairingProofMessage,
  publicKeyFingerprint,
};
