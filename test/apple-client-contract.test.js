'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('macOS e iOS usano il backend Keychain senza fallback in chiaro', () => {
  const cargo = read('src-tauri/Cargo.toml');
  const identity = read('src-tauri/src/identity.rs');

  assert.match(cargo, /cfg\(any\(target_os = "macos", target_os = "ios"\)\)/);
  assert.match(cargo, /keyring = \{ version = "4\.1\.5"[\s\S]*features = \["v1"\]/);
  assert.match(identity, /cfg\(any\(target_os = "macos", target_os = "ios"\)\)/);
  assert.match(identity, /"macOS Keychain"/);
  assert.match(identity, /"iOS Keychain"/);
  assert.match(identity, /set_secret\(&secret\[\.\.\]\)/);
  assert.doesNotMatch(identity, /target_os = "ios"[\s\S]{0,300}OpenOptions/);
});

test('selezione file iOS copia dal provider nella cache privata e usa token opachi', () => {
  const upload = read('src-tauri/src/native_upload.rs');
  assert.match(upload, /cfg\(any\(target_os = "android", target_os = "ios"\)\)/);
  assert.match(upload, /fn prepare_mobile_selected_file/);
  assert.match(upload, /app\s*\.fs\(\)\s*\.open\(file_path, options\)/);
  assert.match(upload, /native-upload/);
  assert.match(upload, /Uuid::new_v4\(\)\.to_string\(\)/);
});

test('client iOS non usa un Connector loopback prima del bootstrap remoto', () => {
  const core = read('src-tauri/src/core.rs');
  assert.match(core, /IOS_UNPAIRED_CONNECTOR_ENDPOINT: &str = "https:\/\/pairing-required\.invalid:443"/);
  assert.match(core, /cfg\(target_os = "ios"\)[\s\S]*IOS_UNPAIRED_CONNECTOR_ENDPOINT\.to_string\(\)/);
  assert.match(core, /store_direct_pairing/);
  assert.match(core, /ConnectorEndpointKind::DirectInternet/);
});

test('configurazioni Apple mantengono frontend statico e target separati', () => {
  const base = JSON.parse(read('src-tauri/tauri.conf.json'));
  const macos = JSON.parse(read('src-tauri/tauri.macos.conf.json'));
  const ios = JSON.parse(read('src-tauri/tauri.ios.conf.json'));
  assert.equal(base.build.frontendDist, '../dist');
  assert.equal(base.build.devUrl, 'http://localhost:1430');
  assert.deepEqual(macos.bundle.targets, ['app', 'dmg']);
  assert.equal(macos.bundle.macOS.hardenedRuntime, true);
  assert.equal(ios.bundle.iOS.minimumSystemVersion, '15.0');
  assert.equal(ios.app.windows[0].minWidth, 320);
});

test('Host Connector ha persistenza macOS e permessi Unix restrittivi', () => {
  const identity = read('host-connector/src/server_identity.rs');
  assert.match(identity, /cfg\(target_os = "macos"\)/);
  assert.match(identity, /\.join\("Library"\)[\s\S]*\.join\("Application Support"\)/);
  assert.match(identity, /OpenOptionsExt/);
  assert.match(identity, /options\.mode\(0o600\)/);
});
