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
  updateAccount,
  setAccountDisabled,
} = require('../src/services/account-service');
const { hashAccountPassword } = require('../src/services/account-password-service');
const {
  AccountAuthError,
  LoginRateLimiter,
  bindAccountToDevice,
  clearDeviceAccountBinding,
  resolveDeviceAccount,
  resolveLocalAdminAccount,
  authenticateAccountCredentials,
  changeOwnAccountPassword,
} = require('../src/services/account-auth-service');
const { getProfileKey } = require('../src/utils/profile-key');

function newDb() {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  ensurePairingSchema(db);
  ensureAccountSchema(db);
  return db;
}

function insertDevice(db, {
  id = crypto.randomUUID(),
  revokedAt = null,
} = {}) {
  const now = 1_700_000_000_000;
  db.prepare(`
    INSERT INTO paired_devices (
      id, public_key, fingerprint, installation_id, device_name,
      paired_at, last_seen_at, revoked_at, pairing_invite_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    id,
    crypto.randomBytes(32).toString('base64url'),
    `SHA256:${crypto.randomBytes(16).toString('base64url')}`,
    crypto.randomUUID(),
    `Device ${id.slice(0, 6)}`,
    now,
    now,
    revokedAt,
  );
  return loadDevice(db, id);
}

function loadDevice(db, deviceId) {
  const row = db.prepare(`
    SELECT id, fingerprint, installation_id, device_name,
           active_account_id, active_account_auth_version,
           account_authenticated_at, account_binding_source
    FROM paired_devices WHERE id = ?
  `).get(deviceId);
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    installationId: row.installation_id,
    deviceName: row.device_name,
    activeAccountId: row.active_account_id,
    activeAccountAuthVersion: row.active_account_auth_version,
    accountAuthenticatedAt: row.account_authenticated_at,
    accountBindingSource: row.account_binding_source,
  };
}

function assertAccountAuthCode(fn, code) {
  assert.throws(fn, (error) => error instanceof AccountAuthError && error.code === code);
}

async function createPasswordAccount(db, {
  username = 'pietro',
  password = 'Cinghiala-password-2026',
  role = 'user',
  sections = ['films', 'music'],
  accountKey,
} = {}) {
  const passwordHash = await hashAccountPassword(password);
  return createAccount(db, {
    username,
    passwordHash,
    role,
    sections,
    ...(accountKey ? { accountKey } : {}),
  });
}

test('uno stesso account accede da più dispositivi e il profilo dati deriva dall account', async () => {
  const db = newDb();
  const account = await createPasswordAccount(db, { accountKey: 'pietro-data' });
  const first = insertDevice(db);
  const second = insertDevice(db);

  await authenticateAccountCredentials(db, {
    device: first,
    username: 'PIETRO',
    password: 'Cinghiala-password-2026',
    now: 10_000,
  });
  await authenticateAccountCredentials(db, {
    device: second,
    username: 'pietro',
    password: 'Cinghiala-password-2026',
    now: 20_000,
  });

  const firstContext = resolveDeviceAccount(db, loadDevice(db, first.id));
  const secondContext = resolveDeviceAccount(db, loadDevice(db, second.id));
  assert.equal(firstContext.account.id, account.id);
  assert.equal(secondContext.account.id, account.id);
  assert.equal(getProfileKey({
    baiaAccount: firstContext.account,
    baiaDevice: first,
    get() { return 'header-falso'; },
    query: {},
  }), 'pietro-data');

  clearDeviceAccountBinding(db, first.id);
  assertAccountAuthCode(() => resolveDeviceAccount(db, loadDevice(db, first.id)), 'ACCOUNT_REQUIRED');
  assert.equal(resolveDeviceAccount(db, loadDevice(db, second.id)).account.id, account.id);
  assert.equal(db.prepare('SELECT revoked_at FROM paired_devices WHERE id = ?').get(first.id).revoked_at, null);
  db.close();
});

test('impostare la prima password da un binding legacy invalida gli altri dispositivi ma mantiene quello corrente', async () => {
  const db = newDb();
  const admin = createAccount(db, {
    username: 'legacy-admin',
    passwordHash: 'scrypt$fixture-temporanea',
    role: 'admin',
  });
  db.prepare(`
    UPDATE accounts
    SET password_hash = NULL, must_change_password = 1
    WHERE id = ?
  `).run(admin.id);
  const account = getAccountById(db, admin.id);
  const first = insertDevice(db);
  const second = insertDevice(db);
  bindAccountToDevice(db, first.id, account, { source: 'legacy', now: 30_000 });
  bindAccountToDevice(db, second.id, account, { source: 'legacy', now: 31_000 });

  const firstContext = resolveDeviceAccount(db, loadDevice(db, first.id));
  const changed = await changeOwnAccountPassword(db, {
    account: firstContext.account,
    device: loadDevice(db, first.id),
    session: firstContext.session,
    newPassword: 'Nuova-password-amministratore-2026',
    now: 40_000,
    nowIso: '2026-08-05T12:00:00.000Z',
  });

  assert.equal(changed.account.authVersion, 2);
  assert.equal(changed.account.mustChangePassword, false);
  const rebound = loadDevice(db, first.id);
  assert.equal(rebound.activeAccountAuthVersion, 2);
  assert.equal(rebound.accountBindingSource, 'login');
  assert.equal(resolveDeviceAccount(db, rebound).account.id, account.id);

  assertAccountAuthCode(
    () => resolveDeviceAccount(db, loadDevice(db, second.id)),
    'ACCOUNT_SESSION_EXPIRED',
  );
  assert.equal(loadDevice(db, second.id).activeAccountId, null);

  const relogged = await authenticateAccountCredentials(db, {
    device: loadDevice(db, second.id),
    username: 'legacy-admin',
    password: 'Nuova-password-amministratore-2026',
    now: 50_000,
  });
  assert.equal(relogged.account.id, account.id);
  db.close();
});

test('il cambio password richiede quella corrente e invalida le altre sessioni account', async () => {
  const db = newDb();
  const account = await createPasswordAccount(db);
  const first = insertDevice(db);
  const second = insertDevice(db);
  bindAccountToDevice(db, first.id, account, { source: 'login', now: 60_000 });
  bindAccountToDevice(db, second.id, account, { source: 'login', now: 61_000 });
  const context = resolveDeviceAccount(db, loadDevice(db, first.id));

  await assert.rejects(
    changeOwnAccountPassword(db, {
      account: context.account,
      device: loadDevice(db, first.id),
      session: context.session,
      currentPassword: 'password errata',
      newPassword: 'Altra-password-valida-2026',
    }),
    (error) => error instanceof AccountAuthError && error.code === 'CURRENT_PASSWORD_INVALID',
  );

  await changeOwnAccountPassword(db, {
    account: context.account,
    device: loadDevice(db, first.id),
    session: context.session,
    currentPassword: 'Cinghiala-password-2026',
    newPassword: 'Altra-password-valida-2026',
    now: 70_000,
  });
  assertAccountAuthCode(
    () => resolveDeviceAccount(db, loadDevice(db, second.id)),
    'ACCOUNT_SESSION_EXPIRED',
  );
  db.close();
});

test('un logout concorrente non può essere annullato da un cambio password già in elaborazione', async () => {
  const db = newDb();
  const account = await createPasswordAccount(db);
  const device = insertDevice(db);
  bindAccountToDevice(db, device.id, account, { source: 'login', now: 75_000 });
  const context = resolveDeviceAccount(db, loadDevice(db, device.id));

  const changing = changeOwnAccountPassword(db, {
    account: context.account,
    device: loadDevice(db, device.id),
    session: context.session,
    currentPassword: 'Cinghiala-password-2026',
    newPassword: 'Password-che-non-deve-essere-applicata',
    now: 76_000,
  });
  clearDeviceAccountBinding(db, device.id);
  await assert.rejects(
    changing,
    (error) => error instanceof AccountAuthError && error.code === 'ACCOUNT_SESSION_EXPIRED',
  );
  assert.equal(loadDevice(db, device.id).activeAccountId, null);
  db.close();
});

test('cambi di ruolo, sezioni o stato invalidano immediatamente i binding precedenti', async () => {
  const db = newDb();
  const account = await createPasswordAccount(db);
  const device = insertDevice(db);
  bindAccountToDevice(db, device.id, account, { source: 'login', now: 80_000 });

  updateAccount(db, account.id, { sections: ['books'] });
  assertAccountAuthCode(
    () => resolveDeviceAccount(db, loadDevice(db, device.id)),
    'ACCOUNT_SESSION_EXPIRED',
  );
  assert.equal(loadDevice(db, device.id).activeAccountId, null);

  const refreshed = getAccountById(db, account.id);
  bindAccountToDevice(db, device.id, refreshed, { source: 'login', now: 81_000 });
  setAccountDisabled(db, account.id, true);
  assertAccountAuthCode(
    () => resolveDeviceAccount(db, loadDevice(db, device.id)),
    'ACCOUNT_DISABLED',
  );
  assert.equal(loadDevice(db, device.id).activeAccountId, null);
  db.close();
});

test('login non rivela account assenti o disabilitati e il browser locale usa un admin attivo', async () => {
  const db = newDb();
  const admin = await createPasswordAccount(db, {
    username: 'admin-baia',
    role: 'admin',
    accountKey: 'default',
  });
  const disabled = await createPasswordAccount(db, {
    username: 'utente-off',
  });
  setAccountDisabled(db, disabled.id, true);
  const device = insertDevice(db);

  for (const credentials of [
    { username: 'inesistente', password: 'Cinghiala-password-2026' },
    { username: 'utente-off', password: 'Cinghiala-password-2026' },
    { username: 'admin-baia', password: 'password errata' },
  ]) {
    await assert.rejects(
      authenticateAccountCredentials(db, { device, ...credentials }),
      (error) => error instanceof AccountAuthError
        && error.code === 'ACCOUNT_CREDENTIALS_INVALID'
        && error.message === 'Username o password non validi.',
    );
  }

  const local = resolveLocalAdminAccount(db);
  assert.equal(local.account.id, admin.id);
  assert.equal(local.session.localAccess, true);
  assert.equal(local.session.bindingSource, 'admin');
  db.close();
});

test('rate limit account è distinto per dispositivo e comunica Retry-After', () => {
  let now = 1000;
  const limiter = new LoginRateLimiter({
    maxFailures: 2,
    windowMs: 1000,
    blockMs: 5000,
    now: () => now,
  });

  limiter.assertAllowed('device-a');
  limiter.recordFailure('device-a');
  limiter.recordFailure('device-a');
  assert.throws(
    () => limiter.assertAllowed('device-a'),
    (error) => error instanceof AccountAuthError
      && error.code === 'LOGIN_RATE_LIMITED'
      && error.status === 429
      && error.retryAfterSeconds === 5,
  );
  assert.doesNotThrow(() => limiter.assertAllowed('device-b'));
  now = 6001;
  assert.doesNotThrow(() => limiter.assertAllowed('device-a'));
});

test('login preserva le maiuscole dello username ma confronta senza distinzione di caso', async () => {
  const db = newDb();
  const account = await createPasswordAccount(db, {
    username: 'Peru',
    password: 'Password-Peru-Baia-2026',
  });
  const lowerDevice = insertDevice(db, { name: 'PC minuscolo' });
  const upperDevice = insertDevice(db, { name: 'PC maiuscolo' });

  const lowerLogin = await authenticateAccountCredentials(db, {
    device: lowerDevice,
    username: 'peru',
    password: 'Password-Peru-Baia-2026',
  });
  const upperLogin = await authenticateAccountCredentials(db, {
    device: upperDevice,
    username: 'PERU',
    password: 'Password-Peru-Baia-2026',
  });

  assert.equal(account.username, 'Peru');
  assert.equal(lowerLogin.account.username, 'Peru');
  assert.equal(upperLogin.account.username, 'Peru');
  assert.equal(lowerLogin.account.id, upperLogin.account.id);
  db.close();
});
