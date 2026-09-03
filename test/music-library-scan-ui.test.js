'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'pages', 'upload-manager.html'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'music-library-scan.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'library-manager.css'), 'utf8');

test('Upload Manager espone Scansione libreria sotto Info libreria con esecuzione immediata', () => {
  const infoPosition = html.indexOf('Info libreria');
  const scanPosition = html.indexOf('Scansione libreria');
  assert.ok(infoPosition >= 0 && scanPosition > infoPosition);
  assert.match(html, /id="musicLibraryScanPanel"/);
  assert.match(html, /id="musicLibraryScanButton"[^>]+type="button"/);
  assert.match(html, /id="musicLibraryScanAvailability"/);
  assert.match(html, /id="musicLibraryScanResults"[^>]+hidden/);
  assert.match(source, /apiRequest\('\/api\/uploads\/music\/scan-library'/);
  assert.match(source, /method: 'POST'/);
  assert.match(source, /elements\.button\.addEventListener\('click', runScan\)/);
  assert.match(source, /state\.scanning = true/);
  assert.doesNotMatch(source, /body:\s*\{\s*\}/);
  assert.doesNotMatch(source, /confirm\s*\(/);
  assert.doesNotMatch(source, /https?:\/\/(?:127\.0\.0\.1|localhost)/i);
  assert.match(css, /\.library-scan-stats/);
  assert.match(css, /\.library-scan-issues/);
});
