'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('DELETE attraversa client Core, Transport Manager, Host Connector e verifica Node', () => {
  const clientAuth = read('src-tauri/src/auth.rs');
  const clientTransport = read('src-tauri/src/transport/mod.rs');
  const host = read('host-connector/src/main.rs');
  const hostGrant = read('host-connector/src/access_grant.rs');
  const nodeAuth = read('src/services/device-auth-service.js');
  const frontend = read('public/js/metadata-editor.js');

  assert.match(clientAuth, /"GET"\s*\|\s*"HEAD"\s*\|\s*"POST"\s*\|\s*"PUT"\s*\|\s*"DELETE"/);
  assert.match(clientTransport, /"DELETE"\s*=>\s*Ok\(Method::DELETE\)/);
  assert.match(host, /"DELETE"\s*=>\s*Ok\("DELETE"\.to_string\(\)\)/);
  assert.match(hostGrant, /"GET"\s*\|\s*"HEAD"\s*\|\s*"POST"\s*\|\s*"PUT"\s*\|\s*"DELETE"/);
  assert.match(nodeAuth, /\['GET', 'HEAD', 'POST', 'PUT', 'DELETE'\]/);
  assert.match(frontend, /apiRequest\(endpoint,\s*\{\s*method:\s*'DELETE'\s*\}\)/);
});

test('il trasporto non viene aperto a metodi arbitrari', () => {
  const clientAuth = read('src-tauri/src/auth.rs');
  const clientTransport = read('src-tauri/src/transport/mod.rs');
  const host = read('host-connector/src/main.rs');

  assert.match(clientAuth, /normalize_method\("PATCH"\)\.is_err\(\)/);
  assert.match(clientTransport, /normalize_method\("PATCH"\)\.is_err\(\)/);
  assert.match(host, /normalize_method\("PATCH"\)\.is_err\(\)/);
});
