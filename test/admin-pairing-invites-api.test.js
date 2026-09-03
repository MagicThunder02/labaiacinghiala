'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const { ensurePairingSchema } = require('../src/services/pairing-service');
const { requireLocalAdminBrowser } = require('../src/middleware/account-access');
const { apiErrorHandler } = require('../src/middleware/api-error-handler');
const { createAdminPairingInvitesRouter } = require('../src/routes/admin-pairing-invites');

async function fixture() {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  ensurePairingSchema(db);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.baiaAccount = { id: 'admin-test', role: req.get('X-Test-Role') || 'admin' };
    req.baiaLocalAccess = req.get('X-Test-Local') === '1';
    next();
  });
  app.use(
    '/api/admin/pairing-invites',
    requireLocalAdminBrowser,
    createAdminPairingInvitesRouter({ database: db }),
  );
  app.use(apiErrorHandler);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  return { db, server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function request(baseUrl, pathname, {
  method = 'GET',
  local = true,
  role = 'admin',
  body,
} = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      'X-Test-Local': local ? '1' : '0',
      'X-Test-Role': role,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, payload: await response.json() };
}

test('API inviti è disponibile solo al browser amministrativo locale', async (t) => {
  const context = await fixture();
  t.after(() => { context.server.close(); context.db.close(); });

  for (const options of [
    { local: false, role: 'admin' },
    { local: true, role: 'user' },
  ]) {
    const result = await request(context.baseUrl, '/api/admin/pairing-invites', options);
    assert.equal(result.response.status, 403);
    assert.equal(result.payload.code, 'LOCAL_ADMIN_REQUIRED');
  }

  const allowed = await request(context.baseUrl, '/api/admin/pairing-invites');
  assert.equal(allowed.response.status, 200);
  assert.deepEqual(allowed.payload.invites, []);
  assert.equal(allowed.response.headers.get('cache-control'), 'no-store');
});

test('API crea il bearer una sola volta, lo elenca senza segreti e consente la revoca', async (t) => {
  const context = await fixture();
  t.after(() => { context.server.close(); context.db.close(); });

  let result = await request(context.baseUrl, '/api/admin/pairing-invites', {
    method: 'POST',
    body: { ttlMinutes: 30 },
  });
  assert.equal(result.response.status, 201);
  assert.match(result.payload.invite.token, /^baia1\./);
  const { id, token } = result.payload.invite;

  const databaseRow = context.db.prepare('SELECT token_hash, revoked_at FROM pairing_invites WHERE id = ?').get(id);
  assert.equal(typeof databaseRow.token_hash, 'string');
  assert.equal(databaseRow.revoked_at, null);
  assert.equal(JSON.stringify(databaseRow).includes(token), false);

  result = await request(context.baseUrl, '/api/admin/pairing-invites');
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.invites.length, 1);
  assert.equal(result.payload.invites[0].status, 'active');
  assert.equal(Object.hasOwn(result.payload.invites[0], 'token'), false);
  assert.equal(JSON.stringify(result.payload).includes(token), false);

  result = await request(context.baseUrl, `/api/admin/pairing-invites/${id}/revoke`, {
    method: 'POST',
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.invite.status, 'revoked');

  result = await request(context.baseUrl, `/api/admin/pairing-invites/${id}/revoke`, {
    method: 'POST',
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.payload.code, 'INVITE_NOT_ACTIVE');
});

test('JSON malformato restituisce 400 esplicito invece di un errore interno', async (t) => {
  const context = await fixture();
  t.after(() => { context.server.close(); context.db.close(); });

  const response = await fetch(`${context.baseUrl}/api/admin/pairing-invites`, {
    method: 'POST',
    headers: {
      'X-Test-Local': '1',
      'X-Test-Role': 'admin',
      'Content-Type': 'application/json',
    },
    body: '{ttlMinutes:5}',
  });
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.equal(payload.code, 'INVALID_JSON');
  assert.equal(payload.error, 'Corpo JSON non valido.');
});


test('API inviti aggiunge il bootstrap Direct solo quando endpoint pubblico e pin sono configurati', async (t) => {
  const oldEndpoint = process.env.BAIA_PUBLIC_CONNECTOR_ENDPOINT;
  const oldFingerprint = process.env.BAIA_CONNECTOR_SERVER_FINGERPRINT;
  process.env.BAIA_PUBLIC_CONNECTOR_ENDPOINT = 'https://baia.example.test:443';
  process.env.BAIA_CONNECTOR_SERVER_FINGERPRINT = 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  t.after(() => {
    if (oldEndpoint === undefined) delete process.env.BAIA_PUBLIC_CONNECTOR_ENDPOINT;
    else process.env.BAIA_PUBLIC_CONNECTOR_ENDPOINT = oldEndpoint;
    if (oldFingerprint === undefined) delete process.env.BAIA_CONNECTOR_SERVER_FINGERPRINT;
    else process.env.BAIA_CONNECTOR_SERVER_FINGERPRINT = oldFingerprint;
  });

  const context = await fixture();
  t.after(() => { context.server.close(); context.db.close(); });
  const result = await request(context.baseUrl, '/api/admin/pairing-invites', {
    method: 'POST',
    body: { ttlMinutes: 15 },
  });

  assert.equal(result.response.status, 201);
  assert.match(result.payload.invite.token, /^baia1\./);
  assert.match(result.payload.invite.directBootstrap, /^baia-direct1\./);
  const encoded = result.payload.invite.directBootstrap.slice('baia-direct1.'.length);
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  assert.equal(payload.connectorEndpoint, 'https://baia.example.test');
  assert.equal(payload.serverFingerprint, process.env.BAIA_CONNECTOR_SERVER_FINGERPRINT);
  assert.equal(payload.inviteToken, result.payload.invite.token);
});
