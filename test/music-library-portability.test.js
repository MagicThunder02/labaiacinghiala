'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const {
  assertMusicRelativePath,
  relativePathFromLegacyMusicAbsolute,
  normalizeMusicCoverCacheKey,
} = require('../src/services/music-library-path-service');

function environment(root, libraryPath, databasePath) {
  return {
    ...process.env,
    LIBRARY_PATH: libraryPath,
    DATABASE_PATH: databasePath,
    DATABASE_BACKUPS_PATH: path.join(root, 'backups'),
    METADATA_POSTER_CACHE_PATH: path.join(root, 'poster-cache'),
    MUSIC_COVER_CACHE_PATH: path.join(root, 'music-cover-cache'),
    METADATA_POSTERS_PATH: path.join(root, 'legacy-posters'),
    UPLOAD_TEMP_PATH: path.join(libraryPath, '.uploads'),
  };
}

function runNode(script, env) {
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: projectRoot,
    encoding: 'utf8',
    env,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim().split(/\r?\n/).at(-1);
}

test('normalizza soltanto percorsi nella sezione Musica e chiavi cache portabili', () => {
  assert.equal(assertMusicRelativePath('Musica/Artista/Album/01 Titolo.flac'), 'Musica/Artista/Album/01 Titolo.flac');
  assert.equal(
    relativePathFromLegacyMusicAbsolute('C:\\vecchia\\media\\Musica\\Artista\\Album\\01 Titolo.flac'),
    'Musica/Artista/Album/01 Titolo.flac',
  );
  assert.throws(() => assertMusicRelativePath('Film/Test.mp4'), /non appartiene/i);
  assert.equal(normalizeMusicCoverCacheKey('C:\\vecchia\\cache\\album-id.png'), 'album-id.png');
  assert.equal(normalizeMusicCoverCacheKey('album-id.webp'), 'album-id.webp');
  assert.throws(() => normalizeMusicCoverCacheKey('../album-id.png'), /nome file/i);
});

