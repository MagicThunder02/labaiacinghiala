'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);

test('sessione upload reale modifica i tag MP3 e finalizza il brano nel catalogo', {
  skip: nodeMajor < 24 ? 'taglib-wasm 1.6.1 richiede Node 24 o successivo.' : false,
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-music-session-real-'));
  const library = path.join(root, 'media');
  const uploads = path.join(library, '.uploads');
  const source = path.join(uploads, 'incoming.mp3');
  fs.mkdirSync(uploads, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'music', 'fixture.mp3'), source);

  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const db = require('./src/database');
    const {
      createMusicUploadSession, updateMusicUploadTrackTags, commitMusicUploadTrack,
    } = require('./src/services/music-upload-session-service');
    (async () => {
      const session = await createMusicUploadSession([
        { path: ${JSON.stringify(source)}, originalname: 'originale.mp3' },
      ], 'local-admin');
      const edited = await updateMusicUploadTrackTags(session.sessionId, session.tracks[0].trackId, 'local-admin', {
        title: 'Iron Man', artist: 'Black Sabbath', album: 'Paranoid', albumArtist: 'Black Sabbath',
        genre: ['Heavy Metal'], trackNumber: 1, trackTotal: 8, year: 1970,
      });
      const committed = await commitMusicUploadTrack(session.sessionId, session.tracks[0].trackId, 'local-admin');
      const row = db.prepare('SELECT title, file_name AS fileName, relative_path AS relativePath FROM music_tracks WHERE id = ?').get(committed.imported.id);
      console.log(JSON.stringify({ edited, committed, row, exists: fs.existsSync(path.join(${JSON.stringify(library)}, row.relativePath)) }));
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
  assert.equal(payload.edited.readyToImport, true);
  assert.equal(payload.edited.proposedRelativePath, 'Musica/Black Sabbath/Paranoid/01 Iron Man.mp3');
  assert.equal(payload.committed.sessionComplete, true);
  assert.equal(payload.row.title, 'Iron Man');
  assert.equal(payload.row.fileName, '01 Iron Man.mp3');
  assert.equal(payload.exists, true);
  fs.rmSync(root, { recursive: true, force: true });
});
