'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function environment(root) {
  const library = path.join(root, 'media');
  const uploads = path.join(library, '.uploads');
  fs.mkdirSync(uploads, { recursive: true });
  return {
    ...process.env,
    DATABASE_PATH: path.join(root, 'media.sqlite'),
    DATABASE_BACKUPS_PATH: path.join(root, 'backups'),
    LIBRARY_PATH: library,
    METADATA_POSTER_CACHE_PATH: path.join(root, 'poster-cache'),
    METADATA_POSTERS_PATH: path.join(root, 'posters'),
    MUSIC_COVER_CACHE_PATH: path.join(root, 'music-cover-cache'),
    UPLOAD_TEMP_PATH: uploads,
  };
}

function pngDataUrl() {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(600, 16);
  buffer.writeUInt32BE(600, 20);
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

function runCase(action, failSecond = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `baia-album-cover-${action}-`));
  const uploads = path.join(root, 'media', '.uploads');
  const first = path.join(uploads, 'one.mp3');
  const second = path.join(uploads, 'two.mp3');
  fs.mkdirSync(uploads, { recursive: true });
  fs.writeFileSync(first, 'one');
  fs.writeFileSync(second, 'two');
  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const db = require('./src/database');
    const config = require('./src/config');
    const absoluteStoredPath = (stored) => path.resolve(config.libraryPath, String(stored || ''));
    const { importMusicUpload } = require('./src/services/music-import-service');
    const { updateMusicAlbumEmbeddedMetadata } = require('./src/services/music-album-metadata-edit-service');
    const props = { durationSeconds: 100, durationMs: 100000, bitrateKbps: 320, sampleRateHz: 44100, channels: 2, bitsPerSample: null, codec: 'MP3', containerFormat: 'MPEG', isLossless: false, bitrateMode: 'CBR' };
    function meta(title, track, hasCoverArt) { return { fileName: title + '.mp3', extension: '.mp3', format: 'mp3', hasCoverArt, pictures: hasCoverArt ? [{ type: 'FrontCover', mimeType: 'image/png', size: 24 }] : [], tags: { title, artists: ['Artist'], album: 'Album', albumArtists: ['Album Artist'], genres: ['Rock'], composers: [], comment: '', date: '2020', year: 2020, trackNumber: track, trackTotal: 2, discNumber: 1, discTotal: 1, compilation: false }, properties: props }; }
    (async () => {
      const one = await importMusicUpload(${JSON.stringify(first)}, { metadataReader: async () => meta('One', 1, true) });
      await importMusicUpload(${JSON.stringify(second)}, { metadataReader: async () => meta('Two', 2, true) });
      const album = db.prepare('SELECT id, cover_cache_path AS coverPath FROM music_albums WHERE album_uuid = ?').get(one.albumUuid);
      const cache = path.join(config.musicCoverCachePath, one.albumUuid + '.png');
      fs.mkdirSync(config.musicCoverCachePath, { recursive: true });
      fs.writeFileSync(cache, 'cached');
      db.prepare('UPDATE music_albums SET cover_cache_path = ? WHERE id = ?').run(cache, album.id);
      let coverCalls = 0;
      let result = null;
      let failure = null;
      try {
        result = await updateMusicAlbumEmbeddedMetadata(one.albumUuid, {
          album: 'Album', albumArtists: ['Album Artist'], genres: ['Rock'], date: '2020', year: 2020,
          trackTotal: 2, discTotal: 1, compilation: false,
          coverAction: ${JSON.stringify(action)}, coverDataUrl: ${JSON.stringify(action === 'replace' ? pngDataUrl() : null)},
        }, {
          metadataUpdater: async (candidate) => path.basename(candidate).includes('01 ') ? meta('One', 1, true) : meta('Two', 2, true),
          coverUpdater: async (candidate, change) => {
            coverCalls += 1;
            if (${failSecond ? 'true' : 'false'} && coverCalls === 2) throw new Error('forced-cover-failure');
            fs.writeFileSync(candidate, change.action + '-' + fs.readFileSync(candidate, 'utf8'));
            return path.basename(candidate).includes('01 ')
              ? meta('One', 1, change.action === 'replace')
              : meta('Two', 2, change.action === 'replace');
          },
        });
      } catch (error) { failure = { code: error.code, contentPreserved: error.contentPreserved }; }
      const rows = db.prepare('SELECT file_path AS filePath, has_cover_art AS hasCoverArt FROM music_tracks ORDER BY track_number').all();
      const storedAlbum = db.prepare('SELECT cover_cache_path AS coverPath FROM music_albums WHERE id = ?').get(album.id);
      console.log(JSON.stringify({ result, failure, coverCalls, rows: rows.map((row) => ({ ...row, exists: fs.existsSync(absoluteStoredPath(row.filePath)), content: fs.existsSync(absoluteStoredPath(row.filePath)) ? fs.readFileSync(absoluteStoredPath(row.filePath), 'utf8') : null })), cacheExists: fs.existsSync(cache), storedAlbum }));
      db.close();
    })().catch((error) => { console.error(error); db.close(); process.exitCode = 1; });
  `;
  const run = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', env: environment(root),
  });
  const payload = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1));
  fs.rmSync(root, { recursive: true, force: true });
  return { run, payload };
}

test('Sostituisci incorpora una sola copertina su tutti i brani e invalida la cache', () => {
  const { run, payload } = runCase('replace');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(payload.failure, null);
  assert.equal(payload.coverCalls, 2);
  assert.equal(payload.result.coverChanged, true);
  assert.equal(payload.result.hasCoverArt, true);
  assert.deepEqual(payload.rows.map((row) => row.hasCoverArt), [1, 1]);
  assert.ok(payload.rows.every((row) => row.exists && row.content.startsWith('replace-')));
  assert.equal(payload.cacheExists, false);
  assert.equal(payload.storedAlbum.coverPath, null);
});

test('Elimina rimuove le immagini da tutti i brani con lo stesso pulsante Salva', () => {
  const { run, payload } = runCase('remove');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(payload.failure, null);
  assert.equal(payload.result.coverChanged, true);
  assert.equal(payload.result.hasCoverArt, false);
  assert.deepEqual(payload.rows.map((row) => row.hasCoverArt), [0, 0]);
  assert.ok(payload.rows.every((row) => row.content.startsWith('remove-')));
  assert.equal(payload.cacheExists, false);
});

test('un errore su un brano conserva l’intero album e la vecchia cache', () => {
  const { run, payload } = runCase('replace', true);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(payload.result, null);
  assert.equal(payload.failure.code, 'MUSIC_ALBUM_METADATA_UPDATE_FAILED');
  assert.equal(payload.failure.contentPreserved, true);
  assert.deepEqual(payload.rows.map((row) => row.hasCoverArt), [1, 1]);
  assert.ok(payload.rows.every((row) => row.exists && !row.content.startsWith('replace-')));
  assert.equal(payload.cacheExists, true);
});
