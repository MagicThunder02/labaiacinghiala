'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const { ensurePairingSchema } = require('../src/services/pairing-service');
const { ensureAccountSchema, createAccount, getAccountByUsername } = require('../src/services/account-service');
const { hashAccountPassword, verifyAccountPassword } = require('../src/services/account-password-service');
const { requireAdmin } = require('../src/middleware/account-access');
const { createAdminAccountsRouter } = require('../src/routes/admin-accounts');

async function fixture() {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  ensurePairingSchema(db);
  ensureAccountSchema(db);
  const admin = createAccount(db, {
    username: 'admin',
    passwordHash: await hashAccountPassword('Password-admin-Baia-2026'),
    role: 'admin',
  });
  const user = createAccount(db, {
    username: 'utente',
    passwordHash: await hashAccountPassword('Password-utente-Baia-2026'),
    sections: ['films'],
  });

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.baiaAccount = req.get('X-Test-Role') === 'user' ? user : admin;
    next();
  });
  app.use('/api/admin/accounts', requireAdmin, createAdminAccountsRouter({ database: db }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    return res.status(500).json({ error: error.message });
  });

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  return {
    db,
    admin,
    user,
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  };
}

async function request(baseUrl, pathname, {
  method = 'GET',
  role = 'admin',
  body,
} = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      'X-Test-Role': role,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  return { response, payload };
}

test('API admin account è inaccessibile agli utenti normali', async (t) => {
  const context = await fixture();
  t.after(() => {
    context.server.close();
    context.db.close();
  });

  const result = await request(context.baseUrl, '/api/admin/accounts', { role: 'user' });
  assert.equal(result.response.status, 403);
  assert.equal(result.payload.code, 'ADMIN_REQUIRED');
});

test('API admin crea, modifica e lista account senza esporre hash password', async (t) => {
  const context = await fixture();
  t.after(() => {
    context.server.close();
    context.db.close();
  });

  let result = await request(context.baseUrl, '/api/admin/accounts', {
    method: 'POST',
    body: {
      username: 'marco',
      password: 'Password-Marco-Baia-2026',
      sections: ['music', 'manga'],
      mustChangePassword: true,
    },
  });
  assert.equal(result.response.status, 201);
  assert.equal(result.payload.account.username, 'marco');
  assert.deepEqual(result.payload.account.sections, ['music', 'manga']);
  assert.equal(Object.hasOwn(result.payload.account, 'passwordHash'), false);
  assert.equal(Object.hasOwn(result.payload.account, 'displayName'), false);

  const accountId = result.payload.account.id;
  result = await request(context.baseUrl, `/api/admin/accounts/${accountId}`, {
    method: 'PUT',
    body: {
      username: 'marco.rossi',
      role: 'user',
      sections: ['series', 'books'],
      disabled: false,
    },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.account.username, 'marco.rossi');
  assert.deepEqual(result.payload.account.sections, ['series', 'books']);

  result = await request(context.baseUrl, '/api/admin/accounts');
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.accounts.some((account) => account.id === accountId), true);
  assert.equal(result.payload.accounts.find((account) => account.id === context.admin.id).current, true);
});

test('API admin resetta password, disconnette e soft-elimina gli altri account', async (t) => {
  const context = await fixture();
  t.after(() => {
    context.server.close();
    context.db.close();
  });

  let result = await request(context.baseUrl, `/api/admin/accounts/${context.user.id}/password`, {
    method: 'PUT',
    body: {
      password: 'Password-utente-nuova-2026',
      mustChangePassword: false,
    },
  });
  assert.equal(result.response.status, 200);
  const updated = getAccountByUsername(context.db, 'utente');
  assert.equal(await verifyAccountPassword('Password-utente-nuova-2026', updated.passwordHash), true);

  result = await request(context.baseUrl, `/api/admin/accounts/${context.user.id}/logout-devices`, {
    method: 'POST',
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.loggedOutDevices, 0);

  result = await request(context.baseUrl, `/api/admin/accounts/${context.user.id}/delete`, {
    method: 'POST',
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.deleted, true);

  result = await request(context.baseUrl, '/api/admin/accounts');
  assert.equal(result.payload.accounts.some((account) => account.id === context.user.id), false);

  result = await request(context.baseUrl, '/api/admin/accounts', {
    method: 'POST',
    body: {
      username: 'UTENTE',
      password: 'Password-nuovo-utente-2026',
      sections: ['books'],
      mustChangePassword: false,
    },
  });
  assert.equal(result.response.status, 201);
  assert.equal(result.payload.account.username, 'UTENTE');
  assert.notEqual(result.payload.account.id, context.user.id);
  assert.deepEqual(result.payload.account.sections, ['books']);
});

test('API admin impedisce operazioni distruttive sul proprio account', async (t) => {
  const context = await fixture();
  t.after(() => {
    context.server.close();
    context.db.close();
  });

  for (const [pathname, method, body] of [
    [`/api/admin/accounts/${context.admin.id}`, 'PUT', { role: 'user' }],
    [`/api/admin/accounts/${context.admin.id}/password`, 'PUT', { password: 'Password-nuova-admin-2026' }],
    [`/api/admin/accounts/${context.admin.id}/logout-devices`, 'POST', undefined],
    [`/api/admin/accounts/${context.admin.id}/delete`, 'POST', undefined],
  ]) {
    const result = await request(context.baseUrl, pathname, { method, body });
    assert.equal(result.response.status, 409);
    assert.equal(result.payload.code, 'ACCOUNT_SELF_OPERATION_FORBIDDEN');
  }
});
