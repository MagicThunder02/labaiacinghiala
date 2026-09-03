'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function createEnvironment(root) {
  const library = path.join(root, 'media');
  const uploads = path.join(library, '.uploads');
  fs.mkdirSync(uploads, { recursive: true });
  return {
    ...process.env,
    DATABASE_PATH: path.join(root, 'media.sqlite'),
    DATABASE_BACKUPS_PATH: path.join(root, 'backups'),
    LIBRARY_PATH: library,
    METADATA_POSTER_CACHE_PATH: path.join(root, 'poster-cache'),
    METADATA_POSTERS_PATH: path.join(root, 'posters'),
    MUSIC_COVER_CACHE_PATH: path.join(root, 'music-cover-cache'),
    UPLOAD_TEMP_PATH: uploads,
  };
}

function runScript(root, script) {
  return spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: createEnvironment(root),
  });
}

function lastJson(stdout) {
  return JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
}

function albumEditScript(root, options = {}) {
  const library = path.join(root, 'media');
  const uploads = path.join(library, '.uploads');
  const firstSource = path.join(uploads, 'first.mp3');
  const secondSource = path.join(uploads, 'second.mp3');
  fs.mkdirSync(uploads, { recursive: true });
  fs.writeFileSync(firstSource, 'track-one');
  fs.writeFileSync(secondSource, 'track-two');

  return `
    const crypto = require('node:crypto');
    const fs = require('node:fs');
    const path = require('node:path');
    const db = require('./src/database');
    const config = require('./src/config');
    const absoluteStoredPath = (stored) => path.resolve(config.libraryPath, String(stored || ''));
    const { importMusicUpload } = require('./src/services/music-import-service');
    const {
      getMusicAlbumEmbeddedMetadata,
      updateMusicAlbumEmbeddedMetadata,
    } = require('./src/services/music-album-metadata-edit-service');

    const properties = {
      durationSeconds: 180, durationMs: 180000, bitrateKbps: 320,
      sampleRateHz: 44100, channels: 2, bitsPerSample: null,
      codec: 'MPEG Audio', containerFormat: 'MPEG', isLossless: false, bitrateMode: 'CBR',
    };
    function metadata(title, artist, trackNumber, shared = {}) {
      return {
        fileName: title + '.mp3', extension: '.mp3', format: 'mp3', hasCoverArt: true,
        pictures: [{ type: 'FrontCover', mimeType: 'image/png', description: '', size: 10 }],
        tags: {
          title, artists: [artist], album: shared.album || 'Old Album',
          albumArtists: shared.albumArtists || ['Old Album Artist'],
          genres: shared.genres || ['Rock'], composers: [artist + ' Composer'],
          comment: title + ' comment', date: shared.date || '2000', year: shared.year || 2000,
          trackNumber, trackTotal: shared.trackTotal || 2, discNumber: 1,
          discTotal: shared.discTotal || 1, compilation: shared.compilation === true,
        },
        properties,
      };
    }
    const firstMetadata = metadata('Alpha', 'Track Artist A', 1);
    const secondMetadata = metadata('Beta', 'Track Artist B', 2);
    const editedShared = {
      album: 'New Album', albumArtists: ['New Album Artist'], genres: ['Metal'],
      date: '2026', year: 2026, trackTotal: 2, discTotal: 1, compilation: false,
    };
    const editedFirst = metadata('Alpha', 'Track Artist A', 1, editedShared);
    const editedSecond = metadata('Beta', 'Track Artist B', 2, editedShared);

    (async () => {
      const first = await importMusicUpload(${JSON.stringify(firstSource)}, { metadataReader: async () => firstMetadata });
      const second = await importMusicUpload(${JSON.stringify(secondSource)}, { metadataReader: async () => secondMetadata });
      const originalRows = db.prepare('SELECT id, track_uuid AS trackUuid, file_path AS filePath FROM music_tracks ORDER BY id').all();
      const albumRow = db.prepare('SELECT id, album_uuid AS albumUuid FROM music_albums WHERE album_uuid = ?').get(first.albumUuid);
      const coverPath = path.join(config.musicCoverCachePath, first.albumUuid + '.png');
      fs.mkdirSync(config.musicCoverCachePath, { recursive: true });
      fs.writeFileSync(coverPath, 'cover');
      db.prepare('UPDATE music_albums SET cover_cache_path = ? WHERE id = ?').run(coverPath, albumRow.id);
      db.prepare('INSERT INTO music_track_favorites (track_id, profile_key) VALUES (?, ?)').run(first.id, 'default');
      db.prepare('INSERT INTO music_listening_history (track_id, profile_key, play_count) VALUES (?, ?, ?)').run(first.id, 'default', 3);
      const playlistId = Number(db.prepare('INSERT INTO music_playlists (playlist_uuid, profile_key, name) VALUES (?, ?, ?)').run(crypto.randomUUID(), 'default', 'Test album').lastInsertRowid);
      db.prepare('INSERT INTO music_playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, 0)').run(playlistId, second.id);

      const conflictPath = path.join(config.mediaPaths.music, 'New Album Artist', 'New Album', '01 Alpha.mp3');
      if (${options.conflict ? 'true' : 'false'}) {
        fs.mkdirSync(path.dirname(conflictPath), { recursive: true });
        fs.writeFileSync(conflictPath, 'external-file');
      }

      let result = null;
      let failure = null;
      try {
        result = await updateMusicAlbumEmbeddedMetadata(first.albumUuid, editedShared, {
          metadataUpdater: async (stagedPath, patch) => {
            const content = fs.readFileSync(stagedPath, 'utf8');
            fs.writeFileSync(stagedPath, 'edited-' + content);
            if (patch.album !== 'New Album' || patch.albumArtists[0] !== 'New Album Artist') throw new Error('wrong-patch');
            return content.includes('one') ? editedFirst : editedSecond;
          },
          beforeDatabaseCommit: ${options.forceFailure ? "() => { throw new Error('forced-album-db-failure'); }" : 'undefined'},
        });
      } catch (error) {
        failure = { code: error.code, statusCode: error.statusCode, contentPreserved: error.contentPreserved };
      }

      const rows = db.prepare(` + "`" + `
        SELECT id, track_uuid AS trackUuid, file_path AS filePath, file_name AS fileName,
               title, artists_json AS artistsJson, track_number AS trackNumber,
               track_total AS trackTotal, disc_total AS discTotal, year
        FROM music_tracks ORDER BY track_number
      ` + "`" + `).all();
      const album = db.prepare('SELECT album_uuid AS albumUuid, title, album_artists_json AS artistsJson, genres_json AS genresJson, year, cover_cache_path AS coverPath FROM music_albums').get();
      const trackArtists = rows.map((row) => db.prepare(` + "`" + `
        SELECT a.name FROM music_track_artists ta
        JOIN music_artists a ON a.id = ta.artist_id
        WHERE ta.track_id = ? ORDER BY ta.position
      ` + "`" + `).all(row.id).map((artist) => artist.name));
      const counts = {
        favorites: Number(db.prepare('SELECT COUNT(*) AS count FROM music_track_favorites').get().count),
        history: Number(db.prepare('SELECT COUNT(*) AS count FROM music_listening_history').get().count),
        playlists: Number(db.prepare('SELECT COUNT(*) AS count FROM music_playlist_tracks').get().count),
        albums: Number(db.prepare('SELECT COUNT(*) AS count FROM music_albums').get().count),
      };
      const reread = result ? await getMusicAlbumEmbeddedMetadata(first.albumUuid, {
        metadataReader: async (candidate) => path.basename(candidate).startsWith('01 ') ? editedFirst : editedSecond,
      }) : null;
      console.log(JSON.stringify({
        first, second, result, reread, failure, album, rows, trackArtists, counts,
        originalRows: originalRows.map((row) => ({ ...row, exists: fs.existsSync(absoluteStoredPath(row.filePath)) })),
        current: rows.map((row) => ({
          filePath: row.filePath,
          exists: fs.existsSync(absoluteStoredPath(row.filePath)),
          content: fs.existsSync(absoluteStoredPath(row.filePath)) ? fs.readFileSync(absoluteStoredPath(row.filePath), 'utf8') : null,
        })),
        coverExists: fs.existsSync(coverPath),
        conflictExists: fs.existsSync(conflictPath),
        conflictContent: fs.existsSync(conflictPath) ? fs.readFileSync(conflictPath, 'utf8') : null,
      }));
      db.close();
    })().catch((error) => { console.error(error); db.close(); process.exitCode = 1; });
  `;
}

