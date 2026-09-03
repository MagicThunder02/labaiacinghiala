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
    METADATA_POSTER_CACHE_PATH: path.join(root, 'poster-cache'),
    METADATA_POSTERS_PATH: path.join(root, 'posters'),
    UPLOAD_TEMP_PATH: path.join(library, '.uploads'),
  };
}

test('preferiti musicali sono per profilo e l azione album aggiunge o rimuove tutti i brani disponibili', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-music-favorites-'));
  const script = String.raw`
    const path = require('node:path');
    const fs = require('node:fs');
    const db = require('./src/database');

    const albumDir = path.join(process.env.LIBRARY_PATH, 'Musica', 'Artista', 'Album');
    fs.mkdirSync(albumDir, { recursive: true });
    const albumId = Number(db.prepare(
      'INSERT INTO music_albums (album_uuid, title, directory_path, relative_path, album_artists_json, genres_json) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('album-1', 'Album', albumDir, path.relative(process.env.LIBRARY_PATH, albumDir), '["Artista"]', '["Rock"]').lastInsertRowid);

    function insertTrack(uuid, number, available = 1) {
      const fileName = String(number).padStart(2, '0') + ' Brano ' + number + '.mp3';
      const filePath = path.join(albumDir, fileName);
      fs.writeFileSync(filePath, 'fixture-' + uuid);
      return Number(db.prepare(
        'INSERT INTO music_tracks (track_uuid, album_id, file_path, relative_path, file_name, title, artists_json, genres_json, composers_json, track_number, extension, mime_type, duration_seconds, duration_ms, size_bytes, modified_at, available) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(uuid, albumId, filePath, path.relative(process.env.LIBRARY_PATH, filePath), fileName, 'Brano ' + number, '["Artista"]', '["Rock"]', '[]', number, '.mp3', 'audio/mpeg', 180, 180000, fs.statSync(filePath).size, Math.trunc(fs.statSync(filePath).mtimeMs), available).lastInsertRowid);
    }

    insertTrack('track-1', 1, 1);
    insertTrack('track-2', 2, 1);
    insertTrack('track-offline', 3, 0);

    const service = require('./src/services/music-favorite-service');
    const first = service.setMusicTrackFavorite('pietro', 'track-1', true);
    const otherProfileCount = db.prepare('SELECT COUNT(*) AS count FROM music_track_favorites WHERE profile_key = ?').get('other').count;
    const all = service.setMusicAlbumFavorite('pietro', 'album-1', true);
    const afterAll = db.prepare('SELECT COUNT(*) AS count FROM music_track_favorites WHERE profile_key = ?').get('pietro').count;
    const removed = service.setMusicAlbumFavorite('pietro', 'album-1', false);
    const afterRemove = db.prepare('SELECT COUNT(*) AS count FROM music_track_favorites WHERE profile_key = ?').get('pietro').count;

    console.log(JSON.stringify({
      first,
      all,
      removed,
      otherProfileCount,
      afterAll,
      afterRemove,
      missingTrack: service.setMusicTrackFavorite('pietro', 'missing', true),
      missingAlbum: service.setMusicAlbumFavorite('pietro', 'missing', true),
    }));
    db.close();
  `;

  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: createEnvironment(root),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  assert.deepEqual(payload.first, {
    trackId: 'track-1',
    favorite: true,
    album: {
      albumId: 'album-1',
      favorite: true,
      fullyFavorite: false,
      favoriteTrackCount: 1,
      trackCount: 2,
    },
  });
  assert.equal(payload.otherProfileCount, 0);
  assert.equal(payload.afterAll, 2);
  assert.deepEqual(payload.all, {
    albumId: 'album-1',
    favorite: true,
    fullyFavorite: true,
    favoriteTrackCount: 2,
    trackCount: 2,
  });
  assert.equal(payload.afterRemove, 0);
  assert.deepEqual(payload.removed, {
    albumId: 'album-1',
    favorite: false,
    fullyFavorite: false,
    favoriteTrackCount: 0,
    trackCount: 2,
  });
  assert.equal(payload.missingTrack, null);
  assert.equal(payload.missingAlbum, null);
  fs.rmSync(root, { recursive: true, force: true });
});
