'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');

test('Upload Metadati e informazioni storage sono montati soltanto dietro requireAdmin', () => {
  assert.match(appSource, /app\.use\('\/api\/admin\/pairing-invites', requireLocalAdminBrowser, selectedRouters\.adminPairingInvites\);/);
  assert.match(appSource, /app\.use\('\/api\/admin\/paired-devices', requireLocalAdminBrowser, selectedRouters\.adminPairedDevices\);/);
  assert.match(appSource, /app\.use\('\/api\/admin\/accounts', requireAdmin, selectedRouters\.adminAccounts\);/);
  assert.match(appSource, /app\.use\('\/api\/library', requireAdmin, selectedRouters\.library\);/);
  assert.match(appSource, /app\.use\('\/api\/metadata\/music', requireAdmin, selectedRouters\.musicMetadata\);/);
  assert.match(appSource, /app\.use\('\/api\/metadata', requireAdmin, selectedRouters\.metadataEditor\);/);
  assert.match(appSource, /app\.use\('\/api\/uploads', requireAdmin, selectedRouters\.contentUpload\);/);

  assert.doesNotMatch(appSource, /app\.use\('\/api\/library', selectedRouters\.library\);/);
  assert.doesNotMatch(appSource, /app\.use\('\/api\/uploads', selectedRouters\.contentUpload\);/);
});

test('cataloghi monosezione e cataloghi misti usano il controllo appropriato', () => {
  assert.match(appSource, /app\.use\('\/api\/movies', createMovieAccess\(\{ database: selectedDatabase \}\), selectedRouters\.movies, selectedRouters\.userState\);/);
  assert.match(appSource, /app\.use\('\/api\/series', requireSection\('series'\), selectedRouters\.series\);/);
  assert.match(appSource, /app\.use\('\/api\/reading', createReadingAccess\(\{ database: selectedDatabase \}\), selectedRouters\.reading\);/);
  assert.match(appSource, /app\.use\('\/api\/music', requireSection\('music'\), selectedRouters\.music\);/);
});

test('accountAuth precede sempre autorizzazioni, cataloghi e API amministrative', () => {
  const accountPosition = appSource.indexOf("app.use('/api', createAccountAuth");
  const passwordPosition = appSource.indexOf("app.use('/api', requirePasswordChangeCompleted)");
  const moviesPosition = appSource.indexOf("app.use('/api/movies', createMovieAccess");
  const localInvitePosition = appSource.indexOf("app.use('/api/admin/pairing-invites', requireLocalAdminBrowser");
  const localDevicePosition = appSource.indexOf("app.use('/api/admin/paired-devices', requireLocalAdminBrowser");
  const adminPosition = appSource.indexOf("app.use('/api/library', requireAdmin");

  assert.ok(accountPosition >= 0);
  assert.ok(passwordPosition > accountPosition);
  assert.ok(moviesPosition > passwordPosition);
  assert.ok(localInvitePosition > passwordPosition);
  assert.ok(localDevicePosition > passwordPosition);
  assert.ok(adminPosition > accountPosition);
});
