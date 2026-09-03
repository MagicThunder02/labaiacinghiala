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

test('artisti usa solo Album Artist e collage album alfabetico; playlist usa le prime quattro copertine distinte', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-music-collages-'));
  const script = String.raw`
    const fs = require('node:fs');
    const path = require('node:path');
    const db = require('./src/database');

    const groupId = Number(db.prepare(
      'INSERT INTO music_artists (artist_uuid, name) VALUES (?, ?)'
    ).run('artist-group', 'Il Gruppo').lastInsertRowid);
    const guestId = Number(db.prepare(
      'INSERT INTO music_artists (artist_uuid, name) VALUES (?, ?)'
    ).run('artist-guest', 'Ospite').lastInsertRowid);

    function addAlbum(uuid, title) {
      const directory = path.join(process.env.LIBRARY_PATH, 'Musica', 'Il Gruppo', title);
      fs.mkdirSync(directory, { recursive: true });
      const albumId = Number(db.prepare(
        'INSERT INTO music_albums (album_uuid, title, directory_path, relative_path, album_artists_json, genres_json) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(uuid, title, directory, path.relative(process.env.LIBRARY_PATH, directory), '["Il Gruppo"]', '["Rock"]').lastInsertRowid);
      db.prepare('INSERT INTO music_album_artists (album_id, artist_id, position) VALUES (?, ?, 0)').run(albumId, groupId);
      return { albumId, directory };
    }

    function addTrack(uuid, album, number, title) {
      const fileName = String(number).padStart(2, '0') + ' ' + title + '.mp3';
      const filePath = path.join(album.directory, fileName);
      fs.writeFileSync(filePath, uuid);
      const stats = fs.statSync(filePath);
      const trackId = Number(db.prepare(
        'INSERT INTO music_tracks (track_uuid, album_id, file_path, relative_path, file_name, title, artists_json, genres_json, composers_json, track_number, extension, mime_type, duration_seconds, duration_ms, size_bytes, modified_at, has_cover_art, available) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)'
      ).run(uuid, album.albumId, filePath, path.relative(process.env.LIBRARY_PATH, filePath), fileName, title, '["Ospite"]', '["Rock"]', '[]', number, '.mp3', 'audio/mpeg', 180, 180000, stats.size, Math.trunc(stats.mtimeMs)).lastInsertRowid);
      db.prepare('INSERT INTO music_track_artists (track_id, artist_id, position) VALUES (?, ?, 0)').run(trackId, guestId);
      return uuid;
    }

    const zeta = addAlbum('album-zeta', 'Zeta');
    const alpha = addAlbum('album-alpha', 'Alpha');
    const echo = addAlbum('album-echo', 'Echo');
    const beta = addAlbum('album-beta', 'Beta');
    const delta = addAlbum('album-delta', 'Delta');

    const trackZeta1 = addTrack('track-zeta-1', zeta, 1, 'Zeta uno');
    const trackZeta2 = addTrack('track-zeta-2', zeta, 2, 'Zeta due');
    const trackAlpha = addTrack('track-alpha', alpha, 1, 'Alpha uno');
    const trackEcho = addTrack('track-echo', echo, 1, 'Echo uno');
    const trackBeta = addTrack('track-beta', beta, 1, 'Beta uno');
    addTrack('track-delta', delta, 1, 'Delta uno');

    const catalog = require('./src/services/music-catalog-service');
    const playlists = require('./src/services/music-playlist-service');
    const created = playlists.createMusicPlaylist('pietro', { name: 'Misto' });
    const playlistId = created.playlist.playlistId;
    playlists.addMusicPlaylistTracks('pietro', playlistId, [
      trackZeta1,
      trackAlpha,
      trackZeta2,
      trackEcho,
      trackBeta,
    ]);

    console.log(JSON.stringify({
      artists: catalog.listMusicArtists('pietro', { limit: 20 }),
      group: catalog.getMusicArtist('pietro', 'artist-group'),
      guest: catalog.getMusicArtist('pietro', 'artist-guest'),
      guestSearch: catalog.searchMusicCatalog('pietro', { q: 'ospite' }),
      playlists: playlists.listMusicPlaylists('pietro'),
      playlist: playlists.getMusicPlaylist('pietro', playlistId),
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

  assert.deepEqual(payload.artists.artists.map((artist) => artist.name), ['Il Gruppo']);
  assert.deepEqual(
    payload.artists.artists[0].coverUrls.map((url) => url.match(/albums\/([^/]+)\/cover/)[1]),
    ['album-alpha', 'album-beta', 'album-delta', 'album-echo'],
  );
  assert.deepEqual(payload.group.albums.map((album) => album.title), ['Alpha', 'Beta', 'Delta', 'Echo', 'Zeta']);
  assert.equal(payload.group.artist.trackCount, 6);
  assert.equal(payload.group.tracks.length, 6);
  assert.equal(payload.guest, null);
  assert.equal(payload.guestSearch.artists.length, 0);

  const playlistSummary = payload.playlists.playlists[0];
  assert.deepEqual(
    playlistSummary.coverUrls.map((url) => url.match(/albums\/([^/]+)\/cover/)[1]),
    ['album-zeta', 'album-alpha', 'album-echo', 'album-beta'],
  );
  assert.equal(playlistSummary.coverUrl, playlistSummary.coverUrls[0]);
  assert.deepEqual(payload.playlist.playlist.coverUrls, playlistSummary.coverUrls);

  fs.rmSync(root, { recursive: true, force: true });
});
