'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function createEnvironment(root) {
  const library = path.join(root, 'media');
  fs.mkdirSync(library, { recursive: true });
  return {
    ...process.env,
    DATABASE_PATH: path.join(root, 'media.sqlite'),
    DATABASE_BACKUPS_PATH: path.join(root, 'backups'),
    LIBRARY_PATH: library,
    MUSIC_COVER_CACHE_PATH: path.join(root, 'music-cover-cache'),
    METADATA_POSTER_CACHE_PATH: path.join(root, 'poster-cache'),
    METADATA_POSTERS_PATH: path.join(root, 'posters'),
    UPLOAD_TEMP_PATH: path.join(library, '.uploads'),
  };
}

test('estrae una copertina incorporata una sola volta e poi usa la cache album', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-music-cover-'));
  const script = String.raw`
    const fs = require('node:fs');
    const path = require('node:path');
    const db = require('./src/database');
    const albumDirectory = path.join(process.env.LIBRARY_PATH, 'Musica', 'Artista', 'Album');
    fs.mkdirSync(albumDirectory, { recursive: true });
    const trackPath = path.join(albumDirectory, '01 Brano.mp3');
    fs.writeFileSync(trackPath, 'audio-fixture');
    const albumId = Number(db.prepare(
      'INSERT INTO music_albums (album_uuid, title, directory_path, relative_path, album_artists_json) VALUES (?, ?, ?, ?, ?)'
    ).run('album-cover', 'Album', albumDirectory, path.relative(process.env.LIBRARY_PATH, albumDirectory), '["Artista"]').lastInsertRowid);
    db.prepare(
      'INSERT INTO music_tracks (track_uuid, album_id, file_path, relative_path, file_name, title, artists_json, genres_json, composers_json, track_number, extension, mime_type, size_bytes, modified_at, has_cover_art, available) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)'
    ).run('track-cover', albumId, trackPath, path.relative(process.env.LIBRARY_PATH, trackPath), path.basename(trackPath), 'Brano', '["Artista"]', '[]', '[]', 1, '.mp3', 'audio/mpeg', 13, Date.now());

    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=', 'base64');
    let reads = 0;
    const coverReader = async () => {
      reads += 1;
      return { data: png, mimeType: 'image/png', type: 'FrontCover', description: 'Cover' };
    };

    (async () => {
      const service = require('./src/services/music-cover-service');
      const first = await service.getMusicAlbumCover('album-cover', { coverReader, strict: true });
      const second = await service.getMusicAlbumCover('album-cover', {
        coverReader: async () => { throw new Error('la cache non è stata usata'); },
        strict: true,
      });
      const row = db.prepare('SELECT cover_cache_path AS coverCachePath FROM music_albums WHERE id = ?').get(albumId);
      console.log(JSON.stringify({
        reads,
        first: { mimeType: first.mimeType, size: first.size, baseName: path.basename(first.filePath) },
        second: { filePath: second.filePath, mimeType: second.mimeType },
        cacheKey: row.coverCachePath,
        cachePath: path.join(process.env.MUSIC_COVER_CACHE_PATH, row.coverCachePath),
        cacheExists: fs.existsSync(path.join(process.env.MUSIC_COVER_CACHE_PATH, row.coverCachePath)),
      }));
      db.close();
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `;

  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: createEnvironment(root),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(payload.reads, 1);
  assert.equal(payload.first.mimeType, 'image/png');
  assert.equal(payload.first.baseName, 'album-cover.png');
  assert.ok(payload.first.size > 0);
  assert.equal(payload.cacheKey, 'album-cover.png');
  assert.equal(payload.second.filePath, payload.cachePath);
  assert.equal(payload.cacheExists, true);
  assert.ok(path.resolve(payload.cachePath).startsWith(path.resolve(root)));
  fs.rmSync(root, { recursive: true, force: true });
});

test('la cache accetta soltanto immagini riconosciute dai byte effettivi', () => {
  const { detectImageType } = require('../src/services/music-cover-service');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=', 'base64');
  assert.deepEqual(detectImageType(png, 'application/octet-stream'), {
    mimeType: 'image/png',
    extension: '.png',
  });
  assert.equal(detectImageType(Buffer.from('non è una immagine'), 'image/png'), null);
});