test('modifica atomicamente tutti i file dell’album preservando UUID e relazioni applicative', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-music-album-edit-'));
  const result = runScript(root, albumEditScript(root));
  assert.equal(result.status, 0, result.stderr);
  const payload = lastJson(result.stdout);

  assert.equal(payload.failure, null);
  assert.equal(payload.result.albumId, payload.first.albumUuid);
  assert.equal(payload.result.kind, 'music-album');
  assert.equal(payload.result.trackCount, 2);
  assert.equal(payload.result.destinationChanged, true);
  assert.equal(payload.album.albumUuid, payload.first.albumUuid);
  assert.equal(payload.album.title, 'New Album');
  assert.deepEqual(JSON.parse(payload.album.artistsJson), ['New Album Artist']);
  assert.deepEqual(JSON.parse(payload.album.genresJson), ['Metal']);
  assert.equal(payload.album.year, 2026);
  assert.equal(payload.album.coverPath, null);
  assert.deepEqual(payload.rows.map((row) => row.trackUuid), [payload.first.trackUuid, payload.second.trackUuid]);
  assert.deepEqual(payload.rows.map((row) => row.title), ['Alpha', 'Beta']);
  assert.deepEqual(payload.rows.map((row) => row.fileName), ['01 Alpha.mp3', '02 Beta.mp3']);
  assert.deepEqual(payload.trackArtists, [['Track Artist A'], ['Track Artist B']]);
  assert.deepEqual(payload.counts, { favorites: 1, history: 1, playlists: 1, albums: 1 });
  assert.ok(payload.originalRows.every((row) => row.exists === false));
  assert.ok(payload.current.every((row) => row.exists === true && row.content.startsWith('edited-track-')));
  assert.equal(payload.coverExists, false);
  assert.equal(payload.reread.current.album, 'New Album');
  assert.equal(payload.reread.tracks.length, 2);
  assert.equal('filePath' in payload.result, false);
  assert.equal('directoryPath' in payload.result, false);

  fs.rmSync(root, { recursive: true, force: true });
});

