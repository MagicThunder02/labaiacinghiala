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

function seedAndEditScript(root, options = {}) {
  const library = path.join(root, 'media');
  const uploads = path.join(library, '.uploads');
  const source = path.join(uploads, 'track.mp3');
  const forceFailure = options.forceFailure === true;
  const destinationConflict = options.destinationConflict === true;
  fs.mkdirSync(uploads, { recursive: true });
  fs.writeFileSync(source, 'original-audio');

  return `
    const crypto = require('node:crypto');
    const fs = require('node:fs');
    const path = require('node:path');
    const db = require('./src/database');
    const config = require('./src/config');
    const absoluteStoredPath = (stored) => path.resolve(config.libraryPath, String(stored || ''));
    const { importMusicUpload } = require('./src/services/music-import-service');
    const {
      getMusicTrackEmbeddedMetadata,
      updateMusicTrackEmbeddedMetadata,
    } = require('./src/services/music-metadata-edit-service');

    const initialMetadata = {
      fileName: 'track.mp3', extension: '.mp3', format: 'mp3', hasCoverArt: true,
      pictures: [{ type: 'FrontCover', mimeType: 'image/png', description: '', size: 10 }],
      tags: {
        title: 'Old Title', artists: ['Old Track Artist'], album: 'Old Album',
        albumArtists: ['Old Album Artist'], genres: ['Rock'], composers: ['Composer'],
        comment: 'Old comment', date: '2001', year: 2001,
        trackNumber: 1, trackTotal: 10, discNumber: 1, discTotal: 1, compilation: false,
      },
      properties: {
        durationSeconds: 180, durationMs: 180000, bitrateKbps: 320,
        sampleRateHz: 44100, channels: 2, bitsPerSample: null,
        codec: 'MPEG Audio', containerFormat: 'MPEG', isLossless: false, bitrateMode: 'CBR',
      },
    };
    const editedMetadata = {
      fileName: 'track.mp3', extension: '.mp3', format: 'mp3', hasCoverArt: true,
      pictures: [{ type: 'FrontCover', mimeType: 'image/png', description: '', size: 10 }],
      tags: {
        title: 'New Title', artists: ['New Track Artist'], album: 'New Album',
        albumArtists: ['New Album Artist'], genres: ['Metal'], composers: ['New Composer'],
        comment: 'New comment', date: '2026', year: 2026,
        trackNumber: 7, trackTotal: 12, discNumber: 2, discTotal: 2, compilation: false,
      },
      properties: {
        durationSeconds: 181, durationMs: 181000, bitrateKbps: 320,
        sampleRateHz: 48000, channels: 2, bitsPerSample: null,
        codec: 'MPEG Audio', containerFormat: 'MPEG', isLossless: false, bitrateMode: 'CBR',
      },
    };

    (async () => {
      const imported = await importMusicUpload(${JSON.stringify(source)}, {
        metadataReader: async () => initialMetadata,
      });
      const oldPath = path.join(config.libraryPath, imported.relativePath);
      const conflictPath = path.join(config.mediaPaths.music, 'New Album Artist', 'New Album', '2-07 New Title.mp3');
      if (${destinationConflict ? 'true' : 'false'}) {
        fs.mkdirSync(path.dirname(conflictPath), { recursive: true });
        fs.writeFileSync(conflictPath, 'existing-audio');
      }
      const oldAlbum = db.prepare('SELECT id, album_uuid AS albumUuid FROM music_albums WHERE album_uuid = ?').get(imported.albumUuid);
      const coverPath = path.join(config.musicCoverCachePath, imported.albumUuid + '.png');
      fs.mkdirSync(config.musicCoverCachePath, { recursive: true });
      fs.writeFileSync(coverPath, 'cover');
      db.prepare('UPDATE music_albums SET cover_cache_path = ? WHERE id = ?').run(coverPath, oldAlbum.id);
      db.prepare('INSERT INTO music_track_favorites (track_id, profile_key) VALUES (?, ?)').run(imported.id, 'default');
      db.prepare('INSERT INTO music_listening_history (track_id, profile_key, play_count) VALUES (?, ?, ?)').run(imported.id, 'default', 4);
      const playlistUuid = crypto.randomUUID();
      const playlistId = Number(db.prepare('INSERT INTO music_playlists (playlist_uuid, profile_key, name) VALUES (?, ?, ?)').run(playlistUuid, 'default', 'Test').lastInsertRowid);
      db.prepare('INSERT INTO music_playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, 0)').run(playlistId, imported.id);

      let failure = null;
      let result = null;
      try {
        result = await updateMusicTrackEmbeddedMetadata(imported.trackUuid, { title: 'New Title' }, {
          metadataUpdater: async (stagedPath) => {
            fs.writeFileSync(stagedPath, 'edited-audio');
            return editedMetadata;
          },
          beforeDatabaseCommit: ${forceFailure ? "() => { throw new Error('forced-db-failure'); }" : 'undefined'},
        });
      } catch (error) {
        failure = { code: error.code, statusCode: error.statusCode, contentPreserved: error.contentPreserved };
      }

      const track = db.prepare(` + "`" + `
        SELECT id, track_uuid AS trackUuid, album_id AS albumId, file_path AS filePath,
               file_name AS fileName, title, artists_json AS artistsJson, available
        FROM music_tracks WHERE id = ?
      ` + "`" + `).get(imported.id);
      const album = db.prepare('SELECT album_uuid AS albumUuid, title, album_artists_json AS artistsJson, cover_cache_path AS coverPath FROM music_albums WHERE id = ?').get(track.albumId);
      const counts = {
        favorites: Number(db.prepare('SELECT COUNT(*) AS count FROM music_track_favorites WHERE track_id = ?').get(imported.id).count),
        history: Number(db.prepare('SELECT COUNT(*) AS count FROM music_listening_history WHERE track_id = ?').get(imported.id).count),
        playlists: Number(db.prepare('SELECT COUNT(*) AS count FROM music_playlist_tracks WHERE track_id = ?').get(imported.id).count),
        albums: Number(db.prepare('SELECT COUNT(*) AS count FROM music_albums').get().count),
      };
      const trackArtists = db.prepare(` + "`" + `
        SELECT a.name FROM music_track_artists ta
        JOIN music_artists a ON a.id = ta.artist_id
        WHERE ta.track_id = ? ORDER BY ta.position
      ` + "`" + `).all(imported.id).map((row) => row.name);
      const actual = result ? await getMusicTrackEmbeddedMetadata(imported.trackUuid, {
        metadataReader: async (candidate) => {
          if (path.resolve(candidate) !== path.resolve(absoluteStoredPath(track.filePath))) throw new Error('wrong-path');
          return editedMetadata;
        },
      }) : null;
      console.log(JSON.stringify({
        imported, result, actual, failure, track, album, counts, trackArtists,
        oldPathExists: fs.existsSync(oldPath),
        currentPathExists: fs.existsSync(absoluteStoredPath(track.filePath)),
        currentContent: fs.existsSync(absoluteStoredPath(track.filePath)) ? fs.readFileSync(absoluteStoredPath(track.filePath), 'utf8') : null,
        oldCoverExists: fs.existsSync(coverPath),
        conflictPathExists: fs.existsSync(conflictPath),
        conflictContent: fs.existsSync(conflictPath) ? fs.readFileSync(conflictPath, 'utf8') : null,
      }));
      db.close();
    })().catch((error) => { console.error(error); db.close(); process.exitCode = 1; });
  `;
}

