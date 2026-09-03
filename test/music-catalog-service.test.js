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

function assertNoServerPaths(value) {
  const serialized = JSON.stringify(value);
  for (const forbidden of ['filePath', 'relativePath', 'directoryPath', 'fileName']) {
    assert.equal(serialized.includes(`"${forbidden}"`), false, `Campo server esposto: ${forbidden}`);
  }
}

test('catalogo musica restituisce album artisti brani recenti e preferiti senza path del server', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-music-catalog-'));
  const script = String.raw`
    const path = require('node:path');
    const fs = require('node:fs');
    const db = require('./src/database');

    function artist(uuid, name) {
      return Number(db.prepare('INSERT INTO music_artists (artist_uuid, name) VALUES (?, ?)').run(uuid, name).lastInsertRowid);
    }
    function album(uuid, title, folder, artists, genres, year) {
      const directory = path.join(process.env.LIBRARY_PATH, 'Musica', folder, title);
      fs.mkdirSync(directory, { recursive: true });
      return Number(db.prepare(
        'INSERT INTO music_albums (album_uuid, title, directory_path, relative_path, album_artists_json, genres_json, year) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(uuid, title, directory, path.relative(process.env.LIBRARY_PATH, directory), JSON.stringify(artists), JSON.stringify(genres), year).lastInsertRowid);
    }
    function track(uuid, albumId, title, number, artists, genres, year) {
      const album = db.prepare('SELECT directory_path AS directoryPath FROM music_albums WHERE id = ?').get(albumId);
      const fileName = String(number).padStart(2, '0') + ' ' + title + '.mp3';
      const filePath = path.join(album.directoryPath, fileName);
      fs.writeFileSync(filePath, 'fixture-' + uuid);
      const stats = fs.statSync(filePath);
      return Number(db.prepare(
        'INSERT INTO music_tracks (track_uuid, album_id, file_path, relative_path, file_name, title, artists_json, genres_json, composers_json, year, track_number, track_total, extension, mime_type, duration_seconds, duration_ms, size_bytes, modified_at, has_cover_art, available) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)'
      ).run(uuid, albumId, filePath, path.relative(process.env.LIBRARY_PATH, filePath), fileName, title, JSON.stringify(artists), JSON.stringify(genres), '[]', year, number, 2, '.mp3', 'audio/mpeg', 180 + number, (180 + number) * 1000, stats.size, Math.trunc(stats.mtimeMs), number === 1 ? 1 : 0).lastInsertRowid);
    }

    const artistA = artist('artist-a', 'Artista A');
    const artistB = artist('artist-b', 'Artista B');
    const albumA = album('album-a', 'Album A', 'Artista A', ['Artista A'], ['Rock'], 2024);
    const albumB = album('album-b', 'Album B', 'Artista A', ['Artista A'], ['Rock'], 2025);
    const albumC = album('album-c', 'Album C', 'Artista B', ['Artista B'], ['Jazz'], 2020);
    db.prepare('INSERT INTO music_album_artists (album_id, artist_id, position) VALUES (?, ?, 0)').run(albumA, artistA);
    db.prepare('INSERT INTO music_album_artists (album_id, artist_id, position) VALUES (?, ?, 0)').run(albumB, artistA);
    db.prepare('INSERT INTO music_album_artists (album_id, artist_id, position) VALUES (?, ?, 0)').run(albumC, artistB);

    const trackA1 = track('track-a1', albumA, 'Primo', 1, ['Artista A'], ['Rock'], 2024);
    const trackA2 = track('track-a2', albumA, 'Secondo', 2, ['Artista A'], ['Rock'], 2024);
    const trackB1 = track('track-b1', albumB, 'Affine', 1, ['Artista A'], ['Rock'], 2025);
    const trackC1 = track('track-c1', albumC, 'Altro', 1, ['Artista B'], ['Jazz'], 2020);
    for (const [trackId, artistId] of [[trackA1, artistA], [trackA2, artistA], [trackB1, artistA], [trackC1, artistB]]) {
      db.prepare('INSERT INTO music_track_artists (track_id, artist_id, position) VALUES (?, ?, 0)').run(trackId, artistId);
    }
    db.prepare('INSERT INTO music_track_favorites (track_id, profile_key) VALUES (?, ?)').run(trackA1, 'pietro');
    db.prepare("INSERT INTO music_listening_history (track_id, profile_key, play_count, completed_count, last_position_seconds, last_duration_seconds, last_played_at) VALUES (?, ?, 4, 2, 80, 181, '2026-08-03T10:00:00.000Z')").run(trackA1, 'pietro');

    const service = require('./src/services/music-catalog-service');
    const payload = {
      home: service.getMusicHome('pietro'),
      albums: service.listMusicAlbums('pietro', { limit: 10 }),
      favorites: service.listMusicAlbums('pietro', { favoritesOnly: '1' }),
      album: service.getMusicAlbum('pietro', 'album-a'),
      favoriteAlbum: service.getMusicAlbum('pietro', 'album-a', { favoritesOnly: '1' }),
      artists: service.listMusicArtists('pietro', {}),
      artist: service.getMusicArtist('pietro', 'artist-a'),
      track: service.getMusicTrack('pietro', 'track-a1'),
      filters: service.getMusicFilters('pietro'),
      otherProfile: {
        home: service.getMusicHome('other'),
        favorites: service.listMusicAlbums('other', { favoritesOnly: '1' }),
      },
    };
    console.log(JSON.stringify(payload));
    db.close();
  `;

  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: createEnvironment(root),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  assertNoServerPaths(payload);

  assert.deepEqual(payload.home.recent.map((track) => track.trackId), ['track-a1']);
  assert.equal(payload.home.recommended.some((album) => album.albumId === 'album-a'), false);
  assert.equal(payload.home.recommended[0].albumId, 'album-b');
  assert.deepEqual(payload.home.summary, { albumCount: 3, artistCount: 2, trackCount: 4 });

  assert.equal(payload.albums.count, 3);
  assert.match(payload.albums.albums[0].coverUrl, /^\/api\/music\/albums\/album-a\/cover\?v=/);
  assert.equal(payload.favorites.count, 1);
  assert.equal(payload.favorites.albums[0].albumId, 'album-a');
  assert.equal(payload.favorites.albums[0].favoriteTrackCount, 1);
  assert.equal(payload.favorites.albums[0].fullyFavorite, false);

  assert.deepEqual(payload.album.tracks.map((track) => track.trackId), ['track-a1', 'track-a2']);
  assert.equal(payload.album.tracks[0].favorite, true);
  assert.deepEqual(payload.favoriteAlbum.tracks.map((track) => track.trackId), ['track-a1']);
  assert.equal(payload.track.artists[0].artistId, 'artist-a');
  assert.match(payload.track.coverUrl, /^\/api\/music\/albums\/album-a\/cover\?v=/);
  assert.equal(payload.track.streamUrl, '/api/music/tracks/track-a1/stream');
  assert.equal(payload.artist.artist.albumCount, 2);
  assert.equal(payload.artist.artist.trackCount, 3);
  assert.deepEqual(payload.artist.albums.map((album) => album.albumId), ['album-a', 'album-b']);
  assert.deepEqual(payload.filters.genres, ['Jazz', 'Rock']);
  assert.deepEqual(payload.filters.years, [2025, 2024, 2020]);

  assert.equal(payload.otherProfile.home.recent.length, 0);
  assert.equal(payload.otherProfile.favorites.count, 0);
  fs.rmSync(root, { recursive: true, force: true });
});
