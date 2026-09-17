'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createApp } = require('../src/app');
const { closeServer, startServer } = require('../src/server');

function emptyRouters() {
  const names = [
    'pairing', 'auth', 'appInfo', 'adminAccounts', 'adminPairingInvites',
    'adminPairedDevices', 'movies', 'series', 'reading', 'music', 'library',
    'userState', 'musicMetadata', 'metadataEditor', 'contentUpload',
  ];
  return Object.fromEntries(names.map((name) => [name, express.Router()]));
}

function fakeDatabase() {
  return {
    closed: false,
    prepare() {
      return { get: () => undefined };
    },
    close() {
      this.closed = true;
    },
  };
}

test('createApp costruisce Express con dipendenze iniettate senza aprire socket', async () => {
  const database = fakeDatabase();
  const app = createApp({
    database,
    config: {
      appDisplayName: 'Baia test',
      projectRoot: __dirname,
    },
    routers: emptyRouters(),
    deviceAuth: (req, res, next) => next(),
    staticRoot: __dirname,
  });

  assert.equal(app.get('trust proxy'), false);
  assert.equal(app.enabled('x-powered-by'), false);

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, name: 'Baia test' });
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  assert.equal(database.closed, false);
});

test('startServer esegue bootstrap e shutdown con servizi sostituibili', async () => {
  const database = fakeDatabase();
  const calls = [];
  const app = express().get('/probe', (req, res) => res.json({ ok: true }));
  const runtime = await startServer({
    app,
    database,
    config: {
      appDisplayName: 'Baia test',
      host: '127.0.0.1',
      port: 0,
      libraryPath: 'library-test',
      databasePath: 'database-test',
      verifyLibraryOnStart: true,
    },
    initializeLibraryStorage: async () => {
      calls.push('storage');
      return { available: true };
    },
    ensureLibraryIdentity: async ({ database: selectedDatabase }) => {
      assert.equal(selectedDatabase, database);
      calls.push('identity');
      return { libraryId: 'library-id', initialized: false };
    },
    reconcileLibraryAvailability: async () => {
      calls.push('reconcile');
      return { storageAvailable: true, checked: 0, unavailable: 0, restored: 0 };
    },
    scheduleDailyBackups: () => calls.push('backups'),
    logger: { log() {}, warn() {}, error() {} },
    httpTimeouts: { requestTimeoutMs: 1000, uploadIdleTimeoutMs: 1000 },
  });

  const { port } = runtime.server.address();
  const response = await fetch(`http://127.0.0.1:${port}/probe`);
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ['storage', 'identity', 'backups', 'reconcile']);
  assert.equal(runtime.server.requestTimeout, 0);

  await closeServer(runtime.server, database);
  assert.equal(database.closed, true);
});

test('closeServer forza le connessioni residue e chiude SQLite al timeout', async () => {
  const database = fakeDatabase();
  let forced = false;
  const server = {
    close() {},
    closeAllConnections() {
      forced = true;
    },
  };

  await assert.rejects(
    closeServer(server, database, { timeoutMs: 5 }),
    /Timeout durante l'arresto/,
  );
  assert.equal(forced, true);
  assert.equal(database.closed, true);
});
