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

test('playlist musicali sono isolate per profilo e supportano creazione, ordine, rimozione e cancellazione', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-music-playlists-'));
  const script = String.raw`
    const path = require('node:path');
    const db = require('./src/database');
    const service = require('./src/services/music-playlist-service');

    const albumDir = path.join(process.env.LIBRARY_PATH, 'Musica', 'Artista', 'Album');
    const albumId = Number(db.prepare(
      'INSERT INTO music_albums (album_uuid, title, directory_path, relative_path, album_artists_json, genres_json) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('album-1', 'Album', albumDir, path.relative(process.env.LIBRARY_PATH, albumDir), '["Artista"]', '["Rock"]').lastInsertRowid);

    function insertTrack(uuid, number) {
      const fileName = String(number).padStart(2, '0') + ' Brano ' + number + '.mp3';
      const filePath = path.join(albumDir, fileName);
      return Number(db.prepare(
        'INSERT INTO music_tracks (track_uuid, album_id, file_path, relative_path, file_name, title, artists_json, genres_json, composers_json, track_number, extension, mime_type, duration_seconds, duration_ms, size_bytes, modified_at, available) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)'
      ).run(uuid, albumId, filePath, path.relative(process.env.LIBRARY_PATH, filePath), fileName, 'Brano ' + number, '["Artista"]', '["Rock"]', '[]', number, '.mp3', 'audio/mpeg', 180 + number, (180 + number) * 1000, 100 + number, number).lastInsertRowid);
    }

    insertTrack('track-1', 1);
    insertTrack('track-2', 2);
    insertTrack('track-3', 3);

    const created = service.createMusicPlaylist('Pietro', { name: 'Allenamento', description: 'Energia' });
    const other = service.createMusicPlaylist('Altro', { name: 'Allenamento' });
    let duplicateError = null;
    try {
      service.createMusicPlaylist('pietro', { name: 'allenamento' });
    } catch (error) {
      duplicateError = { code: error.code, statusCode: error.statusCode };
    }

    const afterAdd = service.addMusicPlaylistTracks('pietro', created.playlist.playlistId, ['track-1', 'track-2', 'track-1']);
    const afterOrder = service.reorderMusicPlaylistTracks('pietro', created.playlist.playlistId, ['track-2', 'track-1']);
    const afterRemove = service.removeMusicPlaylistTrack('pietro', created.playlist.playlistId, 'track-2');
    const afterRename = service.updateMusicPlaylist('pietro', created.playlist.playlistId, {
      name: 'Corsa',
      description: 'Ritmo sostenuto',
    });

    let missingTrackError = null;
    try {
      service.addMusicPlaylistTracks('pietro', created.playlist.playlistId, ['missing']);
    } catch (error) {
      missingTrackError = { code: error.code, statusCode: error.statusCode };
    }

    const isolated = service.getMusicPlaylist('altro', created.playlist.playlistId);
    const beforeDelete = service.listMusicPlaylists('pietro');
    const deleted = service.deleteMusicPlaylist('pietro', created.playlist.playlistId);
    const afterDelete = service.listMusicPlaylists('pietro');

    console.log(JSON.stringify({
      created,
      other,
      duplicateError,
      afterAdd,
      afterOrder,
      afterRemove,
      afterRename,
      missingTrackError,
      isolated,
      beforeDelete,
      deleted,
      afterDelete,
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
  assert.equal(payload.created.playlist.name, 'Allenamento');
  assert.equal(payload.created.playlist.trackCount, 0);
  assert.equal(payload.other.playlist.name, 'Allenamento');
  assert.deepEqual(payload.duplicateError, {
    code: 'MUSIC_PLAYLIST_NAME_CONFLICT',
    statusCode: 409,
  });
  assert.deepEqual(payload.afterAdd.tracks.map((track) => track.trackId), ['track-1', 'track-2']);
  assert.equal(payload.afterAdd.playlist.trackCount, 2);
  assert.deepEqual(payload.afterOrder.tracks.map((track) => track.trackId), ['track-2', 'track-1']);
  assert.deepEqual(payload.afterRemove.tracks.map((track) => track.trackId), ['track-1']);
  assert.equal(payload.afterRename.playlist.name, 'Corsa');
  assert.equal(payload.afterRename.playlist.description, 'Ritmo sostenuto');
  assert.deepEqual(payload.missingTrackError, {
    code: 'MUSIC_PLAYLIST_TRACK_NOT_FOUND',
    statusCode: 404,
  });
  assert.equal(payload.isolated, null);
  assert.equal(payload.beforeDelete.count, 1);
  assert.deepEqual(payload.deleted, {
    playlistId: payload.created.playlist.playlistId,
    deleted: true,
  });
  assert.equal(payload.afterDelete.count, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('validazione playlist limita nomi, descrizioni e liste di brani', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-music-playlist-validation-'));
  const script = String.raw`
    const db = require('./src/database');
    const service = require('./src/services/music-playlist-service');
    function capture(callback) {
      try { callback(); return null; }
      catch (error) { return { code: error.code, statusCode: error.statusCode }; }
    }
    console.log(JSON.stringify({
      emptyName: capture(() => service.createMusicPlaylist('p', { name: '   ' })),
      longName: capture(() => service.createMusicPlaylist('p', { name: 'x'.repeat(101) })),
      invalidTracks: capture(() => service.normalizeTrackIds('track-1')),
      emptyTracks: capture(() => service.normalizeTrackIds([])),
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
  assert.equal(payload.emptyName.code, 'MUSIC_PLAYLIST_INVALID_NAME');
  assert.equal(payload.longName.code, 'MUSIC_PLAYLIST_FIELD_TOO_LONG');
  assert.equal(payload.invalidTracks.code, 'MUSIC_PLAYLIST_INVALID_TRACKS');
  assert.equal(payload.emptyTracks.code, 'MUSIC_PLAYLIST_EMPTY_TRACKS');
  fs.rmSync(root, { recursive: true, force: true });
});
