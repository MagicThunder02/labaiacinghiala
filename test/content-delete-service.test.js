'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-delete-service-'));
const library = path.join(sandbox, 'media');
const databasePath = path.join(sandbox, 'data', 'media.sqlite');
fs.mkdirSync(library, { recursive: true });
process.env.LIBRARY_PATH = library;
process.env.DATABASE_PATH = databasePath;

const db = require('../src/database');
const {
  deleteMovie,
  deleteSeries,
  deleteReading,
  deleteMusicAlbum,
} = require('../src/services/content-delete-service');

function makeFile(relativePath, contents = 'x') {
  const absolute = path.join(library, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, contents);
  return absolute;
}

function exists(relativePath) {
  return fs.existsSync(path.join(library, ...relativePath.split('/')));
}

test.after(() => {
  try { db.close(); } catch {}
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test('elimina un film: cartella e riga SQLite, incluse relazioni in cascata', async () => {
  makeFile('Film/Film Test/film-test.mp4');
  makeFile('Film/Film Test/metadata.json', '{}');
  const result = db.prepare(`
    INSERT INTO movies (file_path, relative_path, file_name, title, extension, mime_type, modified_at, media_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'movie')
  `).run('Film/Film Test/film-test.mp4', 'Film/Film Test/film-test.mp4', 'film-test.mp4', 'Film Test', '.mp4', 'video/mp4', 1);
  const id = Number(result.lastInsertRowid);
  db.prepare('INSERT INTO favorites (movie_id, profile_key) VALUES (?, ?)').run(id, 'default');
  db.prepare('INSERT INTO watch_progress (movie_id, profile_key) VALUES (?, ?)').run(id, 'default');

  await deleteMovie(id);

  assert.equal(exists('Film/Film Test'), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM movies WHERE id = ?').get(id).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM favorites WHERE movie_id = ?').get(id).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM watch_progress WHERE movie_id = ?').get(id).count, 0);
});

test('elimina una serie completa: cartella, episodi e riga series', async () => {
  makeFile('Serie/Serie Test/Stagione 1/S01E01.mp4');
  makeFile('Serie/Serie Test/metadata.json', '{}');
  db.prepare(`
    INSERT INTO series (series_uuid, directory_path, relative_path, title, metadata_path)
    VALUES (?, ?, ?, ?, ?)
  `).run('series-test-uuid', 'Serie/Serie Test', 'Serie/Serie Test', 'Serie Test', 'Serie/Serie Test/metadata.json');
  const ep = db.prepare(`
    INSERT INTO movies (
      file_path, relative_path, file_name, title, extension, mime_type, modified_at,
      media_type, series_title, series_uuid, season_number, episode_number
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'series', ?, ?, 1, 1)
  `).run(
    'Serie/Serie Test/Stagione 1/S01E01.mp4', 'Serie/Serie Test/Stagione 1/S01E01.mp4',
    'S01E01.mp4', 'Episodio 1', '.mp4', 'video/mp4', 1, 'Serie Test', 'series-test-uuid',
  );
  const episodeId = Number(ep.lastInsertRowid);
  db.prepare('INSERT INTO watch_progress (movie_id, profile_key) VALUES (?, ?)').run(episodeId, 'default');

  await deleteSeries('series-test-uuid');

  assert.equal(exists('Serie/Serie Test'), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM series WHERE series_uuid = ?').get('series-test-uuid').count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM movies WHERE series_uuid = ?').get('series-test-uuid').count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM watch_progress WHERE movie_id = ?').get(episodeId).count, 0);
});

test('elimina libri fumetti e manga dalla cartella corretta e da reading_items', async () => {
  for (const [category, folder] of [['books', 'Libri'], ['comics', 'Fumetti'], ['manga', 'Manga']]) {
    const relativeFile = `${folder}/${category}-test/documento.pdf`;
    makeFile(relativeFile, '%PDF-test');
    makeFile(`${folder}/${category}-test/metadata.json`, '{}');
    const inserted = db.prepare(`
      INSERT INTO reading_items (
        content_uuid, category, file_path, relative_path, file_name, title,
        extension, mime_type, modified_at, metadata_path
      ) VALUES (?, ?, ?, ?, ?, ?, '.pdf', 'application/pdf', 1, ?)
    `).run(
      `${category}-uuid`, category, relativeFile, relativeFile, 'documento.pdf', `${category} Test`,
      `${folder}/${category}-test/metadata.json`,
    );
    const id = Number(inserted.lastInsertRowid);
    db.prepare('INSERT INTO reading_bookmarks (reading_item_id, profile_key, locator_json) VALUES (?, ?, ?)')
      .run(id, 'default', '{}');

    await deleteReading(id);

    assert.equal(exists(`${folder}/${category}-test`), false);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM reading_items WHERE id = ?').get(id).count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM reading_bookmarks WHERE reading_item_id = ?').get(id).count, 0);
  }
});

test('elimina un album: cartella, brani, album e relazioni musicali', async () => {
  const relativeAlbum = 'Musica/Artista Test/Album Test';
  makeFile(`${relativeAlbum}/01 Brano.mp3`, 'fake-mp3');
  const album = db.prepare(`
    INSERT INTO music_albums (album_uuid, title, directory_path, relative_path, album_artists_json)
    VALUES (?, ?, ?, ?, ?)
  `).run('album-test-uuid', 'Album Test', relativeAlbum, relativeAlbum, '["Artista Test"]');
  const albumId = Number(album.lastInsertRowid);
  const track = db.prepare(`
    INSERT INTO music_tracks (
      track_uuid, album_id, file_path, relative_path, file_name, title,
      extension, mime_type, modified_at
    ) VALUES (?, ?, ?, ?, ?, ?, '.mp3', 'audio/mpeg', 1)
  `).run('track-test-uuid', albumId, `${relativeAlbum}/01 Brano.mp3`, `${relativeAlbum}/01 Brano.mp3`, '01 Brano.mp3', 'Brano');
  const trackId = Number(track.lastInsertRowid);
  db.prepare('INSERT INTO music_track_favorites (track_id, profile_key) VALUES (?, ?)').run(trackId, 'default');
  db.prepare('INSERT INTO music_listening_history (track_id, profile_key) VALUES (?, ?)').run(trackId, 'default');

  await deleteMusicAlbum('album-test-uuid');

  assert.equal(exists(relativeAlbum), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM music_tracks WHERE id = ?').get(trackId).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM music_albums WHERE id = ?').get(albumId).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM music_track_favorites WHERE track_id = ?').get(trackId).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM music_listening_history WHERE track_id = ?').get(trackId).count, 0);
});
