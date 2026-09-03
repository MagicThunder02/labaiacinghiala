'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const { ensurePairingSchema } = require('../src/services/pairing-service');
const { requireLocalAdminBrowser } = require('../src/middleware/account-access');
const { apiErrorHandler } = require('../src/middleware/api-error-handler');
const { createAdminPairedDevicesRouter } = require('../src/routes/admin-paired-devices');

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
    '/api/admin/paired-devices',
    requireLocalAdminBrowser,
    createAdminPairedDevicesRouter({ database: db }),
  );
  app.use(apiErrorHandler);

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  return { db, server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

function insertDevice(db, {
  id = crypto.randomUUID(),
  name = 'PC salotto',
  revokedAt = null,
  now = Date.now(),
} = {}) {
  db.prepare(`
    INSERT INTO paired_devices (
      id, public_key, fingerprint, installation_id, device_name,
      paired_at, last_seen_at, revoked_at, pairing_invite_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    id,
    `public-key-${id}`,
    `SHA256:test-${id}`,
    crypto.randomUUID(),
    name,
    now - 60_000,
    now - 5_000,
    revokedAt,
  );
  return id;
}

async function request(baseUrl, pathname, {
  method = 'GET',
  local = true,
  role = 'admin',
} = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      'X-Test-Local': local ? '1' : '0',
      'X-Test-Role': role,
    },
  });
  return { response, payload: await response.json() };
}

test('API dispositivi è disponibile solo al browser amministrativo locale', async (t) => {
  const context = await fixture();
  t.after(() => { context.server.close(); context.db.close(); });

  for (const options of [
    { local: false, role: 'admin' },
    { local: true, role: 'user' },
  ]) {
    const result = await request(context.baseUrl, '/api/admin/paired-devices', options);
    assert.equal(result.response.status, 403);
    assert.equal(result.payload.code, 'LOCAL_ADMIN_REQUIRED');
  }

  const allowed = await request(context.baseUrl, '/api/admin/paired-devices');
  assert.equal(allowed.response.status, 200);
  assert.deepEqual(allowed.payload.devices, []);
  assert.equal(allowed.response.headers.get('cache-control'), 'no-store');
});

test('API elenca solo la vista pubblica del pairing e revoca tramite la stessa funzione usata dalla CLI', async (t) => {
  const context = await fixture();
  t.after(() => { context.server.close(); context.db.close(); });

  const activeId = insertDevice(context.db, { name: 'Notebook ospite' });
  const revokedId = insertDevice(context.db, {
    name: 'Vecchio tablet',
    revokedAt: Date.now() - 10_000,
  });

  let result = await request(context.baseUrl, '/api/admin/paired-devices');
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.devices.length, 2);

  const active = result.payload.devices.find((device) => device.id === activeId);
  const revoked = result.payload.devices.find((device) => device.id === revokedId);
  assert.equal(active.deviceName, 'Notebook ospite');
  assert.equal(active.revokedAt, null);
  assert.equal(typeof active.fingerprint, 'string');
  assert.equal(typeof active.installationId, 'string');
  assert.ok(revoked.revokedAt);
  assert.equal(Object.hasOwn(active, 'publicKey'), false);
  assert.equal(Object.hasOwn(active, 'activeAccountId'), false);

  result = await request(context.baseUrl, `/api/admin/paired-devices/${activeId}/revoke`, {
    method: 'POST',
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.device.id, activeId);
  assert.ok(result.payload.device.revokedAt);

  const row = context.db.prepare('SELECT revoked_at FROM paired_devices WHERE id = ?').get(activeId);
  assert.notEqual(row.revoked_at, null);

  result = await request(context.baseUrl, `/api/admin/paired-devices/${activeId}/revoke`, {
    method: 'POST',
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.payload.code, 'DEVICE_NOT_FOUND');
});
