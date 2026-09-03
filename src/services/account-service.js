'use strict';

const crypto = require('node:crypto');
const { normalizeProfileKey } = require('../utils/profile-key');
const {
  SECTION_KEYS,
  getAccountSections,
  normalizeSectionKeys,
  replaceAccountSections,
} = require('./account-section-service');

const ACCOUNT_ROLES = Object.freeze(['user', 'admin']);
const ACCOUNT_ROLE_SET = new Set(ACCOUNT_ROLES);
const DELETED_USERNAME_PREFIX = '__deleted__';
const LEGACY_PROFILE_TABLES = Object.freeze([
  ['paired_devices', 'profile_key'],
  ['watch_progress', 'profile_key'],
  ['favorites', 'profile_key'],
  ['reading_bookmarks', 'profile_key'],
  ['music_track_favorites', 'profile_key'],
  ['music_listening_history', 'profile_key'],
  ['music_playback_sessions', 'profile_key'],
  ['music_playlists', 'profile_key'],
]);

class AccountError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AccountError';
    this.code = code;
  }
}

function tableExists(db, tableName) {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1
  `).get(tableName));
}

function columnExists(db, tableName, columnName) {
  if (!tableExists(db, tableName)) return false;
  return db.prepare(`PRAGMA table_info(${tableName})`).all()
    .some((column) => column.name === columnName);
}

function ensureColumn(db, tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (!columns.some((column) => column.name === columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function ensureAccountSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      account_key TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL,
      username_normalized TEXT NOT NULL UNIQUE,
      deleted_username TEXT,
      password_hash TEXT,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
      auth_version INTEGER NOT NULL DEFAULT 1 CHECK (auth_version >= 1),
      must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
      disabled_at TEXT,
      deleted_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS account_section_access (
      account_id TEXT NOT NULL,
      section_key TEXT NOT NULL CHECK (
        section_key IN ('films', 'series', 'music', 'books', 'comics', 'manga')
      ),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (account_id, section_key),
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );
  `);

  ensureColumn(db, 'accounts', 'deleted_username', 'TEXT');

  if (tableExists(db, 'paired_devices')) {
    ensureColumn(db, 'paired_devices', 'active_account_id', 'TEXT REFERENCES accounts(id) ON DELETE SET NULL');
    ensureColumn(db, 'paired_devices', 'active_account_auth_version', 'INTEGER');
    ensureColumn(db, 'paired_devices', 'account_authenticated_at', 'INTEGER');
    ensureColumn(
      db,
      'paired_devices',
      'account_binding_source',
      "TEXT CHECK (account_binding_source IS NULL OR account_binding_source IN ('legacy', 'login', 'admin'))",
    );
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_accounts_role_active
      ON accounts(role, disabled_at, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_accounts_updated_at
      ON accounts(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_account_section_access_section
      ON account_section_access(section_key, account_id);
  `);
  if (tableExists(db, 'paired_devices')) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_paired_devices_active_account
        ON paired_devices(active_account_id, revoked_at);
    `);
  }
}

function usernameComparisonKey(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase();
}

function normalizeUsername(value) {
  const raw = String(value ?? '');
  const username = raw.normalize('NFKC');
  if (username !== username.trim()
    || username.length < 3
    || username.length > 64
    || !/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(username)) {
    throw new AccountError(
      'USERNAME_INVALID',
      'Lo username deve contenere da 3 a 64 caratteri: lettere, numeri, punto, trattino o underscore, senza spazi.',
    );
  }
  return username;
}

function normalizeUsernameLookup(value) {
  const username = String(value ?? '').trim().normalize('NFKC');
  return usernameComparisonKey(normalizeUsername(username));
}

function normalizeRole(value) {
  const role = String(value || '').trim().toLowerCase();
  if (!ACCOUNT_ROLE_SET.has(role)) {
    throw new AccountError('ROLE_INVALID', 'Ruolo account non valido.');
  }
  return role;
}

function normalizePasswordHash(value, { allowNull = false } = {}) {
  if (value === null && allowNull) return null;
  const passwordHash = String(value || '').trim();
  if (!passwordHash) {
    throw new AccountError('PASSWORD_HASH_REQUIRED', 'Hash password account mancante.');
  }
  return passwordHash;
}

