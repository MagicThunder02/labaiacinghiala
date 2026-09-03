'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { ensurePairingSchema } = require('../src/services/pairing-service');
const {
  ensureAccountSchema,
  createAccount,
  getAccountById,
} = require('../src/services/account-service');
const {
  hashAccountPassword,
  verifyAccountPassword,
} = require('../src/services/account-password-service');
const { bindAccountToDevice } = require('../src/services/account-auth-service');
const {
  AccountAdminError,
  listManagedAccounts,
  createManagedAccount,
  updateManagedAccount,
  resetManagedPassword,
  logoutManagedAccountDevices,
  deleteManagedAccount,
} = require('../src/services/account-admin-service');

function newDb() {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  ensurePairingSchema(db);
  ensureAccountSchema(db);
  return db;
}

function insertDevice(db, name) {
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO paired_devices (
      id, public_key, fingerprint, installation_id, device_name,
      paired_at, last_seen_at, revoked_at, pairing_invite_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
  `).run(
    id,
    crypto.randomBytes(32).toString('base64url'),
    `SHA256:${id}`,
    crypto.randomUUID(),
    name,
    Date.now(),
    Date.now(),
  );
  return id;
}

async function createAdmin(db, username = 'admin') {
  return createAccount(db, {
    username,
    passwordHash: await hashAccountPassword('Password-admin-Baia-2026'),
    role: 'admin',
  });
}

function assertAdminCode(fn, code) {
  assert.throws(fn, (error) => error instanceof AccountAdminError && error.code === code);
}

async function assertAdminCodeAsync(fn, code) {
  await assert.rejects(fn, (error) => error instanceof AccountAdminError && error.code === code);
}

test('creazione e lista amministrativa non espongono hash e contano solo sessioni valide', async () => {
  const db = newDb();
  const admin = await createAdmin(db);
  const account = await createManagedAccount(db, {
    username: 'marco',
    password: 'Password-Marco-Baia-2026',
    sections: ['films', 'books'],
    mustChangePassword: true,
  }, { currentAccountId: admin.id });

  const deviceId = insertDevice(db, 'PC Marco');
  bindAccountToDevice(db, deviceId, account.id);

  let listed = listManagedAccounts(db, { currentAccountId: admin.id });
  const managed = listed.find((item) => item.id === account.id);
  assert.deepEqual(managed.sections, ['films', 'books']);
  assert.equal(managed.passwordConfigured, true);
  assert.equal(managed.mustChangePassword, true);
  assert.equal(managed.activeDeviceCount, 1);
  assert.equal(Object.hasOwn(managed, 'passwordHash'), false);
  assert.equal(listed.find((item) => item.id === admin.id).current, true);

  db.prepare('UPDATE accounts SET auth_version = auth_version + 1 WHERE id = ?').run(account.id);
  listed = listManagedAccounts(db, { currentAccountId: admin.id });
  assert.equal(listed.find((item) => item.id === account.id).activeDeviceCount, 0);
  db.close();
});

test('modifica autorizzazioni o stato invalida i dispositivi senza alterare account e device', async () => {
  const db = newDb();
  const admin = await createAdmin(db);
  const user = await createManagedAccount(db, {
    username: 'luca',
    password: 'Password-Luca-Baia-2026',
    sections: ['music'],
  });
  const firstDevice = insertDevice(db, 'PC Luca');
  const secondDevice = insertDevice(db, 'Telefono Luca');
  bindAccountToDevice(db, firstDevice, user.id);
  bindAccountToDevice(db, secondDevice, user.id);

  const updated = updateManagedAccount(db, admin.id, user.id, {
    username: 'Luca.R',
    sections: ['series', 'manga'],
    disabled: false,
  });
  assert.equal(updated.username, 'Luca.R');
  assert.deepEqual(updated.sections, ['series', 'manga']);
  assert.equal(updated.activeDeviceCount, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM paired_devices WHERE active_account_id = ?').get(user.id).count, 0);

  const disabled = updateManagedAccount(db, admin.id, user.id, { disabled: true });
  assert.equal(disabled.disabled, true);
  const enabled = updateManagedAccount(db, admin.id, user.id, { disabled: false });
  assert.equal(enabled.disabled, false);
  db.close();
});

test('reset password amministrativo invalida tutte le sessioni e può richiedere il cambio al login', async () => {
  const db = newDb();
  const admin = await createAdmin(db);
  const oldHash = await hashAccountPassword('Password-vecchia-Baia-2026');
  const user = createAccount(db, {
    username: 'anna',
    passwordHash: oldHash,
    sections: ['films'],
  });
  const deviceId = insertDevice(db, 'PC Anna');
  bindAccountToDevice(db, deviceId, user.id);

  const reset = await resetManagedPassword(db, admin.id, user.id, {
    password: 'Password-nuova-Baia-2026',
    mustChangePassword: true,
  });
  assert.equal(reset.activeDeviceCount, 0);
  assert.equal(reset.mustChangePassword, true);
  assert.equal(db.prepare('SELECT active_account_id FROM paired_devices WHERE id = ?').get(deviceId).active_account_id, null);

  const current = getAccountById(db, user.id);
  assert.equal(await verifyAccountPassword('Password-vecchia-Baia-2026', current.passwordHash), false);
  assert.equal(await verifyAccountPassword('Password-nuova-Baia-2026', current.passwordHash), true);
  db.close();
});

test('operazioni distruttive sul proprio account sono bloccate e l ultimo admin resta protetto', async () => {
  const db = newDb();
  const admin = await createAdmin(db);

  assertAdminCode(() => updateManagedAccount(db, admin.id, admin.id, { role: 'user' }), 'ACCOUNT_SELF_OPERATION_FORBIDDEN');
  assertAdminCode(() => updateManagedAccount(db, admin.id, admin.id, { disabled: true }), 'ACCOUNT_SELF_OPERATION_FORBIDDEN');
  assertAdminCode(() => logoutManagedAccountDevices(db, admin.id, admin.id), 'ACCOUNT_SELF_OPERATION_FORBIDDEN');
  assertAdminCode(() => deleteManagedAccount(db, admin.id, admin.id), 'ACCOUNT_SELF_OPERATION_FORBIDDEN');
  await assertAdminCodeAsync(
    () => resetManagedPassword(db, admin.id, admin.id, { password: 'Password-nuova-admin-2026' }),
    'ACCOUNT_SELF_OPERATION_FORBIDDEN',
  );

  const secondAdmin = await createAdmin(db, 'admin-due');
  const deleted = deleteManagedAccount(db, admin.id, secondAdmin.id);
  assert.equal(deleted.deleted, true);
  assert.equal(getAccountById(db, secondAdmin.id), null);
  db.close();
});

test('disconnessione dispositivi e soft delete non revocano le identità device', async () => {
  const db = newDb();
  const admin = await createAdmin(db);
  const user = await createManagedAccount(db, {
    username: 'giulia',
    password: 'Password-Giulia-Baia-2026',
    sections: ['comics'],
  });
  const deviceId = insertDevice(db, 'PC Giulia');
  bindAccountToDevice(db, deviceId, user.id);

  const logout = logoutManagedAccountDevices(db, admin.id, user.id);
  assert.equal(logout.loggedOutDevices, 1);
  let device = db.prepare('SELECT revoked_at, active_account_id FROM paired_devices WHERE id = ?').get(deviceId);
  assert.equal(device.revoked_at, null);
  assert.equal(device.active_account_id, null);

  bindAccountToDevice(db, deviceId, user.id);
  const deleted = deleteManagedAccount(db, admin.id, user.id);
  assert.equal(deleted.disconnectedDevices, 1);
  device = db.prepare('SELECT revoked_at, active_account_id FROM paired_devices WHERE id = ?').get(deviceId);
  assert.equal(device.revoked_at, null);
  assert.equal(device.active_account_id, null);
  db.close();
});
