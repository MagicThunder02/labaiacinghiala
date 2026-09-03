'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const nativeCore = read('src-tauri/src/native_upload.rs').split('#[cfg(test)]')[0];
const authCore = read('src-tauri/src/auth.rs').split('#[cfg(test)]')[0];
const libCore = read('src-tauri/src/lib.rs');
const apiConfig = read('public/js/api-config.js');
const shellBridge = read('public/js/shell-bridge.js');
const manager = read('public/js/library-manager.js');
const musicManager = read('public/js/music-upload-manager.js');

test('Baia Core espone upload nativi specifici senza un IPC generico di firma o filesystem', () => {
  assert.match(libCore, /native_upload::baia_core_pick_upload_files/);
  assert.match(libCore, /native_upload::baia_core_upload_files/);
  assert.match(libCore, /native_upload::baia_core_release_upload_files/);
  assert.match(libCore, /tauri_plugin_dialog::init\(\)/);
  assert.match(nativeCore, /"movie"\s*=>/);
  assert.match(nativeCore, /"series"\s*=>/);
  assert.match(nativeCore, /"reading"\s*=>/);
  assert.match(nativeCore, /"music"\s*=>/);
  assert.match(nativeCore, /"\/api\/uploads\/movies"/);
  assert.match(nativeCore, /"\/api\/uploads\/series"/);
  assert.match(nativeCore, /"\/api\/uploads\/music\/sessions"/);
  assert.match(nativeCore, /format!\("\/api\/uploads\/reading\/\{category\}"\)/);
  assert.doesNotMatch(nativeCore, /pub\s+fn\s+sign|#\[tauri::command\][\s\S]{0,100}sign/i);
  assert.doesNotMatch(nativeCore, /request\.url|request\.path|request\.headers/);
  assert.match(authCore, /pub\(crate\) fn authorize_request/);
});

test('frontend Tauri passa solo token opachi al Core e conserva il fallback browser', () => {
  assert.match(apiConfig, /new tauriCore\.Channel\(\)/);
  assert.match(apiConfig, /baia_core_pick_upload_files/);
  assert.match(apiConfig, /baia_core_upload_files/);
  assert.match(apiConfig, /baia_core_release_upload_files/);
  assert.match(shellBridge, /pickNativeUploadFiles/);
  assert.match(shellBridge, /nativeUpload/);

  assert.match(manager, /kind: 'movie'/);
  assert.match(manager, /kind: 'series'/);
  assert.match(manager, /kind: 'reading'/);
  assert.match(musicManager, /kind: 'music'/);
  assert.match(manager, /new XMLHttpRequest\(\)/);
  assert.match(musicManager, /new XMLHttpRequest\(\)/);
  assert.doesNotMatch(manager, /https?:\/\/(?:127\.0\.0\.1|localhost)/i);
  assert.doesNotMatch(musicManager, /https?:\/\/(?:127\.0\.0\.1|localhost)/i);
});
