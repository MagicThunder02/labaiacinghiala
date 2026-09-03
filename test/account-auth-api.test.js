'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const { ensurePairingSchema } = require('../src/services/pairing-service');
const { ensureAccountSchema, createAccount } = require('../src/services/account-service');
const { hashAccountPassword } = require('../src/services/account-password-service');
const { createAuthRouter } = require('../src/routes/auth');
const { createAccountAuth } = require('../src/middleware/account-auth');
const { requirePasswordChangeCompleted } = require('../src/middleware/account-access');
const { getProfileKey } = require('../src/utils/profile-key');

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

async function fixture({ mustChangePassword = false } = {}) {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  ensurePairingSchema(db);
  ensureAccountSchema(db);
  const account = createAccount(db, {
    username: 'pietro',
    passwordHash: await hashAccountPassword('Password-account-Baia-2026'),
    sections: ['films', 'music'],
    accountKey: 'pietro-data',
    mustChangePassword,
  });
  const deviceId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO paired_devices (
      id, public_key, fingerprint, installation_id, device_name,
      paired_at, last_seen_at, revoked_at, pairing_invite_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
  `).run(
    deviceId,
    crypto.randomBytes(32).toString('base64url'),
    'SHA256:api-test',
    crypto.randomUUID(),
    'PC API test',
    Date.now(),
    Date.now(),
  );

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const requestedDevice = req.get('X-Test-Device');
    if (requestedDevice === deviceId) req.baiaDevice = loadDevice(db, deviceId);
    if (req.get('X-Test-Local') === '1') req.baiaLocalAccess = true;
    next();
  });
  app.use('/api/auth', createAuthRouter({ database: db }));
  app.get('/api/app-info', (req, res) => res.json({ ok: true }));
  app.use('/api', createAccountAuth({ database: db }));
  app.use('/api', requirePasswordChangeCompleted);
  app.get('/api/protected', (req, res) => {
    res.json({ accountId: req.baiaAccount.id, profileKey: getProfileKey(req) });
  });
  for (const pathname of ['/api/movies', '/api/music', '/api/reading', '/api/admin/accounts']) {
    app.get(pathname, (req, res) => res.json({ ok: true, pathname }));
  }
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    return res.status(500).json({ error: error.message });
  });

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { db, account, deviceId, server, baseUrl };
}

async function request(baseUrl, pathname, {
  method = 'GET',
  deviceId = null,
  local = false,
  body,
} = {}) {
  const headers = {};
  if (deviceId) headers['X-Test-Device'] = deviceId;
  if (local) headers['X-Test-Local'] = '1';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json();
  return { response, payload };
}

test('API account esegue login, me e logout senza token JavaScript', async (t) => {
  const context = await fixture();
  t.after(() => {
    context.server.close();
    context.db.close();
  });

  let result = await request(context.baseUrl, '/api/auth/me', { deviceId: context.deviceId });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.authenticated, false);
  assert.equal(result.payload.reasonCode, 'ACCOUNT_REQUIRED');

  result = await request(context.baseUrl, '/api/protected', { deviceId: context.deviceId });
  assert.equal(result.response.status, 401);
  assert.equal(result.payload.code, 'ACCOUNT_REQUIRED');

  result = await request(context.baseUrl, '/api/auth/login', {
    method: 'POST',
    deviceId: context.deviceId,
    body: { username: 'pietro', password: 'Password-account-Baia-2026' },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.authenticated, true);
  assert.equal(result.payload.account.username, 'pietro');
  assert.equal(Object.hasOwn(result.payload.account, 'displayName'), false);
  assert.equal(result.payload.account.passwordConfigured, true);
  assert.deepEqual(result.payload.sections, ['films', 'music']);
  assert.equal(Object.hasOwn(result.payload, 'token'), false);

  result = await request(context.baseUrl, '/api/protected', { deviceId: context.deviceId });
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.payload, {
    accountId: context.account.id,
    profileKey: 'pietro-data',
  });

  result = await request(context.baseUrl, '/api/auth/logout', {
    method: 'POST',
    deviceId: context.deviceId,
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.loggedOut, true);

  result = await request(context.baseUrl, '/api/auth/me', { deviceId: context.deviceId });
  assert.equal(result.payload.authenticated, false);
});

test('API cambio password mantiene il dispositivo corrente e rende inutilizzabile la password precedente', async (t) => {
  const context = await fixture();
  t.after(() => {
    context.server.close();
    context.db.close();
  });

  let result = await request(context.baseUrl, '/api/auth/login', {
    method: 'POST',
    deviceId: context.deviceId,
    body: { username: 'pietro', password: 'Password-account-Baia-2026' },
  });
  assert.equal(result.response.status, 200);

  result = await request(context.baseUrl, '/api/auth/password', {
    method: 'PUT',
    deviceId: context.deviceId,
    body: {
      currentPassword: 'password errata',
      newPassword: 'Password-account-nuova-2026',
    },
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.payload.code, 'CURRENT_PASSWORD_INVALID');

  result = await request(context.baseUrl, '/api/auth/password', {
    method: 'PUT',
    deviceId: context.deviceId,
    body: {
      currentPassword: 'Password-account-Baia-2026',
      newPassword: 'Password-account-nuova-2026',
    },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.authenticated, true);
  assert.equal(result.payload.account.mustChangePassword, false);

  await request(context.baseUrl, '/api/auth/logout', {
    method: 'POST',
    deviceId: context.deviceId,
  });
  result = await request(context.baseUrl, '/api/auth/login', {
    method: 'POST',
    deviceId: context.deviceId,
    body: { username: 'pietro', password: 'Password-account-Baia-2026' },
  });
  assert.equal(result.response.status, 401);
  result = await request(context.baseUrl, '/api/auth/login', {
    method: 'POST',
    deviceId: context.deviceId,
    body: { username: 'pietro', password: 'Password-account-nuova-2026' },
  });
  assert.equal(result.response.status, 200);
});



test('must_change_password blocca cataloghi e API admin ma lascia disponibili me, password, logout e app-info', async (t) => {
  const context = await fixture({ mustChangePassword: true });
  t.after(() => {
    context.server.close();
    context.db.close();
  });

  let result = await request(context.baseUrl, '/api/auth/login', {
    method: 'POST',
    deviceId: context.deviceId,
    body: { username: 'pietro', password: 'Password-account-Baia-2026' },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.account.mustChangePassword, true);

  result = await request(context.baseUrl, '/api/auth/me', { deviceId: context.deviceId });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.authenticated, true);
  assert.equal(result.payload.account.mustChangePassword, true);

  result = await request(context.baseUrl, '/api/app-info', { deviceId: context.deviceId });
  assert.equal(result.response.status, 200);

  result = await request(context.baseUrl, '/api/auth/login', {
    method: 'POST',
    deviceId: context.deviceId,
    body: { username: 'pietro', password: 'Password-account-Baia-2026' },
  });
  assert.equal(result.response.status, 403);
  assert.equal(result.payload.code, 'PASSWORD_CHANGE_REQUIRED');

  for (const pathname of ['/api/protected', '/api/movies', '/api/music', '/api/reading', '/api/admin/accounts']) {
    result = await request(context.baseUrl, pathname, { deviceId: context.deviceId });
    assert.equal(result.response.status, 403, pathname);
    assert.deepEqual(result.payload, {
      error: 'Devi impostare una nuova password prima di continuare.',
      code: 'PASSWORD_CHANGE_REQUIRED',
    });
  }

  result = await request(context.baseUrl, '/api/auth/password', {
    method: 'PUT',
    deviceId: context.deviceId,
    body: {
      currentPassword: 'Password-account-Baia-2026',
      newPassword: 'Password-personale-Baia-2026',
    },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.account.mustChangePassword, false);

  for (const pathname of ['/api/protected', '/api/movies', '/api/music', '/api/reading', '/api/admin/accounts']) {
    result = await request(context.baseUrl, pathname, { deviceId: context.deviceId });
    assert.equal(result.response.status, 200, pathname);
  }

  result = await request(context.baseUrl, '/api/auth/logout', {
    method: 'POST',
    deviceId: context.deviceId,
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.loggedOut, true);
});

test('browser locale riceve un principal admin senza creare una sessione nel client', async (t) => {
  const context = await fixture();
  t.after(() => {
    context.server.close();
    context.db.close();
  });
  context.db.prepare("UPDATE accounts SET role = 'admin' WHERE id = ?").run(context.account.id);

  const result = await request(context.baseUrl, '/api/auth/me', { local: true });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.authenticated, true);
  assert.equal(result.payload.localAccess, true);
  assert.equal(result.payload.account.role, 'admin');
  assert.equal(result.payload.capabilities.manageAccounts, true);
});

test('server monta auth dopo deviceAuth, app-info prima di accountAuth e cataloghi dopo accountAuth', () => {
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const devicePosition = serverSource.indexOf("app.use('/api', deviceAuth)");
  const authPosition = serverSource.indexOf("app.use('/api/auth', createAuthRouter");
  const appInfoPosition = serverSource.indexOf("app.use('/api/app-info', appInfoRouter)");
  const accountPosition = serverSource.indexOf("app.use('/api', createAccountAuth");
  const passwordPosition = serverSource.indexOf("app.use('/api', requirePasswordChangeCompleted)");
  const moviesPosition = serverSource.indexOf("app.use('/api/movies', createMovieAccess");

  assert.ok(devicePosition >= 0);
  assert.ok(authPosition > devicePosition);
  assert.ok(appInfoPosition > authPosition);
  assert.ok(accountPosition > appInfoPosition);
  assert.ok(passwordPosition > accountPosition);
  assert.ok(moviesPosition > passwordPosition);
});
