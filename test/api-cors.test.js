'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isAllowedApiOrigin } = require('../src/middleware/api-cors');

test('accetta il frontend Tauri bundled su Windows', () => {
  assert.equal(isAllowedApiOrigin('http://tauri.localhost', '127.0.0.1:3000', 3000), true);
});

test('accetta il dev server statico Tauri sulla porta predefinita', () => {
  assert.equal(isAllowedApiOrigin('http://localhost:1430', '127.0.0.1:3000', 3000), true);
  assert.equal(isAllowedApiOrigin('http://127.0.0.1:1430', '127.0.0.1:3000', 3000), true);
});

test('il browser web amministrativo è ammesso soltanto su loopback e porta corretta', () => {
  assert.equal(isAllowedApiOrigin('http://localhost:3000', 'localhost:3000', 3000), true);
  assert.equal(isAllowedApiOrigin('http://127.0.0.1:3000', '127.0.0.1:3000', 3000), true);
  assert.equal(isAllowedApiOrigin('http://[::1]:3000', '[::1]:3000', 3000), true);
  assert.equal(isAllowedApiOrigin('http://localhost:3000', 'localhost:3001', 3000), false);
});

test('blocca same-origin arbitrari e il caso di DNS rebinding', () => {
  assert.equal(isAllowedApiOrigin('http://192.168.1.20:3000', '192.168.1.20:3000', 3000), false);
  assert.equal(isAllowedApiOrigin('http://attacker.example:3000', 'attacker.example:3000', 3000), false);
  assert.equal(isAllowedApiOrigin('https://example.com', '192.168.1.20:3000', 3000), false);
});

test('CORS non pubblicizza più il vecchio header profilo scelto dal client', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'middleware', 'api-cors.js'), 'utf8');
  assert.doesNotMatch(source, /X-Profile-Key/);
  assert.match(source, /X-Baia-Device-Id/);
});
