'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isPairingRedeemRequest,
  isRelativeApiPath,
  parseApiTransportResponse,
  parseAppUpdateProgress,
  parseAppUpdateStatus,
  parseCoreBootstrap,
} = require('../shared/api-contracts');

test('i contratti condivisi accettano soltanto path API relativi', () => {
  assert.equal(isRelativeApiPath('/api/music/search?q=baia'), true);
  assert.equal(isRelativeApiPath('https://example.invalid/api/music'), false);
  assert.equal(isRelativeApiPath('/api/../admin'), false);
  assert.equal(isRelativeApiPath('/api/music#fragment'), false);
});

test('il contratto pairing verifica forma UUID e dimensioni Ed25519', () => {
  const request = {
    inviteToken: 'baia1.550e8400-e29b-41d4-a716-446655440000.secret',
    installationId: '550e8400-e29b-41d4-a716-446655440001',
    publicKey: 'A'.repeat(43),
    signature: 'B'.repeat(86),
    deviceName: 'iPhone test',
  };
  assert.equal(isPairingRedeemRequest(request), true);
  assert.equal(isPairingRedeemRequest({ ...request, publicKey: 'short' }), false);
});

test('risposte Core e bootstrap vengono validati prima dell uso frontend', () => {
  assert.deepEqual(parseApiTransportResponse({
    status: 200,
    ok: true,
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }), {
    status: 200,
    ok: true,
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.throws(() => parseApiTransportResponse({ status: 200, ok: true }), /non valida/);
  assert.equal(parseCoreBootstrap({
    coreVersion: '0.5.0',
    platform: 'ios',
    apiBaseUrl: 'http://127.0.0.1:3000',
    transport: 'direct',
    installationId: '550e8400-e29b-41d4-a716-446655440001',
  }).platform, 'ios');
});

test('lo stato aggiornamento del client viene validato prima di finire nella UI', () => {
  assert.deepEqual(parseAppUpdateStatus({
    supported: true,
    available: true,
    currentVersion: '0.5.0',
    latestVersion: '0.6.0',
    notes: 'Correzioni',
    publishedAt: '2026-09-18T10:00:00Z',
    unsupportedReason: null,
  }), {
    supported: true,
    available: true,
    currentVersion: '0.5.0',
    latestVersion: '0.6.0',
    notes: 'Correzioni',
    publishedAt: '2026-09-18T10:00:00Z',
    unsupportedReason: null,
  });

  assert.deepEqual(parseAppUpdateStatus({
    supported: false,
    available: false,
    currentVersion: '0.5.0',
    unsupportedReason: 'Pacchetto di sistema',
  }), {
    supported: false,
    available: false,
    currentVersion: '0.5.0',
    latestVersion: null,
    notes: null,
    publishedAt: null,
    unsupportedReason: 'Pacchetto di sistema',
  });

  assert.throws(
    () => parseAppUpdateStatus({ supported: true, available: true, currentVersion: '0.5.0' }),
    /senza versione utilizzabile/,
  );
  assert.throws(() => parseAppUpdateStatus({ supported: true, available: false }), /non valido/);
});

test('avanzamento aggiornamento accetta solo le fasi note e valori utilizzabili', () => {
  assert.deepEqual(parseAppUpdateProgress({ phase: 'download', downloaded: 512, total: 1024 }), {
    phase: 'download',
    downloaded: 512,
    total: 1024,
  });
  assert.deepEqual(parseAppUpdateProgress({ phase: 'install', downloaded: -5, total: 0 }), {
    phase: 'install',
    downloaded: 0,
    total: null,
  });
  assert.throws(() => parseAppUpdateProgress({ phase: 'reboot' }), /non valido/);
});
