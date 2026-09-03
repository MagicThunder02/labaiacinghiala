'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const index = read('public/index.html');
const shell = read('public/js/app-shell.js');
const shellCss = read('public/css/app-shell.css');
const apiConfig = read('public/js/api-config.js');
const bridge = read('public/js/shell-bridge.js');
const profileHtml = read('public/pages/profile.html');
const profile = read('public/js/profile.js');
const accountAuthService = read('src/services/account-auth-service.js');

function allPublicJavaScript() {
  const directory = path.join(root, 'public', 'js');
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith('.js'))
    .map((name) => read(`public/js/${name}`))
    .join('\n');
}

test('la shell verifica l account prima di creare iframe del catalogo', () => {
  assert.match(index, /<body class="auth-pending">/);
  assert.match(index, /id="authGate"/);
  assert.match(index, /id="loginForm"/);
  assert.match(index, /autocomplete="username"/);
  assert.match(index, /autocomplete="current-password"/);
  assert.match(shell, /requestAccountJson\('\/api\/auth\/me'\)/);
  assert.match(shell, /if \(!canAccessPage\(page, \{ allowUnauthenticated \}\)\)/);
  assert.match(shell, /void bootstrapShell\(\)/);
  assert.doesNotMatch(shell, /renderMenu\(\);[\s\S]{0,180}openPage\(initialPage\)/);
  assert.match(shellCss, /body\.auth-locked \.sidebar/);
  assert.match(shellCss, /\.auth-gate\s*\{/);
});

test('login e logout restano richieste API firmate senza token persistenti nel JavaScript', () => {
  assert.match(shell, /requestAccountJson\('\/api\/auth\/login'/);
  assert.match(shell, /requestAccountJson\('\/api\/auth\/logout'/);
  assert.match(shell, /body: JSON\.stringify\(\{ username, password \}\)/);
  assert.match(index, /id="logoutAccount"/);
  assert.match(profile, /\/api\/auth\/logout/);
  assert.doesNotMatch(shell + profile + bridge, /localStorage[^\n]*(?:token|password|session)|sessionStorage[^\n]*(?:token|password)/i);
  assert.doesNotMatch(shell + profile + bridge, /Authorization:\s*['"]Bearer|bearerToken|jwt/i);
  assert.doesNotMatch(shell + profile + bridge, /privateKey|sign\s*\(/i);
});

test('il vecchio profilo scelto dal client non viene più inviato dal frontend', () => {
  const publicJs = allPublicJavaScript();
  assert.doesNotMatch(publicJs, /X-Profile-Key/);
  assert.doesNotMatch(publicJs, /baiaCinghialaProfileKey/);
  assert.doesNotMatch(publicJs, /getProfileKey\s*\(/);
  assert.match(bridge, /return request\(apiUrl\(url\), options\)/);
});

test('la scadenza account viene comunicata dalla API layer alla shell', () => {
  for (const code of ['ACCOUNT_REQUIRED', 'ACCOUNT_SESSION_EXPIRED', 'ACCOUNT_DISABLED', 'ACCOUNT_DELETED']) {
    assert.match(apiConfig, new RegExp(`['"]${code}['"]`));
  }
  assert.match(apiConfig, /shell-account-auth-required/);
  assert.match(apiConfig, /response\.clone\(\)\.json\(\)/);
  assert.match(shell, /data\.type === 'shell-account-auth-required'/);
  assert.match(shell, /enterSignedOutState/);
  assert.match(shell, /resetMusicForAccountChange/);
  assert.match(shell, /clearPageFrames/);
});



test('il cambio password obbligatorio non effettua logout e limita la shell a Profilo', () => {
  assert.match(apiConfig, /PASSWORD_CHANGE_REQUIRED/);
  assert.match(bridge, /PASSWORD_CHANGE_REQUIRED/);
  assert.match(shell, /PASSWORD_CHANGE_REQUIRED/);
  assert.match(shell, /allowPasswordChange: true/);
  assert.match(shell, /accountState\?\.account\?\.mustChangePassword/);
  assert.match(shell, /refreshAccountState\(\{ loading: false \}\)/);
});

test('Profilo mostra separatamente account e dispositivo e permette cambio password', () => {
  assert.match(profileHtml, /section-kicker">Account/);
  assert.match(profileHtml, /section-kicker">Dispositivo/);
  assert.doesNotMatch(profileHtml, /accountDisplayName|Nome visualizzato/);
  assert.match(profileHtml, /id="accountUsername"/);
  assert.match(profileHtml, /id="accountRole"/);
  assert.match(profileHtml, /id="accountSections"/);
  assert.match(profileHtml, /id="passwordForm"/);
  assert.match(profileHtml, /autocomplete="current-password"/);
  assert.match(profileHtml, /autocomplete="new-password"/);
  assert.match(profile, /\/api\/auth\/password/);
  assert.match(profile, /currentPassword:/);
  assert.match(profile, /newPassword:/);
  assert.match(profile, /shellAccountRefresh\(\)/);
  assert.match(profile, /dispositivo verificato/);
  assert.doesNotMatch(profile, /profilo \$\{status\.profileKey\}/);
});

test('lo stato pubblico account indica se esiste già una password senza esporne hash o segreti', () => {
  assert.match(accountAuthService, /passwordConfigured: Boolean\(account\.passwordHash\)/);
  assert.doesNotMatch(accountAuthService, /accountPublicView[\s\S]{0,450}passwordHash:/);
  assert.doesNotMatch(accountAuthService, /displayName/);
  assert.match(profile, /account\.passwordConfigured/);
});


test('menu e navigazione non creano iframe per pagine prive di permesso', () => {
  assert.match(shell, /accountNavigation\.filterNavigation\(menuDefinition, accountState\)/);
  assert.match(shell, /accountNavigation\.filterNavigation\(quickDefinition, accountState\)/);
  assert.match(shell, /if \(!canAccessPage\(page, \{ allowUnauthenticated \}\)\)/);
  assert.match(shell, /function removeUnauthorizedFrames/);
  assert.match(shell, /frame\.remove\(\)/);
  assert.match(shell, /savedPage && canAccessPage\(savedPage\)/);
});
