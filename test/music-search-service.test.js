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

test('ricerca Musica unificata normalizza accenti e punteggiatura e restituisce copertine per card e collage', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-music-search-'));
  const script = String.raw`
    const fs = require('node:fs');
    const path = require('node:path');
    const db = require('./src/database');

    const artistId = Number(db.prepare(
      'INSERT INTO music_artists (artist_uuid, name, sort_name) VALUES (?, ?, ?)'
    ).run('artist-bjork', 'Björk', 'Bjork').lastInsertRowid);

    const albumDirectory = path.join(process.env.LIBRARY_PATH, 'Musica', 'Björk', "Città d Oro");
    fs.mkdirSync(albumDirectory, { recursive: true });
    const albumId = Number(db.prepare(
      'INSERT INTO music_albums (album_uuid, title, directory_path, relative_path, album_artists_json, genres_json, year) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      'album-citta',
      "Città d'Oro",
      albumDirectory,
      path.relative(process.env.LIBRARY_PATH, albumDirectory),
      JSON.stringify(['Björk']),
      JSON.stringify(['Art Pop']),
      1997,
    ).lastInsertRowid);
    db.prepare('INSERT INTO music_album_artists (album_id, artist_id, position) VALUES (?, ?, 0)').run(albumId, artistId);

    const fileName = '01 Jóga.mp3';
    const filePath = path.join(albumDirectory, fileName);
    fs.writeFileSync(filePath, 'fixture');
    const stats = fs.statSync(filePath);
    const trackId = Number(db.prepare(
      'INSERT INTO music_tracks (track_uuid, album_id, file_path, relative_path, file_name, title, artists_json, genres_json, composers_json, year, track_number, track_total, extension, mime_type, duration_seconds, duration_ms, size_bytes, modified_at, has_cover_art, available) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)'
    ).run(
      'track-joga', albumId, filePath, path.relative(process.env.LIBRARY_PATH, filePath), fileName,
      'Jóga', JSON.stringify(['Björk']), JSON.stringify(['Art Pop']), '[]', 1997, 1, 1,
      '.mp3', 'audio/mpeg', 302, 302000, stats.size, Math.trunc(stats.mtimeMs),
    ).lastInsertRowid);
    db.prepare('INSERT INTO music_track_artists (track_id, artist_id, position) VALUES (?, ?, 0)').run(trackId, artistId);

    const service = require('./src/services/music-catalog-service');
    const payload = {
      artist: service.searchMusicCatalog('pietro', { q: 'bjork' }),
      album: service.searchMusicCatalog('pietro', { q: 'citta oro' }),
      track: service.searchMusicCatalog('pietro', { q: 'joga' }),
      genre: service.searchMusicCatalog('pietro', { q: 'art-pop' }),
      tooShort: service.searchMusicCatalog('pietro', { q: 'j' }),
      noTypoCorrection: service.searchMusicCatalog('pietro', { q: 'bjrok' }),
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

  assert.equal(payload.artist.topResult.type, 'artist');
  assert.equal(payload.artist.topResult.item.name, 'Björk');
  assert.equal(payload.artist.artists[0].coverUrls.length, 1);
  assert.match(payload.artist.artists[0].coverUrls[0], /^\/api\/music\/albums\/album-citta\/cover\?v=/);

  assert.equal(payload.album.topResult.type, 'album');
  assert.equal(payload.album.albums[0].title, "Città d'Oro");
  assert.match(payload.album.albums[0].coverUrl, /^\/api\/music\/albums\/album-citta\/cover\?v=/);

  assert.equal(payload.track.topResult.type, 'track');
  assert.equal(payload.track.tracks[0].title, 'Jóga');
  assert.equal(payload.track.tracks[0].streamUrl, '/api/music/tracks/track-joga/stream');

  assert.equal(payload.genre.topResult.type, 'genre');
  assert.equal(payload.genre.genres[0].name, 'Art Pop');
  assert.equal(payload.genre.genres[0].albumCount, 1);
  assert.equal(payload.genre.genres[0].trackCount, 1);
  assert.equal(payload.genre.genres[0].coverUrls.length, 1);

  assert.equal(payload.tooShort.minimumLength, 2);
  assert.equal(payload.tooShort.counts.total, 0);
  assert.equal(payload.noTypoCorrection.counts.total, 0);

  fs.rmSync(root, { recursive: true, force: true });
});
