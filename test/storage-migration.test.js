'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const projectRoot = path.resolve(__dirname, '..');
const migrationScript = path.join(projectRoot, 'scripts', 'storage-migrate.js');

function createEnvironment(root, libraryPath, databasePath, backupsPath) {
  return {
    ...process.env,
    LIBRARY_PATH: libraryPath,
    DATABASE_PATH: databasePath,
    DATABASE_BACKUPS_PATH: backupsPath,
    METADATA_POSTER_CACHE_PATH: path.join(root, 'poster-cache'),
    MUSIC_COVER_CACHE_PATH: path.join(root, 'music-cover-cache'),
    METADATA_POSTERS_PATH: path.join(root, 'legacy-posters'),
    UPLOAD_TEMP_PATH: path.join(libraryPath, '.uploads'),
  };
}

function runMigration(args, env) {
  return spawnSync(process.execPath, [migrationScript, ...args], {
    cwd: projectRoot,
    env,
    encoding: 'utf8',
  });
}

function fileHash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function createLegacySchema(databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`
    CREATE TABLE movies (
      id INTEGER PRIMARY KEY,
      file_path TEXT,
      relative_path TEXT,
      media_type TEXT,
      metadata_path TEXT,
      poster_path TEXT,
      metadata_auto_json TEXT
    );
    CREATE TABLE series (
      id INTEGER PRIMARY KEY,
      directory_path TEXT,
      relative_path TEXT,
      metadata_path TEXT,
      poster_path TEXT
    );
    CREATE TABLE reading_items (
      id INTEGER PRIMARY KEY,
      category TEXT,
      file_path TEXT,
      relative_path TEXT,
      metadata_path TEXT,
      cover_path TEXT
    );
    CREATE TABLE music_albums (
      id INTEGER PRIMARY KEY,
      directory_path TEXT,
      relative_path TEXT,
      cover_cache_path TEXT
    );
    CREATE TABLE music_tracks (
      id INTEGER PRIMARY KEY,
      file_path TEXT,
      relative_path TEXT
    );
    CREATE TABLE media_metadata_overrides (
      movie_id INTEGER PRIMARY KEY,
      poster_path TEXT
    );
    CREATE TABLE user_state (
      state_key TEXT PRIMARY KEY,
      state_value TEXT NOT NULL
    );
    INSERT INTO user_state VALUES ('preserve', 'unchanged');
    PRAGMA user_version = 10;
  `);
  return db;
}

function createFile(libraryPath, relativePath, content = 'NEW') {
  const candidate = path.join(libraryPath, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(candidate), { recursive: true });
  fs.writeFileSync(candidate, content);
}

function seedPortableMigrationFixture(root) {
  const libraryPath = path.join(root, 'new', 'media');
  const databasePath = path.join(root, 'data', 'media.sqlite');
  const backupsPath = path.join(root, 'backups');
  fs.mkdirSync(libraryPath, { recursive: true });

  const movie = 'Film/Ratatouille (2007)/Ratatouille.mp4';
  const episode = 'Serie/Arcane/Stagione 1/Arcane x 1 x 1.mkv';
  const series = 'Serie/Arcane';
  const reading = 'Libri/Frank Herbert/Dune/Dune.epub';
  const album = 'Musica/Black Sabbath/Paranoid';
  const track = `${album}/01 War Pigs.flac`;
  createFile(libraryPath, movie);
  createFile(libraryPath, episode);
  createFile(libraryPath, reading);
  createFile(libraryPath, track);
  fs.mkdirSync(path.join(libraryPath, ...series.split('/')), { recursive: true });

  const winRoot = 'C:\\VecchioPC\\baia\\media';
  const absolute = (relative) => `${winRoot}\\${relative.replaceAll('/', '\\')}`;
  const db = createLegacySchema(databasePath);
  db.prepare(`
    INSERT INTO movies VALUES (1, ?, ?, 'movie', ?, ?, ?)
  `).run(
    absolute(movie),
    absolute(movie),
    absolute('Film/Ratatouille (2007)/metadata.json'),
    absolute('Film/Ratatouille (2007)/poster.jpg'),
    JSON.stringify({ automatic: { posterPath: absolute('Film/Ratatouille (2007)/poster.jpg') } }),
  );
  db.prepare(`
    INSERT INTO movies VALUES (2, ?, ?, 'series', ?, NULL, NULL)
  `).run(
    absolute(episode),
    absolute(episode),
    absolute('Serie/Arcane/Stagione 1/Arcane x 1 x 1.metadata.json'),
  );
  db.prepare('INSERT INTO media_metadata_overrides VALUES (1, ?)').run(
    'D:\\cache-legacy\\ratatouille-custom.jpg',
  );
  db.prepare('INSERT INTO series VALUES (1, ?, ?, ?, ?)').run(
    absolute(series),
    absolute(series),
    absolute('Serie/Arcane/metadata.json'),
    absolute('Serie/Arcane/poster.webp'),
  );
  db.prepare('INSERT INTO reading_items VALUES (1, ?, ?, ?, ?, ?)').run(
    'books',
    absolute(reading),
    absolute(reading),
    absolute('Libri/Frank Herbert/Dune/metadata.json'),
    absolute('Libri/Frank Herbert/Dune/cover.jpg'),
  );
  db.prepare('INSERT INTO music_albums VALUES (1, ?, ?, ?)').run(
    absolute(album),
    absolute(album),
    'C:\\VecchioPC\\baia\\data\\cache\\music-covers\\album-1.jpg',
  );
  db.prepare('INSERT INTO music_tracks VALUES (1, ?, ?)').run(
    absolute(track),
    absolute(track),
  );
  db.close();

  return {
    libraryPath,
    databasePath,
    backupsPath,
    env: createEnvironment(root, libraryPath, databasePath, backupsPath),
    expected: { movie, episode, series, reading, album, track },
  };
}

