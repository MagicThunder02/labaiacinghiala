'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const html = read('public/pages/account-manager.html');
const script = read('public/js/account-manager.js');
const css = read('public/css/account-manager.css');
const shell = read('public/js/app-shell.js');
const icon = read('public/icons/users.svg');

const combined = `${html}\n${script}`;

test('pagina account è raggiungibile soltanto tramite capability manageAccounts', () => {
  assert.match(shell, /id: 'account-manager'[^\n]+src: '\/pages\/account-manager\.html'[^\n]+capability: 'manageAccounts'/);
  assert.match(shell, /icon: '\/icons\/users\.svg'/);
  assert.match(html, /src="\/js\/api-config\.js" defer/);
  assert.match(html, /src="\/js\/shell-bridge\.js" defer/);
  assert.match(icon, /<svg/);
});

test('gestore account usa soltanto API autenticate e copre creazione, modifica, password, logout e delete logico', () => {
  for (const endpoint of [
    '/api/admin/accounts',
    '/password',
    '/logout-devices',
    '/delete',
  ]) {
    assert.match(script, new RegExp(endpoint.replaceAll('/', '\\/')));
  }
  assert.match(script, /window\.BaiaPage\.apiRequest/);
  assert.match(script, /method: 'POST'/);
  assert.match(script, /method: 'PUT'/);
  assert.match(script, /shellAccountRefresh\(\)/);
  assert.doesNotMatch(combined, /127\.0\.0\.1|localhost|X-Profile-Key/);
  assert.doesNotMatch(script, /localStorage|sessionStorage|Authorization:\s*['"]Bearer|passwordHash/);

  assert.match(html, /id="username"[^>]+type="text"[^>]+minlength="3"[^>]+maxlength="64"/);
  assert.match(script, /function validatedUsername/);
  assert.match(script, /normalize\('NFKC'\)/);
  assert.match(script, /username !== username\.trim\(\)/);
  assert.match(script, /\p\{L\}/);
  assert.doesNotMatch(combined, /displayName|Nome visualizzato/);
});

test('form account espone ruoli e tutte le sezioni ma protegge le operazioni sul proprio admin', () => {
  for (const section of ['films', 'series', 'music', 'books', 'comics', 'manga']) {
    assert.match(html, new RegExp(`value="${section}"`));
  }
  assert.match(html, /value="user">Utente/);
  assert.match(html, /value="admin">Amministratore/);
  assert.match(html, /id="disabled"/);
  assert.match(html, /id="initialPassword"[^>]+autocomplete="new-password"/);
  assert.match(html, /id="resetPassword"[^>]+autocomplete="new-password"/);
  assert.match(script, /elements\.role\.disabled = account\.current/);
  assert.match(script, /elements\.disabled\.disabled = account\.current/);
  assert.match(script, /elements\.deleteAccount\.disabled = self/);
  assert.match(script, /elements\.passwordResetForm\.hidden = self/);
});


test('editor account mostra direttamente i dati senza placeholder o animazioni di caricamento', () => {
  assert.doesNotMatch(html, /Seleziona un account|Oppure crea un nuovo account per iniziare/);
  assert.doesNotMatch(html, /editorLoading|editor-loading/);
  assert.doesNotMatch(css, /account-editor-loading|editor-loading/);
  assert.doesNotMatch(script, /editorLoading|showLoading|showPlaceholder|editorPlaceholder/);
  assert.match(script, /const next = accountById\(preferredId\) \|\| accounts\[0\] \|\| null/);
  assert.match(script, /if \(next\) renderExistingAccount\(next\);\s*else renderCreateAccount\(\);/);
});



test('gestione pairing locale espone inviti e dispositivi soltanto nel browser amministrativo locale', () => {
  assert.match(html, /id="invitesTab"[^>]+hidden/);
  assert.match(html, /id="devicesTab"[^>]+hidden/);
  assert.match(html, /id="invitesPanel"[^>]+hidden/);
  assert.match(html, /id="devicesPanel"[^>]+hidden/);
  assert.match(script, /apiRequest\('\/api\/auth\/me'\)/);
  assert.match(script, /state\?\.localAccess/);
  assert.match(script, /state\?\.account\?\.role === 'admin'/);
  assert.match(script, /elements\.invitesTab\.hidden = !localPairingManagement/);
  assert.match(script, /elements\.devicesTab\.hidden = !localPairingManagement/);
  assert.match(script, /if \(!localPairingManagement\) return/);
});

test('interfaccia inviti crea, elenca, filtra e revoca tramite le API locali dello Step 12A', () => {
  assert.match(html, /id="inviteTtlMinutes"[^>]+min="1"[^>]+max="1440"/);
  assert.match(html, /id="createdInviteToken"/);
  assert.match(html, /mostrato soltanto al momento della creazione/);
  assert.match(html, /value="active">Attivi/);
  assert.match(html, /value="used">Usati/);
  assert.match(html, /value="expired">Scaduti/);
  assert.match(html, /value="revoked">Revocati/);
  assert.match(script, /apiRequest\('\/api\/admin\/pairing-invites'\)/);
  assert.match(script, /`\/api\/admin\/pairing-invites\/\$\{invite\.id\}\/revoke`/);
  assert.match(script, /JSON\.stringify\(\{ ttlMinutes \}\)/);
  assert.match(script, /navigator\.clipboard\?\.writeText/);
  assert.match(script, /createdInviteToken\.textContent/);
  assert.doesNotMatch(script, /createdInviteToken\.innerHTML/);
  assert.doesNotMatch(combined, /token_hash|127\.0\.0\.1|localhost/);
});

test('gestione dispositivi usa l’API locale dedicata e mantiene distinta la revoca device dal logout account', () => {
  assert.match(html, /id="devicesTab"[^>]*>Gestione dispositivi</);
  assert.match(html, /id="deviceStatusFilter"/);
  assert.match(html, /value="active">Attivi/);
  assert.match(html, /value="revoked">Revocati/);
  assert.match(script, /apiRequest\('\/api\/admin\/paired-devices'\)/);
  assert.match(script, /`\/api\/admin\/paired-devices\/\$\{device\.id\}\/revoke`/);
  assert.match(script, /Revoca dispositivo/);
  assert.match(script, /nuove richieste firmate/);
  assert.match(script, /nuovo pairing/);
  assert.doesNotMatch(script, /exec\(|spawn\(|pairing -- revoke/);
  assert.doesNotMatch(combined, /public_key|active_account_id|token_hash/);
});


test('layout inviti distingue creazione monouso e cronologia responsiva', () => {
  assert.match(html, /class="invites-layout"/);
  assert.match(html, /class="invite-create-card"/);
  assert.match(html, /class="invite-history-card"/);
  assert.match(html, /Dopo aver chiuso questo riquadro il token completo non potrà essere recuperato/);
  assert.match(css, /grid-template-columns: minmax\(300px, 430px\) minmax\(0, 1fr\)/);
  assert.match(css, /@media \(max-width: 1060px\)/);
  assert.match(css, /\.invite-status\.active/);
  assert.match(css, /\.invite-status\.revoked/);
});

test('Gestione account occupa tutta la larghezza disponibile come Upload Manager', () => {
  assert.match(css, /\.accounts-page\s*\{[^}]*width:\s*100%[^}]*max-width:\s*none[^}]*margin:\s*0[^}]*\}/s);
  assert.doesNotMatch(css, /\.accounts-page\s*\{[^}]*max-width:\s*1560px/s);
});

test('interfaccia account è responsiva e separa elenco, editor, sicurezza e area pericolosa', () => {
  assert.match(html, /class="accounts-layout"/);
  assert.match(html, /id="accountList"/);
  assert.match(html, /id="accountForm"/);
  assert.match(html, /id="passwordResetForm"/);
  assert.match(html, /class="danger-card"/);
  assert.match(css, /grid-template-columns: minmax\(280px, 360px\) minmax\(0, 1fr\)/);
  assert.match(css, /@media \(max-width: 940px\)/);
  assert.match(css, /@media \(max-width: 680px\)/);
});
