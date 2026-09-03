'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const core = read('src-tauri/src/core.rs');
const identity = read('src-tauri/src/identity.rs');
const lib = read('src-tauri/src/lib.rs');

test('APK 4B usa solo il bootstrap LAN pubblico previsto', () => {
  assert.match(core, /#\[cfg\(target_os = "android"\)\]\s*const ANDROID_TEST_CONNECTOR_ENDPOINT: &str = "https:\/\/10\.239\.168\.236:43127";/);
  assert.match(core, /ANDROID_TEST_CONNECTOR_FINGERPRINT: &str =\s*"SHA256:tFv0VGkaNeUB7khsLolKtsYg076d1eVpkcZEZIdnj4k";/);
  assert.match(core, /connector_server_fingerprint: default_connector_server_fingerprint\(\)/);
  assert.match(core, /server_base_url: DEFAULT_API_BASE_URL\.to_string\(\)/);
});

test('identita Android resta nel Core e in storage privato dell app', () => {
  assert.match(identity, /#\[cfg\(target_os = "android"\)\]\s*pub\(crate\) fn initialize_android_identity_storage/);
  assert.match(identity, /\.app_config_dir\(\)/);
  assert.match(identity, /OpenOptions::new\(\)\.write\(true\)\.create_new\(true\)/);
  assert.match(identity, /Android app-private storage \(4B test build\)/);
  assert.match(lib, /identity::initialize_android_identity_storage\(app\.handle\(\)\)/);
  assert.doesNotMatch(identity, /tauri::command[^]*initialize_android_identity_storage/);
});