test('un errore SQLite ripristina tutti i file e lascia invariato il catalogo dell’album', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-music-album-rollback-'));
  const result = runScript(root, albumEditScript(root, { forceFailure: true }));
  assert.equal(result.status, 0, result.stderr);
  const payload = lastJson(result.stdout);

  assert.equal(payload.result, null);
  assert.equal(payload.failure.code, 'MUSIC_ALBUM_METADATA_UPDATE_FAILED');
  assert.equal(payload.failure.contentPreserved, true);
  assert.equal(payload.album.title, 'Old Album');
  assert.deepEqual(JSON.parse(payload.album.artistsJson), ['Old Album Artist']);
  assert.ok(payload.originalRows.every((row) => row.exists === true));
  assert.deepEqual(payload.current.map((row) => row.content), ['track-one', 'track-two']);
  assert.deepEqual(payload.counts, { favorites: 1, history: 1, playlists: 1, albums: 1 });
  assert.equal(payload.coverExists, true);

  fs.rmSync(root, { recursive: true, force: true });
});

test('un file esterno già presente nella destinazione blocca l’intero album senza modifiche parziali', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-music-album-conflict-'));
  const result = runScript(root, albumEditScript(root, { conflict: true }));
  assert.equal(result.status, 0, result.stderr);
  const payload = lastJson(result.stdout);

  assert.equal(payload.result, null);
  assert.equal(payload.failure.code, 'MUSIC_ALBUM_METADATA_DESTINATION_EXISTS');
  assert.equal(payload.album.title, 'Old Album');
  assert.ok(payload.originalRows.every((row) => row.exists === true));
  assert.equal(payload.conflictExists, true);
  assert.equal(payload.conflictContent, 'external-file');
  assert.equal(payload.coverExists, true);

  fs.rmSync(root, { recursive: true, force: true });
});
