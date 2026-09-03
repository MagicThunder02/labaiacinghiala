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

test('verifica libreria include i brani musicali già indicizzati senza scandire file sconosciuti', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-music-reconcile-'));
  const albumDirectory = path.join(root, 'media', 'Musica', 'Artist', 'Album');
  const existingTrack = path.join(albumDirectory, '01 Existing.mp3');
  const missingTrack = path.join(albumDirectory, '02 Missing.mp3');
  fs.mkdirSync(albumDirectory, { recursive: true });
  fs.writeFileSync(existingTrack, 'existing-track');

  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const db = require('./src/database');
    const { reconcileLibraryAvailability } = require('./src/services/library-reconciliation-service');

    const artistId = Number(db.prepare('INSERT INTO music_artists (artist_uuid, name) VALUES (?, ?)').run('artist', 'Artist').lastInsertRowid);
    const albumId = Number(db.prepare(\`INSERT INTO music_albums (
      album_uuid, title, directory_path, relative_path, album_artists_json
    ) VALUES (?, ?, ?, ?, ?)\`).run(
      'album', 'Album', ${JSON.stringify(albumDirectory)}, path.join('Musica', 'Artist', 'Album'), JSON.stringify(['Artist'])
    ).lastInsertRowid);
    db.prepare('INSERT INTO music_album_artists (album_id, artist_id, position) VALUES (?, ?, 0)').run(albumId, artistId);

    const insertTrack = db.prepare(\`INSERT INTO music_tracks (
      track_uuid, album_id, file_path, relative_path, file_name, title,
      artists_json, extension, mime_type, size_bytes, modified_at, available
    ) VALUES (?, ?, ?, ?, ?, ?, ?, '.mp3', 'audio/mpeg', ?, ?, ?)\`);
    const existingStats = fs.statSync(${JSON.stringify(existingTrack)});
    insertTrack.run(
      'existing', albumId, ${JSON.stringify(existingTrack)},
      path.join('Musica', 'Artist', 'Album', '01 Existing.mp3'),
      '01 Existing.mp3', 'Existing', JSON.stringify(['Artist']),
      1, 1, 0
    );
    insertTrack.run(
      'missing', albumId, ${JSON.stringify(missingTrack)},
      path.join('Musica', 'Artist', 'Album', '02 Missing.mp3'),
      '02 Missing.mp3', 'Missing', JSON.stringify(['Artist']),
      999, 999, 1
    );

    reconcileLibraryAvailability().then((result) => {
      const rows = db.prepare('SELECT track_uuid AS uuid, available, size_bytes AS sizeBytes, missing_since AS missingSince FROM music_tracks ORDER BY track_uuid').all();
      console.log(JSON.stringify({ result, rows, actualSize: existingStats.size }));
      db.close();
    }).catch((error) => {
      console.error(error);
      db.close();
      process.exitCode = 1;
    });
  `;

  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: createEnvironment(root),
  });

  assert.equal(result.status, 0, result.stderr);
  const output = result.stdout.trim().split(/\r?\n/).at(-1);
  const payload = JSON.parse(output);
  assert.equal(payload.result.storageAvailable, true);
  assert.equal(payload.result.checked, 2);
  assert.equal(payload.result.available, 1);
  assert.equal(payload.result.unavailable, 1);
  assert.equal(payload.result.restored, 1);
  assert.deepEqual(payload.rows.map((row) => ({ uuid: row.uuid, available: row.available })), [
    { uuid: 'existing', available: 1 },
    { uuid: 'missing', available: 0 },
  ]);
  assert.equal(payload.rows[0].sizeBytes, payload.actualSize);
  assert.ok(payload.rows[1].missingSince);
  fs.rmSync(root, { recursive: true, force: true });
});
