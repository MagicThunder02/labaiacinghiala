'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const serverSource = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');
const databaseSource = fs.readFileSync(path.join(root, 'src', 'database.js'), 'utf8');

test('lo schema 19 registra una sola identità portabile della libreria', () => {
  assert.match(databaseSource, /const TARGET_SCHEMA_VERSION = 19/);
  assert.match(databaseSource, /CREATE TABLE IF NOT EXISTS library_identity/);
  assert.match(databaseSource, /singleton_id INTEGER PRIMARY KEY CHECK \(singleton_id = 1\)/);
  assert.match(databaseSource, /library_id TEXT NOT NULL UNIQUE/);
});

test('il server verifica l’identità prima di aprire la porta', () => {
  const identityCall = serverSource.indexOf('await ensureLibraryIdentity');
  const listenCall = serverSource.indexOf('app.listen');
  assert.ok(identityCall >= 0, 'verifica identità assente');
  assert.ok(listenCall >= 0, 'app.listen assente');
  assert.ok(identityCall < listenCall, 'la porta viene aperta prima della verifica identità');
  assert.match(serverSource, /startServer\(\)\.catch[\s\S]*process\.exit\(1\)/);
});
