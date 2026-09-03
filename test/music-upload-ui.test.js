'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'pages', 'upload-manager.html'), 'utf8');
const managerSource = fs.readFileSync(path.join(root, 'public', 'js', 'library-manager.js'), 'utf8');
const musicSource = fs.readFileSync(path.join(root, 'public', 'js', 'music-upload-manager.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'library-manager.css'), 'utf8');

test('Upload Manager abilita Musica e usa le API a sessioni autenticate esistenti', () => {
  assert.match(html, /data-category="music" aria-pressed="false">Musica<\/button>/);
  assert.doesNotMatch(html, /data-category="music"[^>]*disabled/);
  assert.match(html, /id="musicUploadPanel"/);
  assert.match(html, /src="\/js\/music-upload-manager\.js"/);
  assert.match(html, /accept="\.mp3,\.flac,\.wav/);

  assert.match(managerSource, /\['movie', 'series', 'music', 'books', 'comics', 'manga'\]/);
  assert.match(managerSource, /musicPanel\.hidden = category !== 'music'/);

  assert.match(musicSource, /BaiaPage\.apiUrl\('\/api\/uploads\/music\/sessions'\)/);
  assert.match(musicSource, /BaiaApi\.requestAuthHeaders\('POST', target\)/);
  assert.match(musicSource, /method: 'PUT'/);
  assert.match(musicSource, /\/tracks\/\$\{encodeURIComponent\(track\.trackId\)\}\/commit/);
  assert.match(musicSource, /\/sessions\/\$\{encodeURIComponent\(state\.session\.sessionId\)\}\/cancel/);
  assert.doesNotMatch(musicSource, /https?:\/\/127\.0\.0\.1|https?:\/\/localhost/i);
  assert.doesNotMatch(musicSource, /filePath|directoryPath|relativePath\s*:/);

  assert.match(css, /\.music-upload-layout/);
  assert.match(css, /\.music-track-list/);
  assert.match(css, /\.music-editor-card/);
});

test('editor upload Musica modifica i tag reali prima del commit e non gestisce ancora la copertina', () => {
  assert.match(html, /I tag mostrati sono quelli incorporati nei file/);
  assert.match(html, /id="musicSaveTagsButton"/);
  assert.match(html, /id="musicImportTrackButton"/);
  assert.match(html, /id="musicImportReadyButton"/);
  assert.match(musicSource, /I tag sono stati scritti realmente nel file temporaneo/);
  assert.match(musicSource, /readyToImport/);
  assert.doesNotMatch(html, /musicCoverInput|musicPosterInput/);
});
