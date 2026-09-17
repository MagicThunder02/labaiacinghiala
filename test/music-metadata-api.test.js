'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const routeSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'music-metadata.js'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
const serviceSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'music-metadata-edit-service.js'), 'utf8');
const albumServiceSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'music-album-metadata-edit-service.js'), 'utf8');

test('API metadati musica usa UUID logici ed è riservata agli amministratori', () => {
  assert.match(routeSource, /router\.get\('\/tracks\/:trackId'/);
  assert.match(routeSource, /router\.put\('\/tracks\/:trackId'/);
  assert.match(routeSource, /router\.get\('\/albums\/:albumId'/);
  assert.match(routeSource, /router\.put\('\/albums\/:albumId'/);
  assert.match(routeSource, /router\.delete\('\/albums\/:albumId'/);
  assert.doesNotMatch(routeSource, /router\.patch\(/);
  assert.doesNotMatch(routeSource, /router\.delete\('\/tracks\/:trackId'/);
  assert.match(serviceSource, /readMusicFileMetadata/);
  assert.match(serviceSource, /updateMusicFileTags/);
  assert.match(serviceSource, /buildMusicStoragePlan/);
  assert.match(albumServiceSource, /buildMusicStoragePlan/);
  assert.match(albumServiceSource, /withMusicMetadataEditLock/);
  assert.doesNotMatch(routeSource, /file_path|directory_path|relative_path/i);

  const accountPosition = appSource.indexOf("app.use('/api', createAccountAuth");
  const metadataPosition = appSource.indexOf("app.use('/api/metadata/music', requireAdmin, selectedRouters.musicMetadata)");
  assert.ok(accountPosition >= 0 && metadataPosition > accountPosition);
});