test('storage:migrate --dry-run analizza senza modificare SQLite', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-storage-dry-run-'));
  const fixture = seedPortableMigrationFixture(root);
  const beforeHash = fileHash(fixture.databasePath);
  const beforeStats = fs.statSync(fixture.databasePath);

  const result = runMigration(['--dry-run', '--json'], fixture.env);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);

  assert.equal(report.canApply, true);
  assert.equal(report.summary.errors, 0);
  assert.equal(report.summary.records, 6);
  assert.equal(report.summary.migratable, 6);
  assert.equal(report.summary.missing, 0);
  assert.equal(report.cacheEntriesInvalidated, 1);
  assert.ok(report.legacyAbsolutePaths >= 10);
  assert.equal(fileHash(fixture.databasePath), beforeHash);
  assert.equal(fs.statSync(fixture.databasePath).mtimeMs, beforeStats.mtimeMs);
  assert.equal(fs.existsSync(fixture.backupsPath), false);

  fs.rmSync(root, { recursive: true, force: true });
});

test('storage:migrate --apply crea un backup e converte tutti i percorsi in modo atomico', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-storage-apply-'));
  const fixture = seedPortableMigrationFixture(root);

  const result = runMigration(['--apply', '--json'], fixture.env);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.applied, true);
  assert.ok(report.appliedChanges >= 6);
  assert.equal(report.cacheEntriesInvalidated, 1);
  assert.equal(report.postMigration.summary.changes, 0);
  assert.ok(report.backupPath);
  assert.equal(fs.existsSync(report.backupPath), true);

  const db = new DatabaseSync(fixture.databasePath, { readOnly: true });
  const movie = db.prepare('SELECT * FROM movies WHERE id = 1').get();
  const episode = db.prepare('SELECT * FROM movies WHERE id = 2').get();
  const series = db.prepare('SELECT * FROM series WHERE id = 1').get();
  const reading = db.prepare('SELECT * FROM reading_items WHERE id = 1').get();
  const album = db.prepare('SELECT * FROM music_albums WHERE id = 1').get();
  const track = db.prepare('SELECT * FROM music_tracks WHERE id = 1').get();
  const override = db.prepare('SELECT * FROM media_metadata_overrides WHERE movie_id = 1').get();
  const state = db.prepare("SELECT state_value FROM user_state WHERE state_key = 'preserve'").get();
  const schemaVersion = Number(db.prepare('PRAGMA user_version').get().user_version);
  db.close();

  assert.deepEqual([movie.file_path, movie.relative_path], [fixture.expected.movie, fixture.expected.movie]);
  assert.equal(movie.metadata_path, 'Film/Ratatouille (2007)/metadata.json');
  assert.equal(movie.poster_path, 'Film/Ratatouille (2007)/poster.jpg');
  assert.equal(JSON.parse(movie.metadata_auto_json).automatic.posterPath, 'Film/Ratatouille (2007)/poster.jpg');
  assert.deepEqual([episode.file_path, episode.relative_path], [fixture.expected.episode, fixture.expected.episode]);
  assert.equal(episode.metadata_path, 'Serie/Arcane/Stagione 1/Arcane x 1 x 1.metadata.json');
  assert.deepEqual([series.directory_path, series.relative_path], [fixture.expected.series, fixture.expected.series]);
  assert.equal(series.metadata_path, 'Serie/Arcane/metadata.json');
  assert.equal(series.poster_path, 'Serie/Arcane/poster.webp');
  assert.deepEqual([reading.file_path, reading.relative_path], [fixture.expected.reading, fixture.expected.reading]);
  assert.equal(reading.metadata_path, 'Libri/Frank Herbert/Dune/metadata.json');
  assert.equal(reading.cover_path, 'Libri/Frank Herbert/Dune/cover.jpg');
  assert.deepEqual([album.directory_path, album.relative_path], [fixture.expected.album, fixture.expected.album]);
  assert.equal(album.cover_cache_path, null);
  assert.deepEqual([track.file_path, track.relative_path], [fixture.expected.track, fixture.expected.track]);
  assert.equal(override.poster_path, 'Film/Ratatouille (2007)/ratatouille-custom.jpg');
  assert.equal(state.state_value, 'unchanged');
  assert.equal(schemaVersion, 10, 'lo strumento non deve falsificare la versione dello schema');

  const backup = new DatabaseSync(report.backupPath, { readOnly: true });
  const backupMovie = backup.prepare('SELECT file_path FROM movies WHERE id = 1').get();
  backup.close();
  assert.match(backupMovie.file_path, /^[A-Z]:\\/i);

  const secondRun = runMigration(['--dry-run', '--json'], fixture.env);
  assert.equal(secondRun.status, 0, secondRun.stderr || secondRun.stdout);
  const secondReport = JSON.parse(secondRun.stdout);
  assert.equal(secondReport.summary.changes, 0);
  assert.equal(secondReport.summary.migratable, 0);
  assert.equal(secondReport.summary.alreadyPortable, 6);

  fs.rmSync(root, { recursive: true, force: true });
});