function normalizeAccountKey(value) {
  const accountKey = String(value || '').trim();
  if (!accountKey || accountKey.length > 64 || !/^[a-zA-Z0-9_-]+$/.test(accountKey)) {
    throw new AccountError('ACCOUNT_KEY_INVALID', 'Chiave account non valida.');
  }
  return accountKey;
}

function accountFromRow(row, sections = []) {
  if (!row) return null;
  return {
    id: row.id,
    accountKey: row.account_key,
    username: row.deleted_at && row.deleted_username ? row.deleted_username : row.username,
    passwordHash: row.password_hash,
    role: row.role,
    authVersion: Number(row.auth_version),
    mustChangePassword: Boolean(row.must_change_password),
    disabledAt: row.disabled_at,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sections,
  };
}

function getAccountById(db, accountId, { includeDeleted = false } = {}) {
  const row = db.prepare(`
    SELECT * FROM accounts
    WHERE id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
    LIMIT 1
  `).get(accountId);
  return accountFromRow(row, row ? getAccountSections(db, row.id) : []);
}

function getAccountByUsername(db, username, { includeDeleted = false } = {}) {
  const normalized = normalizeUsernameLookup(username);
  const row = includeDeleted
    ? db.prepare(`
        SELECT * FROM accounts
        WHERE username_normalized = ?
           OR (deleted_at IS NOT NULL AND lower(deleted_username) = ?)
        ORDER BY CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END
        LIMIT 1
      `).get(normalized, normalized)
    : db.prepare(`
        SELECT * FROM accounts
        WHERE username_normalized = ?
          AND deleted_at IS NULL
        LIMIT 1
      `).get(normalized);
  return accountFromRow(row, row ? getAccountSections(db, row.id) : []);
}

function getAccountByKey(db, accountKey, { includeDeleted = false } = {}) {
  const normalized = normalizeAccountKey(accountKey);
  const row = db.prepare(`
    SELECT * FROM accounts
    WHERE account_key = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
    LIMIT 1
  `).get(normalized);
  return accountFromRow(row, row ? getAccountSections(db, row.id) : []);
}

function listAccounts(db, { includeDeleted = false } = {}) {
  const rows = db.prepare(`
    SELECT * FROM accounts
    ${includeDeleted ? '' : 'WHERE deleted_at IS NULL'}
    ORDER BY username_normalized, username
  `).all();
  return rows.map((row) => accountFromRow(row, getAccountSections(db, row.id)));
}

