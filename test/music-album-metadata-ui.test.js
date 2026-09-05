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
const service = read('src/services/music-album-metadata-edit-service.js');

test('Editor metadati offre modalità Brano e Album senza creare un catalogo parallelo', () => {
  assert.match(html, /id="musicScopeToggle"/);
  assert.match(html, /data-music-scope="track"/);
  assert.match(html, /data-music-scope="album"/);
  assert.match(source, /params\.set\('musicScope', state\.musicScope\)/);
  assert.match(metadataRoute, /listMusicAlbums\(getProfileKey\(req\)/);
  assert.match(metadataRoute, /id: `music-album:\$\{album\.albumId\}`/);
  assert.match(metadataRoute, /kind: 'music-album'/);
  assert.doesNotMatch(metadataRoute, /album\.(?:directoryPath|relativePath|filePath)/);
});

test('Modalità Album mostra i file coinvolti e invia soltanto i campi condivisi', () => {
  assert.match(html, /id="musicAlbumTrackPreview"/);
  assert.match(html, /id="musicAlbumMixedNotice"/);
  assert.match(source, /function musicAlbumMetadataBody\(\)/);
  assert.match(source, /album: elements\.title\.value/);
  assert.match(source, /albumArtists: parseSeparatedList/);
  assert.match(source, /trackTotal: nullableInteger/);
  assert.match(source, /discTotal: nullableInteger/);
  assert.match(source, /\/api\/metadata\/music\/albums\/\$\{encodeURIComponent\(state\.selected\.albumId\)\}/);
  assert.match(source, /window\.confirm\(/);
  const body = source.match(/function musicAlbumMetadataBody\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.ok(body);
  assert.doesNotMatch(body, /title:|artists:|trackNumber:|discNumber:|composers:|comment:/);
  assert.match(css, /\.music-album-track-preview/);
  assert.match(css, /\.music-scope-toggle/);
});

test('API album usa il lock condiviso e un’operazione backend atomica con rollback', () => {
  assert.match(musicRoute, /router\.get\('\/albums\/:albumId'/);
  assert.match(musicRoute, /router\.put\('\/albums\/:albumId'/);
  assert.match(service, /withMusicMetadataEditLock/);
  assert.match(service, /BEGIN IMMEDIATE/);
  assert.match(service, /ROLLBACK/);
  assert.match(service, /fs\.rename\(entry\.originalPath, entry\.backupPath\)/);
  assert.match(service, /fs\.rename\(entry\.stagedPath, entry\.plan\.destinationPath\)/);
  assert.match(musicRoute, /router\.delete\('\/albums\/:albumId'/);
  assert.doesNotMatch(musicRoute, /file_path|directory_path|relative_path/i);
});
