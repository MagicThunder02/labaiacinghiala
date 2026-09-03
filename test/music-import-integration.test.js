'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);

test('un MP3 con tag reali viene importato nella destinazione derivata dai tag', {
  skip: nodeMajor < 24 ? 'taglib-wasm 1.6.1 richiede Node 24 o successivo.' : false,
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-music-real-import-'));
  const library = path.join(root, 'media');
  const uploads = path.join(library, '.uploads');
  const source = path.join(uploads, 'incoming.mp3');
  fs.mkdirSync(uploads, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'music', 'fixture.mp3'), source);

  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const db = require('./src/database');
    const { updateMusicFileTags } = require('./src/services/music-tag-service');
    const { importMusicUpload } = require('./src/services/music-import-service');
    (async () => {
      await updateMusicFileTags(${JSON.stringify(source)}, {
        title: 'Iron Man', artist: 'Black Sabbath', album: 'Paranoid',
        albumArtist: 'Black Sabbath', genre: ['Heavy Metal'],
        trackNumber: 1, trackTotal: 8, year: 1970,
      });
      const imported = await importMusicUpload(${JSON.stringify(source)});
      const row = db.prepare('SELECT title, file_name AS fileName, relative_path AS relativePath, duration_ms AS durationMs FROM music_tracks WHERE id = ?').get(imported.id);
      console.log(JSON.stringify({ imported, row, exists: fs.existsSync(path.join(${JSON.stringify(library)}, row.relativePath)) }));
      db.close();
    })().catch((error) => { console.error(error); db.close(); process.exitCode = 1; });
  `;

  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_PATH: path.join(root, 'media.sqlite'),
      DATABASE_BACKUPS_PATH: path.join(root, 'backups'),
      LIBRARY_PATH: library,
      METADATA_POSTER_CACHE_PATH: path.join(root, 'poster-cache'),
      METADATA_POSTERS_PATH: path.join(root, 'posters'),
      UPLOAD_TEMP_PATH: uploads,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(payload.row.title, 'Iron Man');
  assert.equal(payload.row.fileName, '01 Iron Man.mp3');
  assert.equal(payload.row.relativePath, 'Musica/Black Sabbath/Paranoid/01 Iron Man.mp3');
  assert.ok(payload.row.durationMs > 0);
  assert.equal(payload.exists, true);
  assert.equal(fs.existsSync(source), false);
  fs.rmSync(root, { recursive: true, force: true });
});
