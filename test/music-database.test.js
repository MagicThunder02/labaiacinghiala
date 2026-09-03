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

test('migrazione schema 13 crea catalogo musicale, cronologia, sessioni e playlist additive', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-music-db-'));
  const albumDirectory = path.join(root, 'media', 'Musica', 'Black Sabbath', 'Paranoid');
  const trackPath = path.join(albumDirectory, '01 Iron Man.mp3');
  fs.mkdirSync(albumDirectory, { recursive: true });
  fs.writeFileSync(trackPath, 'fixture');

  const script = `
    const path = require('node:path');
    const db = require('./src/database');
    const tables = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'music_%' ORDER BY name\").all().map((row) => row.name);
    const version = Number(db.prepare('PRAGMA user_version').get().user_version);
    const columns = db.prepare('PRAGMA table_info(music_tracks)').all().map((row) => row.name);

    const artistId = Number(db.prepare(\"INSERT INTO music_artists (artist_uuid, name) VALUES (?, ?)\").run('artist-uuid', 'Black Sabbath').lastInsertRowid);
    const albumId = Number(db.prepare(\`INSERT INTO music_albums (
      album_uuid, title, directory_path, relative_path, album_artists_json, genres_json, year
    ) VALUES (?, ?, ?, ?, ?, ?, ?)\`).run(
      'album-uuid',
      'Paranoid',
      ${JSON.stringify(albumDirectory)},
      path.join('Musica', 'Black Sabbath', 'Paranoid'),
      JSON.stringify(['Black Sabbath']),
      JSON.stringify(['Heavy Metal']),
      1970,
    ).lastInsertRowid);
    db.prepare('INSERT INTO music_album_artists (album_id, artist_id, position) VALUES (?, ?, 0)').run(albumId, artistId);

    const stats = require('node:fs').statSync(${JSON.stringify(trackPath)});
    const trackId = Number(db.prepare(\`INSERT INTO music_tracks (
      track_uuid, album_id, file_path, relative_path, file_name, title,
      artists_json, genres_json, composers_json, year, track_number, track_total,
      extension, mime_type, duration_seconds, duration_ms, size_bytes, modified_at,
      has_cover_art, available, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1,
      STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'))\`).run(
      'track-uuid',
      albumId,
      ${JSON.stringify(trackPath)},
      path.join('Musica', 'Black Sabbath', 'Paranoid', '01 Iron Man.mp3'),
      '01 Iron Man.mp3',
      'Iron Man',
      JSON.stringify(['Black Sabbath']),
      JSON.stringify(['Heavy Metal']),
      JSON.stringify([]),
      1970,
      1,
      8,
      '.mp3',
      'audio/mpeg',
      355,
      355000,
      stats.size,
      Math.trunc(stats.mtimeMs),
      1,
    ).lastInsertRowid);
    db.prepare('INSERT INTO music_track_artists (track_id, artist_id, position) VALUES (?, ?, 0)').run(trackId, artistId);
    db.prepare('INSERT INTO music_track_favorites (track_id, profile_key) VALUES (?, ?)').run(trackId, 'pietro');
    db.prepare(\`INSERT INTO music_listening_history (
      track_id, profile_key, play_count, completed_count, last_position_seconds,
      last_duration_seconds, last_played_at
    ) VALUES (?, ?, 3, 2, 120, 355, STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'))\`).run(trackId, 'pietro');
    db.prepare(\`INSERT INTO music_playback_sessions (
      session_id, track_id, profile_key, qualified, completed, listened_seconds
    ) VALUES (?, ?, ?, 1, 0, 35)\`).run(
      '11111111-1111-4111-8111-111111111111',
      trackId,
      'pietro',
    );
    const playlistId = Number(db.prepare(
      'INSERT INTO music_playlists (playlist_uuid, profile_key, name) VALUES (?, ?, ?)'
    ).run('playlist-uuid', 'pietro', 'Preferite').lastInsertRowid);
    db.prepare(
      'INSERT INTO music_playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, 0)'
    ).run(playlistId, trackId);

    const beforeDelete = {
      tracks: Number(db.prepare('SELECT COUNT(*) AS count FROM music_tracks').get().count),
      favorites: Number(db.prepare('SELECT COUNT(*) AS count FROM music_track_favorites').get().count),
      history: Number(db.prepare('SELECT COUNT(*) AS count FROM music_listening_history').get().count),
      sessions: Number(db.prepare('SELECT COUNT(*) AS count FROM music_playback_sessions').get().count),
      playlists: Number(db.prepare('SELECT COUNT(*) AS count FROM music_playlists').get().count),
      playlistTracks: Number(db.prepare('SELECT COUNT(*) AS count FROM music_playlist_tracks').get().count),
    };
    db.prepare('DELETE FROM music_tracks WHERE id = ?').run(trackId);
    const afterDelete = {
      trackArtists: Number(db.prepare('SELECT COUNT(*) AS count FROM music_track_artists').get().count),
      favorites: Number(db.prepare('SELECT COUNT(*) AS count FROM music_track_favorites').get().count),
      history: Number(db.prepare('SELECT COUNT(*) AS count FROM music_listening_history').get().count),
      sessions: Number(db.prepare('SELECT COUNT(*) AS count FROM music_playback_sessions').get().count),
      playlists: Number(db.prepare('SELECT COUNT(*) AS count FROM music_playlists').get().count),
      playlistTracks: Number(db.prepare('SELECT COUNT(*) AS count FROM music_playlist_tracks').get().count),
    };

    console.log(JSON.stringify({ tables, version, columns, beforeDelete, afterDelete }));
    db.close();
  `;

  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: createEnvironment(root),
  });

  assert.equal(result.status, 0, result.stderr);
  const output = result.stdout.trim().split(/\r?\n/).at(-1);
  const payload = JSON.parse(output);
  assert.equal(payload.version, 19);
  assert.deepEqual(payload.tables, [
    'music_album_artists',
    'music_albums',
    'music_artists',
    'music_listening_history',
    'music_playback_sessions',
    'music_playlist_tracks',
    'music_playlists',
    'music_track_artists',
    'music_track_favorites',
    'music_tracks',
  ]);
  for (const requiredColumn of [
    'track_uuid',
    'album_id',
    'file_path',
    'relative_path',
    'artists_json',
    'genres_json',
    'track_number',
    'disc_number',
    'duration_ms',
    'sample_rate_hz',
    'has_cover_art',
    'available',
  ]) {
    assert.ok(payload.columns.includes(requiredColumn), `Colonna mancante: ${requiredColumn}`);
  }
  assert.deepEqual(payload.beforeDelete, { tracks: 1, favorites: 1, history: 1, sessions: 1, playlists: 1, playlistTracks: 1 });
  assert.deepEqual(payload.afterDelete, { trackArtists: 0, favorites: 0, history: 0, sessions: 0, playlists: 1, playlistTracks: 0 });
  fs.rmSync(root, { recursive: true, force: true });
});
