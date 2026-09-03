'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);

test('un MP3 catalogato viene modificato realmente e ricollocato mantenendo il track UUID', {
  skip: nodeMajor < 24 ? 'taglib-wasm 1.6.1 richiede Node 24 o successivo.' : false,
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-music-metadata-real-'));
  const library = path.join(root, 'media');
  const musicRoot = path.join(library, 'Musica');
  const originalDirectory = path.join(musicRoot, 'Baia Album Artist', 'Baia Integration Album');
  const originalPath = path.join(originalDirectory, '02 Baia Fixture.mp3');
  fs.mkdirSync(originalDirectory, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'music', 'fixture.mp3'), originalPath);

  const env = {
    ...process.env,
    DATABASE_PATH: path.join(root, 'media.sqlite'),
    DATABASE_BACKUPS_PATH: path.join(root, 'backups'),
    LIBRARY_PATH: library,
    METADATA_POSTER_CACHE_PATH: path.join(root, 'poster-cache'),
    METADATA_POSTERS_PATH: path.join(root, 'posters'),
    MUSIC_COVER_CACHE_PATH: path.join(root, 'music-cover-cache'),
    UPLOAD_TEMP_PATH: path.join(library, '.uploads'),
  };

  const script = `
    const crypto = require('node:crypto');
    const fs = require('node:fs');
    const path = require('node:path');
    const db = require('./src/database');
    const config = require('./src/config');
    const absoluteStoredPath = (stored) => path.resolve(config.libraryPath, String(stored || ''));
    const { readMusicFileMetadata } = require('./src/services/music-tag-service');
    const { updateMusicTrackEmbeddedMetadata } = require('./src/services/music-metadata-edit-service');
    (async () => {
      const originalPath = ${JSON.stringify(originalPath)};
      const before = await readMusicFileMetadata(originalPath);
      const artistUuid = crypto.randomUUID();
      const albumUuid = crypto.randomUUID();
      const trackUuid = crypto.randomUUID();
      const artistId = Number(db.prepare('INSERT INTO music_artists (artist_uuid, name) VALUES (?, ?)').run(artistUuid, before.tags.albumArtist || before.tags.artist).lastInsertRowid);
      const albumId = Number(db.prepare('INSERT INTO music_albums (album_uuid, title, directory_path, relative_path, album_artists_json, genres_json, year) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        albumUuid, before.tags.album, path.dirname(originalPath), path.relative(config.libraryPath, path.dirname(originalPath)), JSON.stringify(before.tags.albumArtists.length ? before.tags.albumArtists : before.tags.artists), JSON.stringify(before.tags.genres), before.tags.year,
      ).lastInsertRowid);
      db.prepare('INSERT INTO music_album_artists (album_id, artist_id, position) VALUES (?, ?, 0)').run(albumId, artistId);
      const stats = fs.statSync(originalPath);
      const trackId = Number(db.prepare(` + "`" + `
        INSERT INTO music_tracks (
          track_uuid, album_id, file_path, relative_path, file_name, title,
          artists_json, genres_json, composers_json, comment, date_text, year,
          track_number, track_total, disc_number, disc_total, compilation,
          extension, mime_type, duration_seconds, duration_ms, size_bytes,
          modified_at, has_cover_art
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ` + "`" + `).run(
        trackUuid, albumId, originalPath, path.relative(config.libraryPath, originalPath), path.basename(originalPath), before.tags.title,
        JSON.stringify(before.tags.artists), JSON.stringify(before.tags.genres), JSON.stringify(before.tags.composers), before.tags.comment, before.tags.date, before.tags.year,
        before.tags.trackNumber, before.tags.trackTotal, before.tags.discNumber, before.tags.discTotal, before.tags.compilation ? 1 : 0,
        '.mp3', 'audio/mpeg', before.properties.durationSeconds, before.properties.durationMs, stats.size, Math.trunc(stats.mtimeMs), before.hasCoverArt ? 1 : 0,
      ).lastInsertRowid);
      db.prepare('INSERT INTO music_track_artists (track_id, artist_id, position) VALUES (?, ?, 0)').run(trackId, artistId);

      const result = await updateMusicTrackEmbeddedMetadata(trackUuid, {
        title: 'Real Edited Track',
        artist: 'Real Track Artist',
        album: 'Real Edited Album',
        albumArtist: 'Real Album Artist',
        trackNumber: 4,
        year: 2026,
      });
      const row = db.prepare('SELECT track_uuid AS trackUuid, file_path AS filePath, title FROM music_tracks WHERE id = ?').get(trackId);
      const reread = await readMusicFileMetadata(absoluteStoredPath(row.filePath));
      console.log(JSON.stringify({ result, row, reread, oldExists: fs.existsSync(originalPath), newExists: fs.existsSync(absoluteStoredPath(row.filePath)) }));
      db.close();
    })().catch((error) => { console.error(error); db.close(); process.exitCode = 1; });
  `;

  const run = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env,
  });
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(payload.row.trackUuid, payload.result.trackId);
  assert.equal(payload.row.title, 'Real Edited Track');
  assert.equal(payload.reread.tags.title, 'Real Edited Track');
  assert.equal(payload.reread.tags.album, 'Real Edited Album');
  assert.equal(payload.reread.tags.albumArtist, 'Real Album Artist');
  assert.equal(payload.reread.tags.trackNumber, 4);
  assert.equal(payload.oldExists, false);
  assert.equal(payload.newExists, true);

  fs.rmSync(root, { recursive: true, force: true });
});
