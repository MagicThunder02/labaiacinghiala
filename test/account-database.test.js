'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function createEnvironment(root) {
  const library = path.join(root, 'media');
  fs.mkdirSync(library, { recursive: true });
  return {
    ...process.env,
    DATABASE_PATH: path.join(root, 'media.sqlite'),
    DATABASE_BACKUPS_PATH: path.join(root, 'backups'),
    LIBRARY_PATH: library,
    METADATA_POSTER_CACHE_PATH: path.join(root, 'poster-cache'),
    METADATA_POSTERS_PATH: path.join(root, 'posters'),
    UPLOAD_TEMP_PATH: path.join(library, '.uploads'),
    PROFILE_NAME: 'Peru Test',
  };
}

function runScript(root, script) {
  return spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: createEnvironment(root),
  });
}

test('schema 19 usa un solo username pubblico e mantiene distinti pairing e account', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-account-db-'));
  const result = runScript(root, `
    const db = require('./src/database');
    const version = Number(db.prepare('PRAGMA user_version').get().user_version);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('accounts','account_section_access','paired_devices') ORDER BY name").all().map((row) => row.name);
    const deviceColumns = db.prepare('PRAGMA table_info(paired_devices)').all().map((row) => row.name);
    const inviteColumns = db.prepare('PRAGMA table_info(pairing_invites)').all().map((row) => row.name);
    const accountColumns = db.prepare('PRAGMA table_info(accounts)').all().map((row) => row.name);
    const account = db.prepare('SELECT account_key, username, username_normalized, role, password_hash, auth_version, must_change_password FROM accounts').get();
    const sections = db.prepare('SELECT section_key FROM account_section_access ORDER BY section_key').all().map((row) => row.section_key);
    console.log(JSON.stringify({ version, tables, deviceColumns, inviteColumns, accountColumns, account, sections }));
    db.close();
  `);

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(payload.version, 19);
  assert.deepEqual(payload.tables, ['account_section_access', 'accounts', 'paired_devices']);
  assert.equal(payload.accountColumns.includes('deleted_username'), true);
  assert.equal(payload.accountColumns.includes('username_normalized'), true);
  assert.equal(payload.accountColumns.includes('display_name'), false);
  assert.equal(payload.deviceColumns.includes('profile_key'), false);
  assert.equal(payload.inviteColumns.includes('profile_key'), false);
  assert.equal(payload.inviteColumns.includes('revoked_at'), true);
  for (const column of [
    'active_account_id',
    'active_account_auth_version',
    'account_authenticated_at',
    'account_binding_source',
  ]) assert.ok(payload.deviceColumns.includes(column), `Colonna mancante: ${column}`);
  assert.deepEqual(payload.account, {
    account_key: 'default',
    username: 'default',
    username_normalized: 'default',
    role: 'admin',
    password_hash: null,
    auth_version: 1,
    must_change_password: 1,
  });
  assert.deepEqual(payload.sections, ['books', 'comics', 'films', 'manga', 'music', 'series']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('migra i profile_key dello schema 14 senza perdere dati e collega i dispositivi come legacy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-account-migration-'));
  const result = runScript(root, `
    const { DatabaseSync } = require('node:sqlite');
    const databasePath = process.env.DATABASE_PATH;
    let legacyDb = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
    legacyDb.exec(\`
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
      CREATE TABLE music_playlists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        playlist_uuid TEXT NOT NULL UNIQUE,
        profile_key TEXT NOT NULL DEFAULT 'default',
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      PRAGMA user_version = 14;
    \`);
    legacyDb.prepare(\`INSERT INTO paired_devices (
      id, public_key, fingerprint, installation_id, device_name, profile_key,
      paired_at, last_seen_at, revoked_at, pairing_invite_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)\`).run(
      '11111111-1111-4111-8111-111111111111', 'key-default', 'fp-default',
      '21111111-1111-4111-8111-111111111111', 'PC principale', 'default', 1000, 1100,
    );
    legacyDb.prepare(\`INSERT INTO paired_devices (
      id, public_key, fingerprint, installation_id, device_name, profile_key,
      paired_at, last_seen_at, revoked_at, pairing_invite_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)\`).run(
      '12222222-2222-4222-8222-222222222222', 'key-friend', 'fp-friend',
      '22222222-2222-4222-8222-222222222222', 'PC amico', 'friend', 2000, 2100,
    );
    legacyDb.prepare('INSERT INTO music_playlists (playlist_uuid, profile_key, name) VALUES (?, ?, ?)')
      .run('playlist-friend', 'friend', 'Preferite amico');
    legacyDb.close();

    const db = require('./src/database');
    const { migrateLegacyProfilesToAccounts } = require('./src/services/account-service');
    const migrationAgain = migrateLegacyProfilesToAccounts(db, { defaultDisplayName: 'Non deve sovrascrivere' });
    const version = Number(db.prepare('PRAGMA user_version').get().user_version);
    const accounts = db.prepare('SELECT id, account_key, username, username_normalized, role, password_hash, must_change_password FROM accounts ORDER BY account_key').all();
    const sections = db.prepare('SELECT a.account_key AS accountKey, COUNT(s.section_key) AS sectionCount FROM accounts a LEFT JOIN account_section_access s ON s.account_id = a.id GROUP BY a.id ORDER BY a.account_key').all();
    const devices = db.prepare(\`
      SELECT d.device_name AS deviceName, d.account_binding_source AS bindingSource,
        d.active_account_auth_version AS authVersion, a.account_key AS accountKey
      FROM paired_devices d
      LEFT JOIN accounts a ON a.id = d.active_account_id
      ORDER BY d.device_name
    \`).all();
    const pairingColumns = {
      invites: db.prepare('PRAGMA table_info(pairing_invites)').all().map((row) => row.name),
      devices: db.prepare('PRAGMA table_info(paired_devices)').all().map((row) => row.name),
    };
    const playlist = db.prepare('SELECT playlist_uuid, profile_key, name FROM music_playlists').get();
    console.log(JSON.stringify({ version, accounts, sections, devices, pairingColumns, playlist, migrationAgain }));
    db.close();
  `);

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(payload.version, 19);
  assert.deepEqual(payload.accounts.map((account) => ({
    accountKey: account.account_key,
    username: account.username,
    usernameNormalized: account.username_normalized,
    role: account.role,
    passwordHash: account.password_hash,
    mustChangePassword: account.must_change_password,
  })), [
    {
      accountKey: 'default',
      username: 'default',
      usernameNormalized: 'default',
      role: 'admin',
      passwordHash: null,
      mustChangePassword: 1,
    },
    {
      accountKey: 'friend',
      username: 'friend',
      usernameNormalized: 'friend',
      role: 'user',
      passwordHash: null,
      mustChangePassword: 1,
    },
  ]);
  assert.deepEqual(payload.sections, [
    { accountKey: 'default', sectionCount: 6 },
    { accountKey: 'friend', sectionCount: 6 },
  ]);
  assert.deepEqual(payload.devices, [
    { deviceName: 'PC amico', bindingSource: 'legacy', authVersion: 1, accountKey: 'friend' },
    { deviceName: 'PC principale', bindingSource: 'legacy', authVersion: 1, accountKey: 'default' },
  ]);
  assert.equal(payload.pairingColumns.invites.includes('profile_key'), false);
  assert.equal(payload.pairingColumns.invites.includes('revoked_at'), true);
  assert.equal(payload.pairingColumns.devices.includes('profile_key'), false);
  assert.deepEqual(payload.playlist, {
    playlist_uuid: 'playlist-friend',
    profile_key: 'friend',
    name: 'Preferite amico',
  });
  assert.deepEqual(payload.migrationAgain.inserted, []);
  fs.rmSync(root, { recursive: true, force: true });
});


