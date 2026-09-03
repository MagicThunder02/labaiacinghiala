'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

test('Upload Metadati e informazioni storage sono montati soltanto dietro requireAdmin', () => {
  assert.match(serverSource, /app\.use\('\/api\/admin\/pairing-invites', requireLocalAdminBrowser, createAdminPairingInvitesRouter\(\{ database: db \}\)\);/);
  assert.match(serverSource, /app\.use\('\/api\/admin\/paired-devices', requireLocalAdminBrowser, createAdminPairedDevicesRouter\(\{ database: db \}\)\);/);
  assert.match(serverSource, /app\.use\('\/api\/admin\/accounts', requireAdmin, createAdminAccountsRouter\(\{ database: db \}\)\);/);
  assert.match(serverSource, /app\.use\('\/api\/library', requireAdmin, libraryRouter\);/);
  assert.match(serverSource, /app\.use\('\/api\/metadata\/music', requireAdmin, musicMetadataRouter\);/);
  assert.match(serverSource, /app\.use\('\/api\/metadata', requireAdmin, metadataEditorRouter\);/);
  assert.match(serverSource, /app\.use\('\/api\/uploads', requireAdmin, contentUploadRouter\);/);

  assert.doesNotMatch(serverSource, /app\.use\('\/api\/library', libraryRouter\);/);
  assert.doesNotMatch(serverSource, /app\.use\('\/api\/uploads', contentUploadRouter\);/);
});

test('cataloghi monosezione e cataloghi misti usano il controllo appropriato', () => {
  assert.match(serverSource, /app\.use\('\/api\/movies', createMovieAccess\(\{ database: db \}\), moviesRouter, userStateRouter\);/);
  assert.match(serverSource, /app\.use\('\/api\/series', requireSection\('series'\), seriesRouter\);/);
  assert.match(serverSource, /app\.use\('\/api\/reading', createReadingAccess\(\{ database: db \}\), readingRouter\);/);
  assert.match(serverSource, /app\.use\('\/api\/music', requireSection\('music'\), musicRouter\);/);
});

test('accountAuth precede sempre autorizzazioni, cataloghi e API amministrative', () => {
  const accountPosition = serverSource.indexOf("app.use('/api', createAccountAuth");
  const passwordPosition = serverSource.indexOf("app.use('/api', requirePasswordChangeCompleted)");
  const moviesPosition = serverSource.indexOf("app.use('/api/movies', createMovieAccess");
  const localInvitePosition = serverSource.indexOf("app.use('/api/admin/pairing-invites', requireLocalAdminBrowser");
  const localDevicePosition = serverSource.indexOf("app.use('/api/admin/paired-devices', requireLocalAdminBrowser");
  const adminPosition = serverSource.indexOf("app.use('/api/library', requireAdmin");

  assert.ok(accountPosition >= 0);
  assert.ok(passwordPosition > accountPosition);
  assert.ok(moviesPosition > passwordPosition);
  assert.ok(localInvitePosition > passwordPosition);
  assert.ok(localDevicePosition > passwordPosition);
  assert.ok(adminPosition > accountPosition);
});
