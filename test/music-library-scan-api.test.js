'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const routeSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'content-upload.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

test('API scansione musica è additiva, immediata e riservata al browser amministrativo locale', () => {
  assert.match(routeSource, /router\.post\('\/music\/scan-library', requireStorage, requireLocalAdministration/);
  assert.match(routeSource, /req\.baiaLocalAccess === true/);
  assert.match(routeSource, /musicLibraryScanAvailable: req\.baiaLocalAccess === true/);
  assert.match(routeSource, /scanMusicLibrary\(\)/);
  assert.doesNotMatch(routeSource, /router\.(?:delete|patch)\('\/music\/scan-library/);

  const accountPosition = serverSource.indexOf("app.use('/api', createAccountAuth");
  const uploadPosition = serverSource.indexOf("app.use('/api/uploads', requireAdmin, contentUploadRouter)");
  assert.ok(accountPosition >= 0 && uploadPosition > accountPosition);
});
