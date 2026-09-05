'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const html = read('public/pages/metadata-editor.html');
const source = read('public/js/metadata-editor.js');
const css = read('public/css/metadata-editor.css');
const metadataRoute = read('src/routes/metadata-editor.js');
const musicRoute = read('src/routes/music-metadata.js');
const service = read('src/services/content-delete-service.js');

test('Editor metadati espone Elimina solo per contenuti completi e album', () => {
  assert.match(html, /id="deleteButton"[^>]*>Elimina<\/button>/);
  assert.match(source, /item\.kind === 'episode' \|\| item\.kind === 'music-track'/);
  assert.match(source, /method: 'DELETE'/);
  assert.match(source, /cartella nella libreria media sia i relativi record nel database/);
  assert.match(css, /\.action-button\.danger/);
});

test('API di eliminazione copre film serie letture e album', () => {
  assert.match(metadataRoute, /router\.delete\('\/items\/:entityId'/);
  assert.match(metadataRoute, /deleteMovie\(entity\.id\)/);
  assert.match(metadataRoute, /deleteSeries\(entity\.id\)/);
  assert.match(metadataRoute, /deleteReading\(entity\.id\)/);
  assert.match(musicRoute, /router\.delete\('\/albums\/:albumId'/);
  assert.match(musicRoute, /deleteMusicAlbum\(req\.params\.albumId\)/);
});

test('Backend sposta prima la cartella, usa transazione e ripristina su errore', () => {
  assert.match(service, /assertRealPathInsideLibrary/);
  assert.match(service, /isInsideDirectory/);
  assert.match(service, /\.baia-delete-staging/);
  assert.match(service, /await fs\.rename\(target, stagedPath\)/);
  assert.match(service, /BEGIN IMMEDIATE/);
  assert.match(service, /ROLLBACK/);
  assert.match(service, /await staged\.restore\(\)/);
  assert.match(service, /DELETE FROM movies WHERE id = \? AND media_type =/);
  assert.match(service, /DELETE FROM movies WHERE series_uuid = \? AND media_type = 'series'/);
  assert.match(service, /DELETE FROM reading_items WHERE id = \?/);
  assert.match(service, /DELETE FROM music_tracks WHERE album_id = \?/);
  assert.match(service, /DELETE FROM music_albums WHERE id = \?/);
});