test('schema 19 archivia gli username eliminati e consente di ricrearli senza ereditare dati', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-account-deleted-username-'));
  const result = runScript(root, `
    const { DatabaseSync } = require('node:sqlite');
    const databasePath = process.env.DATABASE_PATH;
    let legacyDb = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
    legacyDb.exec(\`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        account_key TEXT NOT NULL UNIQUE,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT,
        role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
        auth_version INTEGER NOT NULL DEFAULT 1 CHECK (auth_version >= 1),
        must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
        disabled_at TEXT,
        deleted_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE account_section_access (
        account_id TEXT NOT NULL,
        section_key TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (account_id, section_key),
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );
      PRAGMA user_version = 16;
    \`);
    const archivedId = '11111111-1111-4111-8111-111111111111';
    legacyDb.prepare(\`
      INSERT INTO accounts (
        id, account_key, username, display_name, password_hash, role,
        auth_version, must_change_password, disabled_at, deleted_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'user', 2, 0, ?, ?, ?, ?)
    \`).run(
      archivedId, 'old-account-key', 'marco', 'Marco eliminato', 'scrypt$old',
      '2026-08-01T10:00:00.000Z', '2026-08-01T10:00:00.000Z',
      '2026-07-01T10:00:00.000Z', '2026-08-01T10:00:00.000Z',
    );
    legacyDb.prepare('INSERT INTO account_section_access (account_id, section_key) VALUES (?, ?)')
      .run(archivedId, 'films');
    legacyDb.close();

    const db = require('./src/database');
    const { createAccount, getAccountById, getAccountByUsername } = require('./src/services/account-service');
    const version = Number(db.prepare('PRAGMA user_version').get().user_version);
    const archivedRaw = db.prepare(\`
      SELECT username, deleted_username AS deletedUsername, account_key AS accountKey
      FROM accounts WHERE id = ?
    \`).get(archivedId);
    const archived = getAccountById(db, archivedId, { includeDeleted: true });
    const replacement = createAccount(db, {
      username: 'MARCO',
      passwordHash: 'scrypt$new',
      sections: ['books'],
    });
    const oldSectionCount = Number(db.prepare(
      'SELECT COUNT(*) AS count FROM account_section_access WHERE account_id = ?'
    ).get(archivedId).count);
    const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
    console.log(JSON.stringify({
      version,
      archivedRaw,
      archivedUsername: archived.username,
      replacement: {
        id: replacement.id,
        accountKey: replacement.accountKey,
        username: replacement.username,
        sections: replacement.sections,
      },
      activeLookupId: getAccountByUsername(db, 'marco').id,
      oldSectionCount,
      foreignKeys,
    }));
    db.close();
  `);

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim().split(/\\r?\\n/).at(-1));
  assert.equal(payload.version, 19);
  assert.match(payload.archivedRaw.username, /^__deleted__/);
  assert.equal(payload.archivedRaw.deletedUsername, 'marco');
  assert.equal(payload.archivedRaw.accountKey, 'old-account-key');
  assert.equal(payload.archivedUsername, 'marco');
  assert.equal(payload.replacement.username, 'MARCO');
  assert.notEqual(payload.replacement.id, '11111111-1111-4111-8111-111111111111');
  assert.notEqual(payload.replacement.accountKey, 'old-account-key');
  assert.deepEqual(payload.replacement.sections, ['books']);
  assert.equal(payload.activeLookupId, payload.replacement.id);
  assert.equal(payload.oldSectionCount, 1);
  assert.deepEqual(payload.foreignKeys, []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('schema 19 unifica il nome visualizzato nello username preservando le maiuscole e il login case-insensitive', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-account-username-migration-'));
  const result = runScript(root, `
    const { DatabaseSync } = require('node:sqlite');
    const databasePath = process.env.DATABASE_PATH;
    let legacyDb = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
    legacyDb.exec(\`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        account_key TEXT NOT NULL UNIQUE,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        deleted_username TEXT,
        display_name TEXT NOT NULL,
        password_hash TEXT,
        role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
        auth_version INTEGER NOT NULL DEFAULT 1 CHECK (auth_version >= 1),
        must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
        disabled_at TEXT,
        deleted_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE account_section_access (
        account_id TEXT NOT NULL,
        section_key TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (account_id, section_key),
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );
      PRAGMA user_version = 17;
    \`);
    legacyDb.prepare(\`
      INSERT INTO accounts (
        id, account_key, username, display_name, password_hash, role,
        auth_version, must_change_password, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
    \`).run(
      '11111111-1111-4111-8111-111111111111', 'default', 'peru', 'Peru',
      'scrypt$fixture', 'admin', '2026-08-01T10:00:00.000Z', '2026-08-01T10:00:00.000Z',
    );
    legacyDb.prepare(\`
      INSERT INTO accounts (
        id, account_key, username, display_name, password_hash, role,
        auth_version, must_change_password, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
    \`).run(
      '22222222-2222-4222-8222-222222222222', 'marco-data', 'marco.rossi', 'Marco Rossi',
      'scrypt$fixture', 'user', '2026-08-01T10:00:00.000Z', '2026-08-01T10:00:00.000Z',
    );
    legacyDb.close();

    const db = require('./src/database');
    const { getAccountByUsername } = require('./src/services/account-service');
    const columns = db.prepare('PRAGMA table_info(accounts)').all().map((row) => row.name);
    const rows = db.prepare('SELECT account_key, username, username_normalized FROM accounts ORDER BY account_key').all();
    const peruLower = getAccountByUsername(db, 'peru');
    const peruUpper = getAccountByUsername(db, 'PERU');
    const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
    console.log(JSON.stringify({
      version: Number(db.prepare('PRAGMA user_version').get().user_version),
      columns,
      rows,
      peruLower: peruLower?.username,
      sameAccount: peruLower?.id === peruUpper?.id,
      foreignKeys,
    }));
    db.close();
  `);

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(payload.version, 19);
  assert.equal(payload.columns.includes('display_name'), false);
  assert.equal(payload.columns.includes('username_normalized'), true);
  assert.deepEqual(payload.rows, [
    { account_key: 'default', username: 'Peru', username_normalized: 'peru' },
    { account_key: 'marco-data', username: 'marco.rossi', username_normalized: 'marco.rossi' },
  ]);
  assert.equal(payload.peruLower, 'Peru');
  assert.equal(payload.sameAccount, true);
  assert.deepEqual(payload.foreignKeys, []);
  fs.rmSync(root, { recursive: true, force: true });
});