test('schema 19 rende Musica portabile, deduplica e non consulta la vecchia libreria', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-music-portable-'));
  const oldLibraryA = path.join(root, 'baia-old-a', 'media');
  const oldLibraryB = path.join(root, 'baia-old-b', 'media');
  const newLibrary = path.join(root, 'baia-new', 'media');
  const databasePath = path.join(root, 'data', 'media.sqlite');
  const relativeTrack = path.join('Musica', 'Artist', 'Album', '01 Song.mp3');
  const relativeAlbum = path.dirname(relativeTrack);

  for (const [library, content] of [[oldLibraryA, 'OLD-A'], [oldLibraryB, 'OLD-B'], [newLibrary, 'NEW']]) {
    const candidate = path.join(library, relativeTrack);
    fs.mkdirSync(path.dirname(candidate), { recursive: true });
    fs.writeFileSync(candidate, content);
  }

  const seed = `
    const path = require('node:path');
    const db = require('./src/database');
    db.exec('DROP INDEX IF EXISTS idx_music_tracks_relative_path; DROP INDEX IF EXISTS idx_music_albums_relative_path;');
    const artistId = Number(db.prepare('INSERT INTO music_artists (artist_uuid, name) VALUES (?, ?)').run('artist-portable', 'Artist').lastInsertRowid);
    function add(root, suffix, available, updatedAt) {
      const albumPath = path.join(root, ${JSON.stringify(relativeAlbum)});
      const trackPath = path.join(root, ${JSON.stringify(relativeTrack)});
      const albumId = Number(db.prepare(\`INSERT INTO music_albums (
        album_uuid, title, directory_path, relative_path, album_artists_json,
        genres_json, cover_cache_path, updated_at
      ) VALUES (?, 'Album', ?, ?, '["Artist"]', '[]', ?, ?)\`).run(
        'album-' + suffix, albumPath, albumPath, path.join(root, 'cache', 'album-' + suffix + '.png'), updatedAt,
      ).lastInsertRowid);
      db.prepare('INSERT INTO music_album_artists (album_id, artist_id, position) VALUES (?, ?, 0)').run(albumId, artistId);
      const trackId = Number(db.prepare(\`INSERT INTO music_tracks (
        track_uuid, album_id, file_path, relative_path, file_name, title,
        artists_json, genres_json, composers_json, track_number, extension,
        mime_type, size_bytes, modified_at, available, updated_at
      ) VALUES (?, ?, ?, ?, '01 Song.mp3', 'Song', '["Artist"]', '[]', '[]', 1,
        '.mp3', 'audio/mpeg', 5, 1, ?, ?)\`).run(
        'track-' + suffix, albumId, trackPath, trackPath, available, updatedAt,
      ).lastInsertRowid);
      db.prepare('INSERT INTO music_track_artists (track_id, artist_id, position) VALUES (?, ?, 0)').run(trackId, artistId);
      return { albumId, trackId };
    }
    const first = add(${JSON.stringify(oldLibraryA)}, 'a', 0, '2026-01-01T00:00:00.000Z');
    const second = add(${JSON.stringify(oldLibraryB)}, 'b', 1, '2026-02-01T00:00:00.000Z');
    db.prepare('INSERT INTO music_track_favorites (track_id, profile_key) VALUES (?, ?)').run(first.trackId, 'default');
    db.prepare(\`INSERT INTO music_listening_history (
      track_id, profile_key, play_count, completed_count, last_position_seconds,
      last_duration_seconds, last_played_at, updated_at
    ) VALUES (?, 'default', 2, 1, 10, 100, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')\`).run(first.trackId);
    db.prepare(\`INSERT INTO music_listening_history (
      track_id, profile_key, play_count, completed_count, last_position_seconds,
      last_duration_seconds, last_played_at, updated_at
    ) VALUES (?, 'default', 5, 2, 40, 100, '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')\`).run(second.trackId);
    const playlistId = Number(db.prepare('INSERT INTO music_playlists (playlist_uuid, profile_key, name) VALUES (?, ?, ?)').run('playlist-portable', 'default', 'Portable').lastInsertRowid);
    db.prepare('INSERT INTO music_playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, 0)').run(playlistId, first.trackId);
    db.exec('PRAGMA user_version = 13');
    db.close();
  `;
  runNode(seed, environment(root, oldLibraryA, databasePath));

  const migrate = `
    const fs = require('node:fs');
    const path = require('node:path');
    const db = require('./src/database');
    const { musicTrackPath, musicAlbumDirectoryPath } = require('./src/services/music-library-path-service');
    const tracks = db.prepare('SELECT * FROM music_tracks').all();
    const albums = db.prepare('SELECT * FROM music_albums').all();
    const track = tracks[0];
    const album = albums[0];
    const history = db.prepare('SELECT * FROM music_listening_history').get();
    console.log(JSON.stringify({
      version: Number(db.prepare('PRAGMA user_version').get().user_version),
      trackCount: tracks.length,
      albumCount: albums.length,
      storedTrack: [track.file_path, track.relative_path],
      storedAlbum: [album.directory_path, album.relative_path],
      coverCachePath: album.cover_cache_path,
      resolvedTrack: musicTrackPath(track),
      resolvedAlbum: musicAlbumDirectoryPath(album),
      content: fs.readFileSync(musicTrackPath(track), 'utf8'),
      favoriteCount: Number(db.prepare('SELECT COUNT(*) AS count FROM music_track_favorites').get().count),
      playlistCount: Number(db.prepare('SELECT COUNT(*) AS count FROM music_playlist_tracks').get().count),
      history: { playCount: history.play_count, position: history.last_position_seconds },
      foreignKeys: db.prepare('PRAGMA foreign_key_check').all().length,
    }));
    db.close();
  `;
  const payload = JSON.parse(runNode(migrate, environment(root, newLibrary, databasePath)));

  assert.equal(payload.version, 19);
  assert.equal(payload.trackCount, 1);
  assert.equal(payload.albumCount, 1);
  assert.deepEqual(payload.storedTrack, ['Musica/Artist/Album/01 Song.mp3', 'Musica/Artist/Album/01 Song.mp3']);
  assert.deepEqual(payload.storedAlbum, ['Musica/Artist/Album', 'Musica/Artist/Album']);
  assert.equal(payload.coverCachePath, null);
  assert.ok(payload.resolvedTrack.startsWith(path.resolve(newLibrary) + path.sep));
  assert.ok(payload.resolvedAlbum.startsWith(path.resolve(newLibrary) + path.sep));
  assert.doesNotMatch(payload.resolvedTrack, /baia-old/i);
  assert.equal(payload.content, 'NEW');
  assert.equal(payload.favoriteCount, 1);
  assert.equal(payload.playlistCount, 1);
  assert.deepEqual(payload.history, { playCount: 5, position: 40 });
  assert.equal(payload.foreignKeys, 0);

  fs.rmSync(root, { recursive: true, force: true });
});
