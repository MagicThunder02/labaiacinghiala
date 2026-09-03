'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const routeSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'content-upload.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

test('API upload musica usa sessioni opache, metodi firmabili e accesso amministrativo', () => {
  assert.match(routeSource, /router\.post\('\/music\/sessions'/);
  assert.match(routeSource, /router\.get\('\/music\/sessions\/:sessionId'/);
  assert.match(routeSource, /router\.put\('\/music\/sessions\/:sessionId\/tracks\/:trackId\/tags'/);
  assert.match(routeSource, /router\.post\('\/music\/sessions\/:sessionId\/tracks\/:trackId\/commit'/);
  assert.match(routeSource, /router\.post\('\/music\/sessions\/:sessionId\/cancel'/);
  assert.doesNotMatch(routeSource, /router\.(?:delete|patch)\('\/music\/sessions/);
  assert.match(routeSource, /file\.fieldname === 'audio'/);
  assert.match(routeSource, /supportedMusicExtensions: supportedMusicExtensions\(\)/);
  assert.match(routeSource, /\{ id: 'music', label: 'Musica', enabled: true \}/);

  const accountPosition = serverSource.indexOf("app.use('/api', createAccountAuth");
  const uploadPosition = serverSource.indexOf("app.use('/api/uploads', requireAdmin, contentUploadRouter)");
  assert.ok(accountPosition >= 0 && uploadPosition > accountPosition);
});
