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

test('importa i brani in Artista/Album/NN Titolo e riusa album e artisti', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-music-import-'));
  const uploads = path.join(root, 'media', '.uploads');
  const firstSource = path.join(uploads, 'first.mp3');
  const secondSource = path.join(uploads, 'second.flac');
  fs.mkdirSync(uploads, { recursive: true });
  fs.writeFileSync(firstSource, 'first');
  fs.writeFileSync(secondSource, 'second');

  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const db = require('./src/database');
    const { inspectMusicUpload, importMusicUpload } = require('./src/services/music-import-service');
    const metadata = (filePath) => {
      const second = path.extname(filePath) === '.flac';
      return Promise.resolve({
        fileName: path.basename(filePath),
        extension: path.extname(filePath),
        format: second ? 'flac' : 'mp3',
        hasCoverArt: !second,
        tags: {
          title: second ? 'Paranoid' : 'Iron Man',
          artists: ['Black Sabbath'],
          album: 'Paranoid',
          albumArtists: [],
          genres: ['Heavy Metal'],
          composers: ['Tony Iommi'],
          comment: '', date: '1970', year: 1970,
          trackNumber: second ? 2 : 1, trackTotal: 8,
          discNumber: 1, discTotal: 1, compilation: false,
        },
        properties: {
          durationSeconds: second ? 168 : 355,
          durationMs: second ? 168000 : 355000,
          bitrateKbps: 320, sampleRateHz: 44100, channels: 2,
          bitsPerSample: second ? 24 : null, codec: second ? 'FLAC' : 'MPEG Audio',
          containerFormat: second ? 'FLAC' : 'MPEG', isLossless: second,
          bitrateMode: second ? null : 'CBR',
        },
      });
    };
    (async () => {
      const preview = await inspectMusicUpload(${JSON.stringify(firstSource)}, { metadataReader: metadata });
      const first = await importMusicUpload(${JSON.stringify(firstSource)}, { metadataReader: metadata });
      const second = await importMusicUpload(${JSON.stringify(secondSource)}, { metadataReader: metadata });
      const counts = {
        artists: Number(db.prepare('SELECT COUNT(*) AS count FROM music_artists').get().count),
        albums: Number(db.prepare('SELECT COUNT(*) AS count FROM music_albums').get().count),
        tracks: Number(db.prepare('SELECT COUNT(*) AS count FROM music_tracks').get().count),
        albumArtists: Number(db.prepare('SELECT COUNT(*) AS count FROM music_album_artists').get().count),
        trackArtists: Number(db.prepare('SELECT COUNT(*) AS count FROM music_track_artists').get().count),
      };
      const rows = db.prepare('SELECT file_name AS fileName, relative_path AS relativePath, extension FROM music_tracks ORDER BY track_number').all();
      console.log(JSON.stringify({ preview, first, second, counts, rows, files: rows.map((row) => fs.existsSync(path.join(${JSON.stringify(path.join(root, 'media'))}, row.relativePath))) }));
      db.close();
    })().catch((error) => { console.error(error); db.close(); process.exitCode = 1; });
  `;

  const result = runScript(root, script);
  assert.equal(result.status, 0, result.stderr);
  const payload = lastJson(result.stdout);
  assert.equal(payload.preview.proposedRelativePath, 'Musica/Black Sabbath/Paranoid/01 Iron Man.mp3');
  assert.equal(payload.first.relativePath, payload.preview.proposedRelativePath);
  assert.equal(payload.second.relativePath, 'Musica/Black Sabbath/Paranoid/02 Paranoid.flac');
  assert.deepEqual(payload.counts, { artists: 1, albums: 1, tracks: 2, albumArtists: 1, trackArtists: 2 });
  assert.deepEqual(payload.files, [true, true]);
  assert.equal('filePath' in payload.first, false);
  assert.equal(fs.existsSync(firstSource), false);
  assert.equal(fs.existsSync(secondSource), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('un conflitto di nome non sovrascrive il brano esistente e conserva il nuovo upload', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-music-collision-'));
  const uploads = path.join(root, 'media', '.uploads');
  const firstSource = path.join(uploads, 'first.mp3');
  const secondSource = path.join(uploads, 'second.mp3');
  fs.mkdirSync(uploads, { recursive: true });
  fs.writeFileSync(firstSource, 'first');
  fs.writeFileSync(secondSource, 'second');

  const script = `
    const fs = require('node:fs');
    const db = require('./src/database');
    const { importMusicUpload } = require('./src/services/music-import-service');
    const metadataReader = async (filePath) => ({
      fileName: require('node:path').basename(filePath), extension: '.mp3', format: 'mp3', hasCoverArt: false,
      tags: { title: 'Iron Man', artists: ['Black Sabbath'], album: 'Paranoid', albumArtists: ['Black Sabbath'], genres: [], composers: [], trackNumber: 1, compilation: false },
      properties: {},
    });
    (async () => {
      const first = await importMusicUpload(${JSON.stringify(firstSource)}, { metadataReader });
      let failure;
      try { await importMusicUpload(${JSON.stringify(secondSource)}, { metadataReader }); }
      catch (error) { failure = { code: error.code, statusCode: error.statusCode, message: error.message }; }
      console.log(JSON.stringify({ first, failure, sourcePreserved: fs.existsSync(${JSON.stringify(secondSource)}), tracks: Number(db.prepare('SELECT COUNT(*) AS count FROM music_tracks').get().count) }));
      db.close();
    })().catch((error) => { console.error(error); db.close(); process.exitCode = 1; });
  `;

  const result = runScript(root, script);
  assert.equal(result.status, 0, result.stderr);
  const payload = lastJson(result.stdout);
  assert.equal(payload.failure.code, 'MUSIC_IMPORT_DESTINATION_EXISTS');
  assert.equal(payload.failure.statusCode, 409);
  assert.equal(payload.sourcePreserved, true);
  assert.equal(payload.tracks, 1);
  fs.rmSync(root, { recursive: true, force: true });
});


test('reimportare un file cancellato ripristina il record esistente senza perdere preferiti e cronologia', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-music-restore-'));
  const library = path.join(root, 'media');
  const uploads = path.join(library, '.uploads');
  const firstSource = path.join(uploads, 'first.mp3');
  const replacementSource = path.join(uploads, 'replacement.mp3');
  fs.mkdirSync(uploads, { recursive: true });
  fs.writeFileSync(firstSource, 'first');
  fs.writeFileSync(replacementSource, 'replacement');

  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const db = require('./src/database');
    const { importMusicUpload } = require('./src/services/music-import-service');
    const metadataReader = async (filePath) => ({
      fileName: path.basename(filePath), extension: '.mp3', format: 'mp3', hasCoverArt: false,
      tags: {
        title: 'Iron Man',
        artists: [path.basename(filePath) === 'first.mp3' ? 'Original Artist' : 'Updated Artist'],
        album: 'Paranoid', albumArtists: ['Black Sabbath'], genres: ['Heavy Metal'], composers: [],
        trackNumber: 1, trackTotal: 8, compilation: false,
      },
      properties: { durationSeconds: 355, durationMs: 355000 },
    });
    (async () => {
      const first = await importMusicUpload(${JSON.stringify(firstSource)}, { metadataReader });
      const destination = path.join(${JSON.stringify(library)}, first.relativePath);
      db.prepare('INSERT INTO music_track_favorites (track_id, profile_key) VALUES (?, ?)').run(first.id, 'default');
      db.prepare('INSERT INTO music_listening_history (track_id, profile_key, play_count) VALUES (?, ?, ?)').run(first.id, 'default', 3);
      fs.unlinkSync(destination);
      db.prepare("UPDATE music_tracks SET available = 0, missing_since = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(first.id);

      const restored = await importMusicUpload(${JSON.stringify(replacementSource)}, { metadataReader });
      const row = db.prepare('SELECT id, track_uuid AS trackUuid, available, missing_since AS missingSince, artists_json AS artistsJson, size_bytes AS sizeBytes FROM music_tracks WHERE id = ?').get(first.id);
      const trackArtist = db.prepare('SELECT a.name FROM music_track_artists ta JOIN music_artists a ON a.id = ta.artist_id WHERE ta.track_id = ?').get(first.id);
      const counts = {
        tracks: Number(db.prepare('SELECT COUNT(*) AS count FROM music_tracks').get().count),
        favorites: Number(db.prepare('SELECT COUNT(*) AS count FROM music_track_favorites WHERE track_id = ?').get(first.id).count),
        history: Number(db.prepare('SELECT COUNT(*) AS count FROM music_listening_history WHERE track_id = ?').get(first.id).count),
      };
      console.log(JSON.stringify({
        first, restored, row, trackArtist, counts,
        destinationContent: fs.readFileSync(destination, 'utf8'),
        replacementConsumed: !fs.existsSync(${JSON.stringify(replacementSource)}),
      }));
      db.close();
    })().catch((error) => { console.error(error); db.close(); process.exitCode = 1; });
  `;

  const result = runScript(root, script);
  assert.equal(result.status, 0, result.stderr);
  const payload = lastJson(result.stdout);
  assert.equal(payload.restored.id, payload.first.id);
  assert.equal(payload.restored.trackUuid, payload.first.trackUuid);
  assert.equal(payload.restored.restoredExisting, true);
  assert.equal(payload.row.available, 1);
  assert.equal(payload.row.missingSince, null);
  assert.deepEqual(JSON.parse(payload.row.artistsJson), ['Updated Artist']);
  assert.equal(payload.trackArtist.name, 'Updated Artist');
  assert.deepEqual(payload.counts, { tracks: 1, favorites: 1, history: 1 });
  assert.equal(payload.destinationContent, 'replacement');
  assert.equal(payload.replacementConsumed, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('rifiuta tag obbligatori mancanti e file esterni alla cartella upload', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-music-invalid-'));
  const uploads = path.join(root, 'media', '.uploads');
  const source = path.join(uploads, 'missing.mp3');
  const outside = path.join(root, 'outside.mp3');
  fs.mkdirSync(uploads, { recursive: true });
  fs.writeFileSync(source, 'source');
  fs.writeFileSync(outside, 'outside');

  const script = `
    const fs = require('node:fs');
    const db = require('./src/database');
    const { importMusicUpload } = require('./src/services/music-import-service');
    const incompleteReader = async () => ({ extension: '.mp3', format: 'mp3', hasCoverArt: false, tags: { title: 'Senza numero', artists: ['Artista'], album: 'Album', albumArtists: [] }, properties: {} });
    (async () => {
      const failures = [];
      for (const candidate of [${JSON.stringify(source)}, ${JSON.stringify(outside)}]) {
        try { await importMusicUpload(candidate, { metadataReader: incompleteReader }); }
        catch (error) { failures.push({ code: error.code, statusCode: error.statusCode }); }
      }
      console.log(JSON.stringify({ failures, sourcePreserved: fs.existsSync(${JSON.stringify(source)}), outsidePreserved: fs.existsSync(${JSON.stringify(outside)}), tracks: Number(db.prepare('SELECT COUNT(*) AS count FROM music_tracks').get().count) }));
      db.close();
    })().catch((error) => { console.error(error); db.close(); process.exitCode = 1; });
  `;

  const result = runScript(root, script);
  assert.equal(result.status, 0, result.stderr);
  const payload = lastJson(result.stdout);
  assert.deepEqual(payload.failures, [
    { code: 'MUSIC_IMPORT_TAGS_INCOMPLETE', statusCode: 422 },
    { code: 'MUSIC_IMPORT_SOURCE_OUTSIDE_UPLOADS', statusCode: 400 },
  ]);
  assert.equal(payload.sourcePreserved, true);
  assert.equal(payload.outsidePreserved, true);
  assert.equal(payload.tracks, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('un errore SQLite dopo lo spostamento ripristina il file temporaneo', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-music-rollback-'));
  const uploads = path.join(root, 'media', '.uploads');
  const source = path.join(uploads, 'track.mp3');
  fs.mkdirSync(uploads, { recursive: true });
  fs.writeFileSync(source, 'track');

  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const crypto = require('node:crypto');
    const db = require('./src/database');
    const config = require('./src/config');
    const { importMusicUpload } = require('./src/services/music-import-service');
    const albumDirectory = path.join(config.mediaPaths.music, 'A - B', 'Album');
    fs.mkdirSync(albumDirectory, { recursive: true });
    db.prepare('INSERT INTO music_albums (album_uuid, title, directory_path, relative_path, album_artists_json) VALUES (?, ?, ?, ?, ?)').run(
      crypto.randomUUID(), 'Titolo differente', albumDirectory, path.relative(config.libraryPath, albumDirectory).split(path.sep).join('/'), JSON.stringify(['A:B'])
    );
    fs.rmdirSync(albumDirectory);
    const metadataReader = async () => ({
      extension: '.mp3', format: 'mp3', hasCoverArt: false,
      tags: { title: 'Brano', artists: ['A:B'], album: 'Album', albumArtists: ['A:B'], genres: [], composers: [], trackNumber: 1, compilation: false }, properties: {},
    });
    (async () => {
      let failure;
      try { await importMusicUpload(${JSON.stringify(source)}, { metadataReader }); }
      catch (error) { failure = { code: error.code, statusCode: error.statusCode, contentPreserved: error.contentPreserved }; }
      const destination = path.join(config.mediaPaths.music, 'A - B', 'Album', '01 Brano.mp3');
      console.log(JSON.stringify({ failure, sourceRestored: fs.existsSync(${JSON.stringify(source)}), destinationExists: fs.existsSync(destination), tracks: Number(db.prepare('SELECT COUNT(*) AS count FROM music_tracks').get().count) }));
      db.close();
    })().catch((error) => { console.error(error); db.close(); process.exitCode = 1; });
  `;

  const result = runScript(root, script);
  assert.equal(result.status, 0, result.stderr);
  const payload = lastJson(result.stdout);
  assert.equal(payload.failure.code, 'MUSIC_IMPORT_ALBUM_COLLISION');
  assert.equal(payload.failure.statusCode, 409);
  assert.equal(payload.failure.contentPreserved, false);
  assert.equal(payload.sourceRestored, true);
  assert.equal(payload.destinationExists, false);
  assert.equal(payload.tracks, 0);
  fs.rmSync(root, { recursive: true, force: true });
});
