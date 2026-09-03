'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const {
  AccountError,
  ensureAccountSchema,
  createAccount,
  getAccountByUsername,
  listAccounts,
  updateAccount,
  setAccountPasswordHash,
  setAccountDisabled,
  softDeleteAccount,
} = require('../src/services/account-service');

function newDb() {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  ensureAccountSchema(db);
  return db;
}

function assertAccountCode(fn, code) {
  assert.throws(fn, (error) => error instanceof AccountError && error.code === code);
}

test('crea account distinti dai dispositivi con chiave dati immutabile e sezioni esplicite', () => {
  const db = newDb();
  const account = createAccount(db, {
    username: 'Pietro',
    passwordHash: 'scrypt$fixture',
    sections: ['music', 'films', 'music'],
  });

  assert.match(account.id, /^[0-9a-f-]{36}$/i);
  assert.match(account.accountKey, /^[0-9a-f-]{36}$/i);
  assert.equal(account.username, 'Pietro');
  assert.equal(account.role, 'user');
  assert.equal(account.authVersion, 1);
  assert.deepEqual(account.sections, ['films', 'music']);
  assert.equal(getAccountByUsername(db, 'PIETRO').id, account.id);
  db.close();
});

test('username e ruoli applicano vincoli coerenti e case-insensitive', () => {
  const db = newDb();
  createAccount(db, {
    username: 'admin',
    passwordHash: 'scrypt$fixture',
    role: 'admin',
  });

  assertAccountCode(() => createAccount(db, {
    username: 'ADMIN',
    passwordHash: 'scrypt$fixture',
  }), 'USERNAME_EXISTS');
  assertAccountCode(() => createAccount(db, {
    username: 'Admin Baia',
    passwordHash: 'scrypt$fixture',
  }), 'USERNAME_INVALID');
  assertAccountCode(() => createAccount(db, {
    username: 'utente',
    passwordHash: 'scrypt$fixture',
    role: 'superadmin',
  }), 'ROLE_INVALID');
  db.close();
});

test('le sezioni esplicite di un admin restano tutte senza invalidare inutilmente la sessione', () => {
  const db = newDb();
  const admin = createAccount(db, {
    username: 'admin',
    passwordHash: 'scrypt$fixture',
    role: 'admin',
  });

  const updated = updateAccount(db, admin.id, { sections: ['films'] });
  assert.equal(updated.authVersion, admin.authVersion);
  assert.deepEqual(updated.sections, ['films', 'series', 'music', 'books', 'comics', 'manga']);
  db.close();
});

test('le modifiche di sicurezza incrementano auth_version e l’ultimo admin resta protetto', () => {
  const db = newDb();
  const firstAdmin = createAccount(db, {
    username: 'admin-one',
    passwordHash: 'scrypt$fixture-one',
    role: 'admin',
  });

  assertAccountCode(() => updateAccount(db, firstAdmin.id, { role: 'user' }), 'LAST_ADMIN_REQUIRED');
  assertAccountCode(() => setAccountDisabled(db, firstAdmin.id, true), 'LAST_ADMIN_REQUIRED');
  assertAccountCode(() => softDeleteAccount(db, firstAdmin.id), 'LAST_ADMIN_REQUIRED');

  createAccount(db, {
    username: 'admin-two',
    passwordHash: 'scrypt$fixture-two',
    role: 'admin',
  });

  const demoted = updateAccount(db, firstAdmin.id, {
    role: 'user',
    sections: ['books'],
  });
  assert.equal(demoted.role, 'user');
  assert.equal(demoted.authVersion, 2);
  assert.deepEqual(demoted.sections, ['books']);

  const passwordChanged = setAccountPasswordHash(db, firstAdmin.id, 'scrypt$fixture-new');
  assert.equal(passwordChanged.authVersion, 3);

  const disabled = setAccountDisabled(db, firstAdmin.id, true);
  assert.equal(disabled.authVersion, 4);
  assert.notEqual(disabled.disabledAt, null);

  const deleted = softDeleteAccount(db, firstAdmin.id);
  assert.equal(deleted.authVersion, 5);
  assert.notEqual(deleted.deletedAt, null);
  assert.equal(listAccounts(db).length, 1);
  db.close();
});


test('soft delete libera lo username senza riutilizzare identità o dati del vecchio account', () => {
  const db = newDb();
  createAccount(db, {
    username: 'admin',
    passwordHash: 'scrypt$fixture-admin',
    role: 'admin',
  });
  const original = createAccount(db, {
    username: 'marco',
    passwordHash: 'scrypt$fixture-old',
    sections: ['films'],
  });

  const deleted = softDeleteAccount(db, original.id);
  assert.equal(deleted.username, 'marco');
  const archivedRow = db.prepare(`
    SELECT username, deleted_username AS deletedUsername, deleted_at AS deletedAt
    FROM accounts WHERE id = ?
  `).get(original.id);
  assert.match(archivedRow.username, /^__deleted__/);
  assert.equal(archivedRow.deletedUsername, 'marco');
  assert.notEqual(archivedRow.deletedAt, null);

  const replacement = createAccount(db, {
    username: 'MARCO',
    passwordHash: 'scrypt$fixture-new',
    sections: ['books'],
  });
  assert.equal(replacement.username, 'MARCO');
  assert.notEqual(replacement.id, original.id);
  assert.notEqual(replacement.accountKey, original.accountKey);
  assert.deepEqual(replacement.sections, ['books']);
  assert.deepEqual(getAccountByUsername(db, 'marco').sections, ['books']);
  assert.equal(getAccountByUsername(db, 'marco', { includeDeleted: true }).id, replacement.id);
  db.close();
});