test('collisioni e percorsi non ricostruibili bloccano --apply senza creare backup', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-storage-blocked-'));
  const libraryPath = path.join(root, 'media');
  const databasePath = path.join(root, 'data', 'media.sqlite');
  const backupsPath = path.join(root, 'backups');
  fs.mkdirSync(path.join(libraryPath, 'Musica', 'Artist', 'Album'), { recursive: true });
  const db = createLegacySchema(databasePath);
  db.prepare('INSERT INTO music_tracks VALUES (1, ?, ?)').run(
    'C:\\old-a\\media\\Musica\\Artist\\Album\\01 Song.mp3',
    'C:\\old-a\\media\\Musica\\Artist\\Album\\01 Song.mp3',
  );
  db.prepare('INSERT INTO music_tracks VALUES (2, ?, ?)').run(
    'D:\\old-b\\media\\Musica\\Artist\\Album\\01 Song.mp3',
    'D:\\old-b\\media\\Musica\\Artist\\Album\\01 Song.mp3',
  );
  db.prepare("INSERT INTO movies VALUES (1, '/outside/unmanaged/video.mp4', '/outside/unmanaged/video.mp4', 'movie', NULL, NULL, NULL)").run();
  db.close();
  const env = createEnvironment(root, libraryPath, databasePath, backupsPath);
  const beforeHash = fileHash(databasePath);

  const dryRun = runMigration(['--dry-run', '--json'], env);
  assert.equal(dryRun.status, 2, dryRun.stderr || dryRun.stdout);
  const dryReport = JSON.parse(dryRun.stdout);
  assert.equal(dryReport.canApply, false);
  assert.ok(dryReport.summary.errors >= 2);
  assert.equal(dryReport.collisions.length, 1);

  const apply = runMigration(['--apply', '--json'], env);
  assert.equal(apply.status, 1, apply.stderr || apply.stdout);
  assert.equal(fileHash(databasePath), beforeHash);
  assert.equal(fs.existsSync(backupsPath), false);

  fs.rmSync(root, { recursive: true, force: true });
});
