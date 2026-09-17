'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const updaterCore = read('src-tauri/src/updater.rs').split('#[cfg(test)]')[0];
const libCore = read('src-tauri/src/lib.rs');
const tauriConfig = JSON.parse(read('src-tauri/tauri.conf.json'));
const cargoManifest = read('src-tauri/Cargo.toml');
const apiConfig = read('public/js/api-config.js');
const profilePage = read('public/pages/profile.html');
const profileScript = read('public/js/profile.js');
const releaseWorkflow = read('.github/workflows/release.yml');

test('il Core espone solo i due comandi di aggiornamento, senza IPC generico', () => {
  assert.match(libCore, /updater::baia_core_update_status/);
  assert.match(libCore, /updater::baia_core_update_install/);
  assert.match(libCore, /#\[cfg\(desktop\)\][\s\S]{0,160}tauri_plugin_updater::Builder::new\(\)\.build\(\)/);
  assert.match(cargoManifest, /tauri-plugin-updater/);
  // L'endpoint e la chiave arrivano dalla configurazione: il frontend non può
  // indicare da dove scaricare né che cosa eseguire.
  assert.doesNotMatch(updaterCore, /fn\s+baia_core_update_\w+\([^)]*\b(url|endpoint|path|command)\b/);
  assert.doesNotMatch(updaterCore, /Command::new|std::process::Command/);
});

test('la configurazione Tauri pubblica endpoint, chiave e artefatti updater', () => {
  const updater = tauriConfig.plugins?.updater;
  assert.ok(updater, 'manca la sezione plugins.updater');
  assert.deepEqual(updater.endpoints, [
    'https://github.com/MagicThunder02/labaiacinghiala/releases/latest/download/latest.json',
  ]);
  assert.match(updater.pubkey, /^[A-Za-z0-9+/=]{40,}$/);
  assert.equal(tauriConfig.bundle.createUpdaterArtifacts, true);
  // Su Linux l'updater sa sostituire soltanto l'AppImage.
  assert.ok(tauriConfig.bundle.targets.includes('appimage'));
  assert.ok(tauriConfig.bundle.targets.includes('nsis'));
});

test('installazioni non aggiornabili vengono riconosciute prima di scaricare', () => {
  assert.match(updaterCore, /REASON_LINUX_PACKAGE/);
  assert.match(updaterCore, /fn unsupported_reason/);
  assert.match(updaterCore, /if let Some\(reason\) = unsupported_reason\(&app\)[\s\S]{0,200}UpdateStatus::unsupported/);
  assert.match(updaterCore, /env\(\)\.appimage\.is_none\(\)/);
  assert.match(updaterCore, /#\[cfg\(mobile\)\][\s\S]{0,400}REASON_MOBILE/);
});

test('il frontend usa il bridge di dominio e mostra stato, note e avanzamento', () => {
  assert.match(apiConfig, /baia_core_update_status/);
  assert.match(apiConfig, /baia_core_update_install/);
  assert.match(apiConfig, /new tauriCore\.Channel\(\)/);
  assert.match(profilePage, /id="appUpdateCard"[^>]*hidden/);
  assert.match(profilePage, /id="appUpdateCheck"[^>]*type="button"/);
  assert.match(profilePage, /id="appUpdateInstall"[^>]*hidden/);
  assert.match(profilePage, /id="appUpdateProgressBar"/);
  assert.match(profileScript, /window\.BaiaApi\.getAppUpdateStatus\(\)/);
  assert.match(profileScript, /window\.BaiaApi\.installAppUpdate\(renderUpdateProgress\)/);
  // Le note della release sono testo remoto: mai innestate come markup.
  assert.match(profileScript, /appUpdateNotes\.textContent = status\?\.notes/);
  assert.doesNotMatch(profileScript, /appUpdateNotes\.innerHTML/);
  assert.doesNotMatch(profileScript, /appUpdate\w*\.innerHTML/);
});

test('la scheda aggiornamenti compare solo con il Core e non blocca il browser locale', () => {
  const browserFallback = profileScript.indexOf('if (!window.BaiaApi?.isTauri?.())');
  const cardReveal = profileScript.indexOf('elements.appUpdateCard.hidden = false');
  assert.ok(browserFallback >= 0 && cardReveal > browserFallback);
  assert.match(profileScript, /checkForUpdates\(\{ silent: true \}\)/);
});

test('il workflow di release firma i bundle e pubblica latest.json in bozza', () => {
  assert.match(releaseWorkflow, /tags:\s*\n\s*- 'v\*'/);
  assert.match(releaseWorkflow, /tauri-apps\/tauri-action@v0/);
  assert.match(releaseWorkflow, /TAURI_SIGNING_PRIVATE_KEY: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY \}\}/);
  assert.match(releaseWorkflow, /includeUpdaterJson: true/);
  assert.match(releaseWorkflow, /releaseDraft: true/);
  assert.match(releaseWorkflow, /node scripts\/check-release-version\.js/);
  // La chiave privata non deve mai finire nel repository.
  assert.doesNotMatch(releaseWorkflow, /untrusted comment: minisign (?:encrypted )?secret key/i);
});
