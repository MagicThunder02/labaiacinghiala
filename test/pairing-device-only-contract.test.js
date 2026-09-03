'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('Baia Core conserva solo identità e server nel record di pairing', () => {
  const core = read('src-tauri/src/core.rs').split('#[cfg(test)]')[0];
  const pairing = read('src-tauri/src/pairing.rs').split('#[cfg(test)]')[0];
  assert.doesNotMatch(core, /profile_key|profileKey/);
  assert.doesNotMatch(pairing, /profile_key|profileKey/);
  assert.match(core, /pub device_id: String/);
  assert.match(core, /pub fingerprint: String/);
  assert.match(pairing, /struct PairingStatus/);
});

test('CLI e profilo descrivono inviti e dispositivi senza associarli a un account', () => {
  const cli = read('src/pairing-admin.js');
  const profile = read('public/pages/profile.html');
  const profileLogic = read('public/js/profile.js');
  assert.doesNotMatch(cli, /--profile|Profilo:/);
  assert.match(profile, /pairing verifica il dispositivo, ma non effettua automaticamente l’accesso a un account/i);
  assert.doesNotMatch(profileLogic, /Associazione legacy|dispositivi legacy/);
});

test('il compatibility shim del redeem non torna a essere una fonte di identità account', () => {
  const pairingService = read('src/services/pairing-service.js');
  const deviceAuth = read('src/services/device-auth-service.js');
  const profileKey = read('src/utils/profile-key.js');
  assert.match(pairingService, /Compatibilità temporanea con client pre-Step 7/);
  assert.doesNotMatch(deviceAuth, /row\.profile_key|profileKey: row/);
  assert.doesNotMatch(profileKey, /X-Profile-Key|baiaDevice\?\.profileKey/);
  assert.match(profileKey, /req\.baiaAccount\?\.accountKey/);
});
