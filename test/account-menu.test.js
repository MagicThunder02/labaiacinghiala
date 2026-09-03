'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const navigation = require('../public/js/account-navigation');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const index = read('public/index.html');
const shell = read('public/js/app-shell.js');
const apiConfig = read('public/js/api-config.js');
const bridge = read('public/js/shell-bridge.js');

const menu = [
  {
    type: 'group',
    id: 'cinema',
    pages: [
      { id: 'films', section: 'films' },
      { id: 'series', section: 'series' },
    ],
  },
  { type: 'page', id: 'music', section: 'music' },
  {
    type: 'group',
    id: 'reading',
    pages: [
      { id: 'books', section: 'books' },
      { id: 'comics', section: 'comics' },
      { id: 'manga', section: 'manga' },
    ],
  },
];

const quick = [
  { type: 'page', id: 'upload-manager', capability: 'uploadContent' },
  { type: 'page', id: 'metadata-editor', capability: 'editMetadata' },
  { type: 'page', id: 'account-manager', capability: 'manageAccounts' },
];

function state({ sections = [], capabilities = {}, role = 'user', mustChangePassword = false } = {}) {
  return {
    authenticated: true,
    account: { id: 'account-1', role, mustChangePassword },
    sections,
    capabilities,
  };
}

test('la policy filtra pagine, figli dei gruppi e gruppi vuoti', () => {
  const filtered = navigation.filterNavigation(menu, state({ sections: ['films', 'manga'] }));
  assert.deepEqual(filtered.map((item) => item.id), ['cinema', 'reading']);
  assert.deepEqual(filtered[0].pages.map((page) => page.id), ['films']);
  assert.deepEqual(filtered[1].pages.map((page) => page.id), ['manga']);
  assert.equal(navigation.canAccessPage({ id: 'music', section: 'music' }, state({ sections: ['films'] })), false);
});



test('durante il cambio password obbligatorio resta accessibile soltanto Profilo', () => {
  const pending = state({
    sections: ['films', 'series', 'music', 'books', 'comics', 'manga'],
    capabilities: { uploadContent: true, editMetadata: true, manageAccounts: true },
    role: 'admin',
    mustChangePassword: true,
  });
  const profile = { id: 'profile', allowPasswordChange: true };
  assert.deepEqual(navigation.filterNavigation(menu, pending), []);
  assert.deepEqual(navigation.filterNavigation(quick, pending), []);
  assert.equal(navigation.canAccessPage(profile, pending), true);
  assert.equal(navigation.canAccessPage({ id: 'films', section: 'films' }, pending), false);
  assert.equal(navigation.firstAccessiblePage(menu, pending, profile)?.id, 'profile');
});

test('i collegamenti amministrativi dipendono dalle capability pubbliche', () => {
  assert.deepEqual(navigation.filterNavigation(quick, state()).map((page) => page.id), []);
  assert.deepEqual(
    navigation.filterNavigation(quick, state({
      capabilities: { uploadContent: true, editMetadata: true, manageAccounts: true },
    }))
      .map((page) => page.id),
    ['upload-manager', 'metadata-editor', 'account-manager'],
  );
});

test('la pagina iniziale ignora destinazioni non autorizzate e può ripiegare su Profilo', () => {
  const account = state({ sections: ['series'] });
  assert.equal(navigation.firstAccessiblePage(menu, account)?.id, 'series');
  assert.equal(navigation.firstAccessiblePage(menu, state(), { id: 'profile' })?.id, 'profile');
  assert.equal(navigation.canAccessPage({ id: 'profile', allowUnauthenticated: true }, { authenticated: false }), false);
  assert.equal(
    navigation.canAccessPage(
      { id: 'profile', allowUnauthenticated: true },
      { authenticated: false },
      { allowUnauthenticated: true },
    ),
    true,
  );
});

test('la shell usa la stessa policy per menu, iframe, pagina salvata e player Musica', () => {
  assert.match(index, /src="\/js\/account-navigation\.js" defer/);
  for (const [pageId, section] of [
    ['films', 'films'],
    ['series', 'series'],
    ['music', 'music'],
    ['books', 'books'],
    ['comics', 'comics'],
    ['manga', 'manga'],
  ]) {
    assert.match(shell, new RegExp(`id: '${pageId}'[^\n]+section: '${section}'`));
  }
  assert.match(shell, /capability: 'uploadContent'/);
  assert.match(shell, /capability: 'editMetadata'/);
  assert.match(shell, /id: 'account-manager'[^\n]+capability: 'manageAccounts'/);
  assert.match(shell, /accountNavigation\.filterNavigation\(menuDefinition, accountState\)/);
  assert.match(shell, /if \(currentPageId\) setActiveState\(currentPageId\)/);
  assert.match(shell, /if \(!canAccessPage\(page, \{ allowUnauthenticated \}\)\)/);
  assert.match(shell, /function removeUnauthorizedFrames/);
  assert.match(shell, /savedPage && canAccessPage\(savedPage\)/);
  assert.match(shell, /firstAccessiblePage\(menuDefinition, accountState/);
  assert.match(shell, /hasSection\(accountState, 'music'\)/);
});

test('i 403 applicativi vengono comunicati alla shell senza trasformarli in logout', () => {
  for (const code of ['SECTION_ACCESS_DENIED', 'ADMIN_REQUIRED', 'PASSWORD_CHANGE_REQUIRED']) {
    assert.match(apiConfig, new RegExp(`['"]${code}['"]`));
    assert.match(bridge, new RegExp(`['"]${code}['"]`));
  }
  assert.match(apiConfig, /shell-account-access-denied/);
  assert.match(apiConfig, /baia-account-access-denied/);
  assert.match(bridge, /function reportAccountFailure/);
  assert.match(shell, /data\.type === 'shell-account-access-denied'/);
  assert.match(shell, /handleAccountAccessDenied/);
  assert.match(shell, /allowPasswordChange: true/);
  assert.match(shell, /refreshAccountState\(\{ loading: false \}\)/);
});
