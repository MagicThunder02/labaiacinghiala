'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);

test('TagLib modifica realmente e in modo coordinato due MP3 dello stesso album', {
  skip: nodeMajor < 24 ? 'taglib-wasm 1.6.1 richiede Node 24 o successivo.' : false,
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-music-album-real-'));
  const library = path.join(root, 'media');
  const uploads = path.join(library, '.uploads');
  fs.mkdirSync(uploads, { recursive: true });
  const firstSource = path.join(uploads, 'first.mp3');
  const secondSource = path.join(uploads, 'second.mp3');
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'music', 'fixture.mp3'), firstSource);
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'music', 'fixture.mp3'), secondSource);

  const env = {
    ...process.env,
    DATABASE_PATH: path.join(root, 'media.sqlite'),
    DATABASE_BACKUPS_PATH: path.join(root, 'backups'),
    LIBRARY_PATH: library,
    METADATA_POSTER_CACHE_PATH: path.join(root, 'poster-cache'),
    METADATA_POSTERS_PATH: path.join(root, 'posters'),
    MUSIC_COVER_CACHE_PATH: path.join(root, 'music-cover-cache'),
    UPLOAD_TEMP_PATH: uploads,
  };

  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const db = require('./src/database');
    const config = require('./src/config');
    const absoluteStoredPath = (stored) => path.resolve(config.libraryPath, String(stored || ''));
    const { importMusicUpload } = require('./src/services/music-import-service');
    const { readMusicFileMetadata, updateMusicFileTags } = require('./src/services/music-tag-service');
    const { updateMusicAlbumEmbeddedMetadata } = require('./src/services/music-album-metadata-edit-service');
    (async () => {
      const firstSource = ${JSON.stringify(firstSource)};
      const secondSource = ${JSON.stringify(secondSource)};
      await updateMusicFileTags(firstSource, {
        title: 'Real Alpha', artists: ['Real Track Artist A'], album: 'Real Old Album',
        albumArtists: ['Real Old Artist'], trackNumber: 1, trackTotal: 2,
        discNumber: 1, discTotal: 1, genres: ['Rock'], date: '2001', year: 2001,
      });
      await updateMusicFileTags(secondSource, {
        title: 'Real Beta', artists: ['Real Track Artist B'], album: 'Real Old Album',
        albumArtists: ['Real Old Artist'], trackNumber: 2, trackTotal: 2,
        discNumber: 1, discTotal: 1, genres: ['Rock'], date: '2001', year: 2001,
      });
      const first = await importMusicUpload(firstSource);
      const second = await importMusicUpload(secondSource);
      const result = await updateMusicAlbumEmbeddedMetadata(first.albumUuid, {
        album: 'Real Edited Album', albumArtists: ['Real Edited Artist'],
        genres: ['Metal'], date: '2026', year: 2026,
        trackTotal: 2, discTotal: 1, compilation: false,
      });
      const rows = db.prepare('SELECT track_uuid AS trackUuid, file_path AS filePath FROM music_tracks ORDER BY track_number').all();
      const reread = [];
      for (const row of rows) reread.push(await readMusicFileMetadata(absoluteStoredPath(row.filePath)));
      console.log(JSON.stringify({ result, first, second, rows, reread, allExist: rows.every((row) => fs.existsSync(absoluteStoredPath(row.filePath))) }));
      db.close();
    })().catch((error) => { console.error(error); db.close(); process.exitCode = 1; });
  `;

  const run = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env,
  });
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(payload.result.albumId, payload.first.albumUuid);
  assert.deepEqual(payload.rows.map((row) => row.trackUuid), [payload.first.trackUuid, payload.second.trackUuid]);
  assert.equal(payload.allExist, true);
  assert.deepEqual(payload.reread.map((item) => item.tags.album), ['Real Edited Album', 'Real Edited Album']);
  assert.deepEqual(payload.reread.map((item) => item.tags.albumArtist), ['Real Edited Artist', 'Real Edited Artist']);
  assert.deepEqual(payload.reread.map((item) => item.tags.year), [2026, 2026]);
  assert.deepEqual(payload.reread.map((item) => item.tags.title), ['Real Alpha', 'Real Beta']);
  assert.deepEqual(payload.reread.map((item) => item.tags.trackNumber), [1, 2]);

  fs.rmSync(root, { recursive: true, force: true });
});