test('modifica i tag reali, ricolloca il file e conserva UUID, preferiti, cronologia e playlist', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-music-metadata-edit-'));
  const result = runScript(root, seedAndEditScript(root));
  assert.equal(result.status, 0, result.stderr);
  const payload = lastJson(result.stdout);

  assert.equal(payload.failure, null);
  assert.equal(payload.result.trackId, payload.imported.trackUuid);
  assert.equal(payload.track.id, payload.imported.id);
  assert.equal(payload.track.trackUuid, payload.imported.trackUuid);
  assert.equal(payload.track.title, 'New Title');
  assert.deepEqual(JSON.parse(payload.track.artistsJson), ['New Track Artist']);
  assert.equal(payload.album.title, 'New Album');
  assert.deepEqual(JSON.parse(payload.album.artistsJson), ['New Album Artist']);
  assert.deepEqual(payload.trackArtists, ['New Track Artist']);
  assert.deepEqual(payload.counts, { favorites: 1, history: 1, playlists: 1, albums: 1 });
  assert.equal(payload.oldPathExists, false);
  assert.equal(payload.currentPathExists, true);
  assert.equal(payload.currentContent, 'edited-audio');
  assert.equal(payload.oldCoverExists, false);
  assert.equal(payload.album.coverPath, null);
  assert.equal(payload.result.fileName, '2-07 New Title.mp3');
  assert.equal(payload.result.destinationChanged, true);
  assert.equal(payload.actual.current.title, 'New Title');
  assert.equal('filePath' in payload.result, false);
  assert.equal('relativePath' in payload.result, false);

  fs.rmSync(root, { recursive: true, force: true });
});


test('una destinazione fisica già occupata viene rifiutata senza toccare file o catalogo', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-music-metadata-conflict-'));
  const result = runScript(root, seedAndEditScript(root, { destinationConflict: true }));
  assert.equal(result.status, 0, result.stderr);
  const payload = lastJson(result.stdout);

  assert.equal(payload.result, null);
  assert.equal(payload.failure.code, 'MUSIC_METADATA_DESTINATION_EXISTS');
  assert.equal(payload.failure.statusCode, 409);
  assert.equal(payload.track.title, 'Old Title');
  assert.equal(payload.track.fileName, '01 Old Title.mp3');
  assert.equal(payload.oldPathExists, true);
  assert.equal(payload.currentContent, 'original-audio');
  assert.equal(payload.conflictPathExists, true);
  assert.equal(payload.conflictContent, 'existing-audio');
  assert.deepEqual(payload.counts, { favorites: 1, history: 1, playlists: 1, albums: 1 });

  fs.rmSync(root, { recursive: true, force: true });
});

test('un errore SQLite ripristina file e catalogo originali senza perdere relazioni', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-music-metadata-rollback-'));
  const result = runScript(root, seedAndEditScript(root, { forceFailure: true }));
  assert.equal(result.status, 0, result.stderr);
  const payload = lastJson(result.stdout);

  assert.equal(payload.result, null);
  assert.equal(payload.failure.code, 'MUSIC_METADATA_UPDATE_FAILED');
  assert.equal(payload.failure.statusCode, 500);
  assert.equal(payload.failure.contentPreserved, true);
  assert.equal(payload.track.trackUuid, payload.imported.trackUuid);
  assert.equal(payload.track.title, 'Old Title');
  assert.equal(payload.track.fileName, '01 Old Title.mp3');
  assert.equal(payload.oldPathExists, true);
  assert.equal(payload.currentPathExists, true);
  assert.equal(payload.currentContent, 'original-audio');
  assert.equal(payload.oldCoverExists, true);
  assert.deepEqual(payload.counts, { favorites: 1, history: 1, playlists: 1, albums: 1 });

  fs.rmSync(root, { recursive: true, force: true });
});
