'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const html = read('public/pages/metadata-editor.html');
const source = read('public/js/metadata-editor.js');
const css = read('public/css/metadata-editor.css');
const albumService = read('src/services/music-album-metadata-edit-service.js');
const tagService = read('src/services/music-tag-service.js');
const coverService = read('src/services/music-cover-edit-service.js');

test('Editor album offre Sostituisci ed Elimina separati ma mantiene un solo pulsante Salva', () => {
  assert.match(html, /for="posterInput">Sostituisci copertina</);
  assert.match(html, /id="musicCoverRemoveButton"[^>]*>Elimina copertina</);
  assert.equal((html.match(/id="saveButton"/g) || []).length, 1);
  assert.match(source, /state\.musicCoverAction = 'replace'/);
  assert.match(source, /state\.musicCoverAction = 'remove'/);
  assert.match(source, /coverAction: state\.musicCoverAction/);
  assert.match(source, /coverDataUrl: state\.musicCoverAction === 'replace'/);
  assert.match(source, /image\/jpeg', 'image\/png/);
  assert.match(css, /\.cover-remove-button/);
});

test('Backend limita a 6 MB, JPEG o PNG e non introduce ridimensionamenti', () => {
  assert.match(coverService, /6 \* 1024 \* 1024/);
  assert.ok(coverService.includes('image\\/(?:jpeg|png)'));
  assert.match(coverService, /MAX_MUSIC_COVER_DIMENSION = 8000/);
  assert.doesNotMatch(coverService, /resize|sharp|canvas|imagemagick/i);
});

test('Modifica album applica artwork e tag nello stesso rollback atomico', () => {
  assert.match(albumService, /coverUpdater = options\.coverUpdater \|\| updateMusicFileCoverArt/);
  assert.match(albumService, /metadata = await metadataUpdater/);
  assert.match(albumService, /metadata = await coverUpdater/);
  assert.match(albumService, /BEGIN IMMEDIATE/);
  assert.match(albumService, /ROLLBACK/);
  assert.match(tagService, /applyCoverArt/);
  assert.match(tagService, /clearPictures/);
  assert.match(tagService, /pictures\.length !== 1/);
});
