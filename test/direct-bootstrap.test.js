'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createDirectBootstrapInvite,
  directBootstrapFromEnvironment,
  normalizePublicConnectorEndpoint,
} = require('../src/direct-bootstrap');

const TOKEN = 'baia1.550e8400-e29b-41d4-a716-446655440000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PIN = 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

test('bootstrap Direct incorpora solo endpoint pubblico 443, pin e token interno', () => {
  const value = createDirectBootstrapInvite({
    inviteToken: TOKEN,
    connectorEndpoint: 'https://baia.example.test:443',
    serverFingerprint: PIN,
  });
  assert.match(value, /^baia-direct1\./);

  const payload = JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString('utf8'));
  assert.deepEqual(payload, {
    version: 1,
    connectorEndpoint: 'https://baia.example.test',
    serverFingerprint: PIN,
    inviteToken: TOKEN,
  });
});

test('endpoint Direct rifiuta LAN, localhost, porte arbitrarie e credenziali', () => {
  assert.equal(normalizePublicConnectorEndpoint('https://baia.example.test'), 'https://baia.example.test');
  for (const endpoint of [
    'https://192.168.1.50:443',
    'https://127.0.0.1:443',
    'https://localhost:443',
    'https://baia.example.test:444',
    'https://user:pass@baia.example.test:443',
    'https://baia.example.test:443/api',
  ]) {
    assert.throws(() => normalizePublicConnectorEndpoint(endpoint));
  }
});

test('bootstrap da environment richiede endpoint e fingerprint insieme', () => {
  assert.equal(directBootstrapFromEnvironment(TOKEN, {}), null);
  assert.throws(() => directBootstrapFromEnvironment(TOKEN, {
    BAIA_PUBLIC_CONNECTOR_ENDPOINT: 'https://baia.example.test',
  }));
  assert.match(directBootstrapFromEnvironment(TOKEN, {
    BAIA_PUBLIC_CONNECTOR_ENDPOINT: 'https://baia.example.test',
    BAIA_CONNECTOR_SERVER_FINGERPRINT: PIN,
  }), /^baia-direct1\./);
});
