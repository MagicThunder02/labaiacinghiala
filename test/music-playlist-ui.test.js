'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const html = read('public/pages/music.html');
const source = read('public/js/music.js');
const css = read('public/css/music.css');

test('pagina Musica collega catalogo e dettaglio playlist alle API autenticate', () => {
  assert.match(html, /src="\/js\/music-playlist-state\.js"/);
  assert.match(html, /id="newPlaylistButton"/);
  assert.match(html, /id="playlistDetailView"/);
  assert.match(html, /id="playlistEditorDialog"/);
  assert.match(html, /id="addToPlaylistDialog"/);
  assert.match(source, /BaiaPage\.apiRequest\('\/api\/music\/playlists'\)/);
  assert.match(source, /\/api\/music\/playlists\/\$\{encodeURIComponent\(playlistId\)\}/);
  assert.match(source, /\/tracks\/order/);
  assert.match(source, /\/tracks\/\$\{encodeURIComponent\(track\.trackId\)\}\/remove/);
  assert.match(source, /body: JSON\.stringify\(\{ trackIds: \[track\.trackId\] \}\)/);
  assert.doesNotMatch(source, /method:\s*['"](?:DELETE|PATCH)['"]/);
  assert.doesNotMatch(html + source, /https?:\/\/(?:127\.0\.0\.1|localhost)/i);
  assert.doesNotMatch(source, /filePath|directoryPath|relativePath/);
});

test('playlist può diventare una coda globale e dispone di modifica, rimozione e riordino', () => {
  assert.match(source, /musicContext\('playlist', playlist\.playlistId, playlist\.name\)/);
  assert.match(source, /playTrackQueue\(tracks, tracks\[0\]\.trackId, playlistContext/);
  assert.match(source, /BaiaMusicPlaylistState\.moveTrackIds/);
  assert.match(source, /openAddToPlaylist\(track\)/);
  assert.match(source, /removeTrackFromPlaylist/);
  assert.match(css, /\.music-playlist-picker/);
  assert.match(css, /\.music-track-move-up/);
  assert.match(css, /\.music-track-remove/);
});
