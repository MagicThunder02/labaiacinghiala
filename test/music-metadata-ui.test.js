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
const route = read('src/routes/metadata-editor.js');

test('Editor metadati abilita Musica e cerca i brani tramite il catalogo autenticato', () => {
  assert.match(route, /\{ id: 'music', label: 'Musica', enabled: true \}/);
  assert.match(route, /listMusicTracks\(getProfileKey\(req\)/);
  assert.match(route, /id: `music:\$\{track\.trackId\}`/);
  assert.match(source, /BaiaPage\.apiRequest\(`\/api\/metadata\/items\?\$\{params\}`\)/);
  assert.match(source, /Cerca per titolo, album o artista/);
  assert.doesNotMatch(route, /track\.(?:filePath|directoryPath|relativePath)/);
});

test('Editor Musica mostra e salva i tag effettivamente incorporati del singolo brano', () => {
  for (const id of [
    'musicArtistsInput',
    'musicAlbumInput',
    'musicAlbumArtistsInput',
    'musicDateInput',
    'musicTrackNumberInput',
    'musicTrackTotalInput',
    'musicDiscNumberInput',
    'musicDiscTotalInput',
    'musicComposersInput',
    'musicCommentInput',
    'musicCompilationInput',
  ]) assert.match(html, new RegExp(`id="${id}"`));

  assert.match(source, /\/api\/metadata\/music\/tracks\/\$\{encodeURIComponent\(musicTrackId\)\}/);
  assert.match(source, /\/api\/metadata\/music\/tracks\/\$\{encodeURIComponent\(state\.selected\.trackId\)\}/);
  assert.match(source, /method: 'PUT'/);
  assert.match(source, /artists: parseSeparatedList/);
  assert.match(source, /albumArtists: parseSeparatedList/);
  assert.match(source, /trackNumber: nullableInteger/);
  assert.match(source, /compilation: elements\.musicCompilation\.checked/);
  assert.match(source, /Tag incorporati salvati e file ricollocato/);
});

test('Copertina musicale resta in sola lettura sul brano e diventa modificabile nella modalità Album', () => {
  assert.match(html, /La copertina è incorporata nel file audio\. Per modificarla seleziona la modalità Album/);
  assert.match(source, /elements\.posterUploadControls\.hidden = musicTrack/);
  assert.match(source, /elements\.posterInput\.disabled = episode \|\| musicTrack/);
  assert.match(source, /BaiaPage\.apiFetch\(/);
  assert.match(source, /response\.blob\(\)/);
  assert.match(css, /\.poster-editor\.music-cover-mode/);
  assert.match(source, /coverAction: state\.musicCoverAction/);
  assert.match(source, /coverDataUrl: state\.musicCoverAction === 'replace'/);
  assert.doesNotMatch(html + source, /https?:\/\/(?:127\.0\.0\.1|localhost)/i);
  assert.doesNotMatch(source, /state\.selected\.(?:filePath|directoryPath|relativePath)/);
});
