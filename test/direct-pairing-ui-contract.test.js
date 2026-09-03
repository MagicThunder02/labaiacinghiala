const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function read(relative) {
  return fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
}

const adminRoute = read('src/routes/admin-pairing-invites.js');
const accountManager = read('public/js/account-manager.js');
const accountPage = read('public/pages/account-manager.html');
const profilePage = read('public/pages/profile.html');
const coreLib = read('src-tauri/src/lib.rs');
const transport = read('src-tauri/src/transport/mod.rs');
const mediaBridge = read('src-tauri/src/media_bridge.rs');


test('admin locale mostra e copia il bootstrap Direct quando configurato', () => {
  assert.match(adminRoute, /directBootstrapFromEnvironment/);
  assert.match(adminRoute, /directBootstrap \? \{ directBootstrap \} : \{\}/);
  assert.match(accountManager, /invite\.directBootstrap \|\| invite\.token/);
  assert.match(accountManager, /Copia invito Baia/);
  assert.match(accountPage, /Conserva subito questo invito/);
});


test('input pairing accetta il bootstrap Direct senza chiedere endpoint manuali', () => {
  assert.match(profilePage, /baia-direct1/);
  assert.doesNotMatch(profilePage, /maxlength="[0-9]+"[^>]*id="pairingInviteToken"/);
});


test('Core può avviarsi non associato e inizializza TLS solo dopo che pairing fornisce il pin', () => {
  assert.match(coreLib, /TransportManager::new\(\)/);
  assert.match(coreLib, /MediaBridge::new\(\)/);
  assert.doesNotMatch(coreLib, /state\s*\.connector_context\(\)[\s\S]{0,300}TransportManager::new/);
  assert.match(transport, /fn client_for\(&self, server_fingerprint: &str\)/);
  assert.match(mediaBridge, /state\.connector_context\(\)\?/);
});