function activeAdminCount(db, { excludingId = null } = {}) {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM accounts
    WHERE role = 'admin'
      AND disabled_at IS NULL
      AND deleted_at IS NULL
      AND (? IS NULL OR id <> ?)
  `).get(excludingId, excludingId);
  return Number(row?.count || 0);
}

function assertAccountExists(db, accountId, { includeDeleted = false } = {}) {
  const account = getAccountById(db, accountId, { includeDeleted });
  if (!account) throw new AccountError('ACCOUNT_NOT_FOUND', 'Account non trovato.');
  return account;
}

function assertCanRemoveActiveAdmin(db, account) {
  if (account.role !== 'admin' || account.disabledAt || account.deletedAt) return;
  if (activeAdminCount(db, { excludingId: account.id }) < 1) {
    throw new AccountError('LAST_ADMIN_REQUIRED', 'Deve rimanere almeno un account amministratore attivo.');
  }
}

function deletedUsernameTombstone(accountId) {
  return `${DELETED_USERNAME_PREFIX}${String(accountId || '').trim()}`.slice(0, 64);
}

function availableDeletedUsername(db, accountId) {
  const base = deletedUsernameTombstone(accountId);
  let candidate = base;
  let suffix = 2;
  const hasNormalized = columnExists(db, 'accounts', 'username_normalized');
  const findCollision = hasNormalized
    ? db.prepare('SELECT 1 FROM accounts WHERE username_normalized = ? AND id <> ? LIMIT 1')
    : db.prepare('SELECT 1 FROM accounts WHERE username = ? COLLATE NOCASE AND id <> ? LIMIT 1');
  while (findCollision.get(hasNormalized ? usernameComparisonKey(candidate) : candidate, accountId)) {
    const suffixText = `-${suffix}`;
    candidate = `${base.slice(0, 64 - suffixText.length)}${suffixText}`;
    suffix += 1;
  }
  return candidate;
}

function migrateDeletedAccountUsernames(db) {
  ensureAccountSchema(db);
  const rows = db.prepare(`
    SELECT id, username, deleted_username AS deletedUsername
    FROM accounts
    WHERE deleted_at IS NOT NULL
      AND (deleted_username IS NULL OR username NOT GLOB ?)
    ORDER BY created_at, id
  `).all(`${DELETED_USERNAME_PREFIX}*`);
  if (rows.length === 0) return { migrated: [] };

  const migrated = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    const hasNormalized = columnExists(db, 'accounts', 'username_normalized');
    const update = hasNormalized
      ? db.prepare(`
          UPDATE accounts SET
            deleted_username = COALESCE(NULLIF(deleted_username, ''), username),
            username = ?,
            username_normalized = ?
          WHERE id = ?
        `)
      : db.prepare(`
          UPDATE accounts SET
            deleted_username = COALESCE(NULLIF(deleted_username, ''), username),
            username = ?
          WHERE id = ?
        `);
    for (const row of rows) {
      const archivedUsername = availableDeletedUsername(db, row.id);
      if (hasNormalized) update.run(archivedUsername, usernameComparisonKey(archivedUsername), row.id);
      else update.run(archivedUsername, row.id);
      migrated.push(row.id);
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw new Error(`Migrazione degli username eliminati non riuscita: ${error.message}`);
  }
  return { migrated };
}


function migrateAccountNamesToUsername(db) {
  if (!tableExists(db, 'accounts')) {
    ensureAccountSchema(db);
    return { migrated: false, usernames: [] };
  }

  const columns = db.prepare('PRAGMA table_info(accounts)').all().map((column) => column.name);
  const hasDisplayName = columns.includes('display_name');
  const hasNormalizedUsername = columns.includes('username_normalized');
  if (!hasDisplayName && hasNormalizedUsername) {
    ensureAccountSchema(db);
    return { migrated: false, usernames: [] };
  }
  if (!columns.includes('username')) {
    throw new Error('Migrazione account impossibile: colonna username mancante.');
  }

  const rows = db.prepare(`
    SELECT * FROM accounts
    ORDER BY created_at, id
  `).all();
  const currentOwners = new Map(rows.map((row) => [usernameComparisonKey(row.username), row.id]));
  const preferredById = new Map();
  const preferredCounts = new Map();

  for (const row of rows) {
    if (row.deleted_at || !hasDisplayName) continue;
    try {
      const preferred = normalizeUsername(row.display_name);
      const key = usernameComparisonKey(preferred);
      preferredById.set(row.id, { username: preferred, key });
      preferredCounts.set(key, Number(preferredCounts.get(key) || 0) + 1);
    } catch {}
  }

  const migratedRows = rows.map((row) => {
    const currentKey = usernameComparisonKey(row.username);
    let username = row.username;
    const preferred = preferredById.get(row.id);
    if (preferred) {
      const owner = currentOwners.get(preferred.key);
      const uniquePreferred = preferredCounts.get(preferred.key) === 1;
      if (preferred.key === currentKey || (uniquePreferred && (!owner || owner === row.id))) {
        username = preferred.username;
      }
    }
    return {
      ...row,
      username,
      usernameNormalized: usernameComparisonKey(username),
    };
  });

  const normalizedOwners = new Map();
  for (const row of migratedRows) {
    const owner = normalizedOwners.get(row.usernameNormalized);
    if (owner && owner !== row.id) {
      throw new Error(`Migrazione account impossibile: username duplicato ${row.username}.`);
    }
    normalizedOwners.set(row.usernameNormalized, row.id);
  }

  const foreignKeysEnabled = Number(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys || 0) === 1;
  if (foreignKeysEnabled) db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec(`
      DROP TABLE IF EXISTS accounts_v18;
      CREATE TABLE accounts_v18 (
        id TEXT PRIMARY KEY,
        account_key TEXT NOT NULL UNIQUE,
        username TEXT NOT NULL,
        username_normalized TEXT NOT NULL UNIQUE,
        deleted_username TEXT,
        password_hash TEXT,
        role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
        auth_version INTEGER NOT NULL DEFAULT 1 CHECK (auth_version >= 1),
        must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
        disabled_at TEXT,
        deleted_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    const insert = db.prepare(`
      INSERT INTO accounts_v18 (
        id, account_key, username, username_normalized, deleted_username,
        password_hash, role, auth_version, must_change_password,
        disabled_at, deleted_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of migratedRows) {
      insert.run(
        row.id,
        row.account_key,
        row.username,
        row.usernameNormalized,
        row.deleted_username ?? null,
        row.password_hash ?? null,
        row.role,
        Number(row.auth_version),
        Number(row.must_change_password),
        row.disabled_at ?? null,
        row.deleted_at ?? null,
        row.created_at,
        row.updated_at,
      );
    }
    db.exec(`
      DROP TABLE accounts;
      ALTER TABLE accounts_v18 RENAME TO accounts;
      CREATE INDEX idx_accounts_role_active
        ON accounts(role, disabled_at, deleted_at);
      CREATE INDEX idx_accounts_updated_at
        ON accounts(updated_at DESC);
    `);
    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length > 0) {
      throw new Error(`foreign_key_check ha rilevato ${violations.length} violazioni.`);
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw new Error(`Migrazione username account non riuscita: ${error.message}`);
  } finally {
    if (foreignKeysEnabled) db.exec('PRAGMA foreign_keys = ON');
  }

  ensureAccountSchema(db);
  return {
    migrated: true,
    usernames: migratedRows.map((row) => ({ id: row.id, username: row.username })),
  };
}

function createAccount(db, {
  username,
  passwordHash,
  role = 'user',
  sections,
  accountKey = crypto.randomUUID(),
  mustChangePassword = false,
  now = new Date().toISOString(),
} = {}) {
  ensureAccountSchema(db);
  const normalizedUsername = normalizeUsername(username);
  const usernameNormalized = usernameComparisonKey(normalizedUsername);
  const normalizedPasswordHash = normalizePasswordHash(passwordHash);
  const normalizedRole = normalizeRole(role);
  const normalizedAccountKey = normalizeAccountKey(accountKey);
  const selectedSections = normalizedRole === 'admin' ? SECTION_KEYS : (sections ?? []);
  const accountId = crypto.randomUUID();

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      INSERT INTO accounts (
        id, account_key, username, username_normalized, password_hash, role,
        auth_version, must_change_password, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(
      accountId,
      normalizedAccountKey,
      normalizedUsername,
      usernameNormalized,
      normalizedPasswordHash,
      normalizedRole,
      mustChangePassword ? 1 : 0,
      now,
      now,
    );
    replaceAccountSections(db, accountId, selectedSections);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    if (String(error?.message || '').includes('accounts.username_normalized') || String(error?.message || '').includes('accounts.username')) {
      throw new AccountError('USERNAME_EXISTS', 'Esiste già un account con questo username.');
    }
    if (String(error?.message || '').includes('accounts.account_key')) {
      throw new AccountError('ACCOUNT_KEY_EXISTS', 'Esiste già un account con questa chiave interna.');
    }
    throw error;
  }
  return getAccountById(db, accountId);
}

function updateAccount(db, accountId, {
  username,
  role,
  sections,
  disabled,
  now = new Date().toISOString(),
} = {}) {
  ensureAccountSchema(db);
  const current = assertAccountExists(db, accountId);
  const nextUsername = username === undefined ? current.username : normalizeUsername(username);
  const nextUsernameNormalized = usernameComparisonKey(nextUsername);
  const nextRole = role === undefined ? current.role : normalizeRole(role);
  const nextSections = sections === undefined
    ? current.sections
    : normalizeSectionKeys(sections);
  const storedNextSections = nextRole === 'admin' ? SECTION_KEYS : nextSections;
  if (disabled !== undefined && typeof disabled !== 'boolean') {
    throw new AccountError('ACCOUNT_DISABLED_INVALID', 'Lo stato disabilitato deve essere booleano.');
  }
  const nextDisabled = disabled === undefined ? Boolean(current.disabledAt) : disabled;

  if (
    current.role === 'admin'
    && !current.disabledAt
    && (nextRole !== 'admin' || nextDisabled)
  ) {
    assertCanRemoveActiveAdmin(db, current);
  }
  const authorizationChanged = nextRole !== current.role
    || nextDisabled !== Boolean(current.disabledAt)
    || (sections !== undefined
      && JSON.stringify(current.sections) !== JSON.stringify(storedNextSections));

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      UPDATE accounts SET
        username = ?,
        username_normalized = ?,
        role = ?,
        disabled_at = ?,
        auth_version = auth_version + ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      nextUsername,
      nextUsernameNormalized,
      nextRole,
      nextDisabled ? (current.disabledAt || now) : null,
      authorizationChanged ? 1 : 0,
      now,
      accountId,
    );
    replaceAccountSections(db, accountId, storedNextSections);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    if (String(error?.message || '').includes('accounts.username_normalized') || String(error?.message || '').includes('accounts.username')) {
      throw new AccountError('USERNAME_EXISTS', 'Esiste già un account con questo username.');
    }
    throw error;
  }
  return getAccountById(db, accountId);
}

function setAccountPasswordHash(db, accountId, passwordHash, {
  mustChangePassword = false,
  now = new Date().toISOString(),
} = {}) {
  ensureAccountSchema(db);
  assertAccountExists(db, accountId);
  const normalizedPasswordHash = normalizePasswordHash(passwordHash);
  db.prepare(`
    UPDATE accounts SET
      password_hash = ?,
      must_change_password = ?,
      auth_version = auth_version + 1,
      updated_at = ?
    WHERE id = ?
  `).run(normalizedPasswordHash, mustChangePassword ? 1 : 0, now, accountId);
  return getAccountById(db, accountId);
}

function setAccountDisabled(db, accountId, disabled, {
  now = new Date().toISOString(),
} = {}) {
  ensureAccountSchema(db);
  const current = assertAccountExists(db, accountId);
  const nextDisabled = Boolean(disabled);
  if (nextDisabled && !current.disabledAt) assertCanRemoveActiveAdmin(db, current);
  if (nextDisabled === Boolean(current.disabledAt)) return current;

  db.prepare(`
    UPDATE accounts SET
      disabled_at = ?,
      auth_version = auth_version + 1,
      updated_at = ?
    WHERE id = ?
  `).run(nextDisabled ? now : null, now, accountId);
  return getAccountById(db, accountId);
}

function softDeleteAccount(db, accountId, {
  now = new Date().toISOString(),
} = {}) {
  ensureAccountSchema(db);
  const current = assertAccountExists(db, accountId);
  assertCanRemoveActiveAdmin(db, current);
  const archivedUsername = availableDeletedUsername(db, accountId);
  db.prepare(`
    UPDATE accounts SET
      deleted_username = COALESCE(NULLIF(deleted_username, ''), username),
      username = ?,
      username_normalized = ?,
      deleted_at = ?,
      disabled_at = COALESCE(disabled_at, ?),
      auth_version = auth_version + 1,
      updated_at = ?
    WHERE id = ?
  `).run(archivedUsername, usernameComparisonKey(archivedUsername), now, now, now, accountId);
  return getAccountById(db, accountId, { includeDeleted: true });
}

function legacyProfileKeys(db) {
  const profileKeys = new Set(['default']);
  for (const [tableName, columnName] of LEGACY_PROFILE_TABLES) {
    if (!columnExists(db, tableName, columnName)) continue;
    const rows = db.prepare(`
      SELECT DISTINCT ${columnName} AS profileKey
      FROM ${tableName}
      WHERE COALESCE(${columnName}, '') <> ''
    `).all();
    for (const row of rows) profileKeys.add(normalizeProfileKey(row.profileKey));
  }
  return [...profileKeys].sort((left, right) => left.localeCompare(right, 'it'));
}

function legacyUsername(profileKey) {
  const candidate = profileKey.length >= 3 ? profileKey : `legacy-${profileKey}`;
  return normalizeUsername(candidate.slice(0, 64));
}

function availableLegacyUsername(db, profileKey) {
  const base = legacyUsername(profileKey);
  const findUsername = db.prepare(`
    SELECT account_key AS accountKey
    FROM accounts
    WHERE username_normalized = ?
    LIMIT 1
  `);
  let candidate = base;
  let suffix = 2;
  while (true) {
    const existing = findUsername.get(usernameComparisonKey(candidate));
    if (!existing || existing.accountKey === profileKey) return candidate;
    const suffixText = `-${suffix}`;
    candidate = `${base.slice(0, 64 - suffixText.length)}${suffixText}`;
    suffix += 1;
  }
}

function migrateLegacyProfilesToAccounts(db, {
  defaultDisplayName = 'Amministratore',
  now = new Date().toISOString(),
} = {}) {
  ensureAccountSchema(db);
  const profiles = legacyProfileKeys(db);
  const inserted = [];
  const linkedDevices = [];

  db.exec('BEGIN IMMEDIATE');
  try {
    const findAccount = db.prepare(`
      SELECT id, auth_version AS authVersion
      FROM accounts
      WHERE account_key = ?
      LIMIT 1
    `);
    const insertAccount = db.prepare(`
      INSERT INTO accounts (
        id, account_key, username, username_normalized, password_hash, role,
        auth_version, must_change_password, created_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, ?, 1, 1, ?, ?)
    `);
    const insertSection = db.prepare(`
      INSERT OR IGNORE INTO account_section_access (account_id, section_key, created_at)
      VALUES (?, ?, ?)
    `);
    const linkDevices = columnExists(db, 'paired_devices', 'profile_key')
      ? db.prepare(`
          UPDATE paired_devices SET
            active_account_id = ?,
            active_account_auth_version = ?,
            account_authenticated_at = paired_at,
            account_binding_source = 'legacy'
          WHERE profile_key = ?
            AND active_account_id IS NULL
        `)
      : null;

    for (const profileKey of profiles) {
      let account = findAccount.get(profileKey);
      if (!account) {
        const accountId = crypto.randomUUID();
        let migratedUsername = availableLegacyUsername(db, profileKey);
        if (profileKey === 'default') {
          try {
            const preferred = normalizeUsername(defaultDisplayName);
            const collision = db.prepare(`
              SELECT 1 FROM accounts WHERE username_normalized = ? LIMIT 1
            `).get(usernameComparisonKey(preferred));
            if (!collision) migratedUsername = preferred;
          } catch {}
        }
        insertAccount.run(
          accountId,
          profileKey,
          migratedUsername,
          usernameComparisonKey(migratedUsername),
          profileKey === 'default' ? 'admin' : 'user',
          now,
          now,
        );
        account = { id: accountId, authVersion: 1 };
        inserted.push(profileKey);
      }
      for (const sectionKey of SECTION_KEYS) insertSection.run(account.id, sectionKey, now);
      if (linkDevices) {
        const result = linkDevices.run(account.id, Number(account.authVersion), profileKey);
        if (Number(result.changes) > 0) {
          linkedDevices.push({ profileKey, count: Number(result.changes) });
        }
      }
    }

    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw new Error(`Migrazione degli account legacy non riuscita: ${error.message}`);
  }

  return { profiles, inserted, linkedDevices };
}

module.exports = {
  ACCOUNT_ROLES,
  AccountError,
  ensureAccountSchema,
  normalizeUsername,
  normalizeUsernameLookup,
  usernameComparisonKey,
  normalizeRole,
  getAccountById,
  getAccountByUsername,
  getAccountByKey,
  listAccounts,
  createAccount,
  updateAccount,
  setAccountPasswordHash,
  setAccountDisabled,
  softDeleteAccount,
  migrateLegacyProfilesToAccounts,
  migrateDeletedAccountUsernames,
  migrateAccountNamesToUsername,
};
