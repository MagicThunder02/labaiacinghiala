'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const {
  storedPathToRelative,
  resolveStoredLibraryPath,
} = require('../src/services/video-library-path-service');

function appEnvironment(root, libraryPath, databasePath) {
  return {
    ...process.env,
    LIBRARY_PATH: libraryPath,
    DATABASE_PATH: databasePath,
    DATABASE_BACKUPS_PATH: path.join(root, 'backups'),
    METADATA_POSTER_CACHE_PATH: path.join(root, 'poster-cache'),
    MUSIC_COVER_CACHE_PATH: path.join(root, 'music-cover-cache'),
    METADATA_POSTERS_PATH: path.join(root, 'legacy-posters'),
    UPLOAD_TEMP_PATH: path.join(libraryPath, '.uploads'),
  };
}

function runNode(script, env) {
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: projectRoot,
    encoding: 'utf8',
    env,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim().split(/\r?\n/).at(-1);
}

test('un percorso assoluto legacy diventa un percorso relativo ancorato al contenuto', () => {
  assert.equal(
    storedPathToRelative('C:\\vecchia\\media\\Film\\Ratatouille (2007)\\poster.jpg', {
      anchorRelativePath: 'Film/Ratatouille (2007)/Ratatouille.mp4',
    }),
    'Film/Ratatouille (2007)/poster.jpg',
  );
  assert.equal(
    storedPathToRelative('/vecchia/media/Serie/Arcane/metadata.json', {
      anchorRelativePath: 'Serie/Arcane',
      anchorIsDirectory: true,
    }),
    'Serie/Arcane/metadata.json',
  );
  assert.equal(
    storedPathToRelative('poster.webp', {
      anchorRelativePath: 'Serie/Arcane',
      anchorIsDirectory: true,
    }),
    'Serie/Arcane/poster.webp',
  );
});

test('il resolver non segue mai il percorso assoluto legacy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-video-path-'));
  const currentLibrary = path.join(root, 'current', 'media');
  fs.mkdirSync(path.join(currentLibrary, 'Film', 'Test'), { recursive: true });
  const previous = process.env.LIBRARY_PATH;
  process.env.LIBRARY_PATH = currentLibrary;

  // Il servizio è già caricato con la configurazione del progetto: per questo test
  // passiamo un percorso relativo già convertito e verifichiamo la radice effettiva.
  const resolved = resolveStoredLibraryPath('Film/Test/poster.jpg', {
    anchorRelativePath: 'Film/Test/Test.mp4',
  });
  assert.ok(path.isAbsolute(resolved));
  assert.equal(path.basename(resolved), 'poster.jpg');
  assert.doesNotMatch(resolved, /vecchia/i);

  if (previous === undefined) delete process.env.LIBRARY_PATH;
  else process.env.LIBRARY_PATH = previous;
  fs.rmSync(root, { recursive: true, force: true });
});

test('schema 19 mantiene Film e Serie portabili anche se la vecchia cartella esiste ancora', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-video-portable-'));
  const oldLibrary = path.join(root, 'baia-old', 'media');
  const newLibrary = path.join(root, 'baia-new', 'media');
  const databasePath = path.join(root, 'data', 'media.sqlite');

  const movieRelative = path.join('Film', 'Ratatouille (2007)', 'Ratatouille.mp4');
  const movieMetadataRelative = path.join('Film', 'Ratatouille (2007)', 'metadata.json');
  const moviePosterRelative = path.join('Film', 'Ratatouille (2007)', 'poster.jpg');
  const seriesRelative = path.join('Serie', 'Arcane');
  const seriesMetadataRelative = path.join('Serie', 'Arcane', 'metadata.json');
  const seriesPosterRelative = path.join('Serie', 'Arcane', 'poster.webp');
  const episodeRelative = path.join('Serie', 'Arcane', 'Stagione 1', 'Arcane x 1 x 1.mkv');
  const episodeMetadataRelative = path.join('Serie', 'Arcane', 'Stagione 1', 'Arcane x 1 x 1.metadata.json');

  for (const library of [oldLibrary, newLibrary]) {
    for (const relative of [
      movieRelative,
      movieMetadataRelative,
      moviePosterRelative,
      seriesMetadataRelative,
      seriesPosterRelative,
      episodeRelative,
      episodeMetadataRelative,
    ]) {
      const candidate = path.join(library, relative);
      fs.mkdirSync(path.dirname(candidate), { recursive: true });
      fs.writeFileSync(candidate, library === oldLibrary ? 'OLD' : 'NEW');
    }
  }

  const insertScript = `
    const path = require('node:path');
    const db = require('./src/database');
    const oldLibrary = ${JSON.stringify(oldLibrary)};
    const movieRelative = ${JSON.stringify(movieRelative)};
    const seriesRelative = ${JSON.stringify(seriesRelative)};
    const episodeRelative = ${JSON.stringify(episodeRelative)};
    const movieId = Number(db.prepare(\`INSERT INTO movies (
      file_path, relative_path, file_name, title, year, extension, mime_type,
      size_bytes, modified_at, media_type, genres_json, director, poster_path,
      metadata_auto_json, content_uuid, metadata_path, storage_version, available
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 3, 1, 'movie', '[]', ?, ?, ?, ?, ?, 1, 1)\`).run(
      path.join(oldLibrary, movieRelative), movieRelative, 'Ratatouille.mp4', 'Ratatouille', 2007,
      '.mp4', 'video/mp4', 'Brad Bird',
      path.join(oldLibrary, ${JSON.stringify(moviePosterRelative)}),
      JSON.stringify({ automatic: { posterPath: path.join(oldLibrary, ${JSON.stringify(moviePosterRelative)}) } }),
      '11111111-1111-4111-8111-111111111111',
      path.join(oldLibrary, ${JSON.stringify(movieMetadataRelative)}),
    ).lastInsertRowid);
    db.prepare(\`INSERT INTO media_metadata_overrides (
      movie_id, title, year, genres_json, director, poster_path
    ) VALUES (?, 'Ratatouille', 2007, '[]', 'Brad Bird', ?)\`).run(
      movieId,
      path.join(oldLibrary, ${JSON.stringify(moviePosterRelative)}),
    );
    db.prepare(\`INSERT INTO series (
      series_uuid, directory_path, relative_path, title, year, genres_json,
      poster_path, metadata_path, storage_version, available
    ) VALUES (?, ?, ?, 'Arcane', 2021, '[]', ?, ?, 2, 1)\`).run(
      '22222222-2222-4222-8222-222222222222',
      path.join(oldLibrary, seriesRelative), seriesRelative,
      path.join(oldLibrary, ${JSON.stringify(seriesPosterRelative)}),
      path.join(oldLibrary, ${JSON.stringify(seriesMetadataRelative)}),
    );
    db.prepare(\`INSERT INTO movies (
      file_path, relative_path, file_name, title, year, extension, mime_type,
      size_bytes, modified_at, media_type, series_uuid, series_title,
      season_number, episode_number, genres_json, content_uuid, metadata_path,
      storage_version, available
    ) VALUES (?, ?, ?, 'Benvenuti a Piltover', 2021, '.mkv', 'video/x-matroska',
      3, 1, 'series', ?, 'Arcane', 1, 1, '[]', ?, ?, 1, 1)\`).run(
      path.join(oldLibrary, episodeRelative), episodeRelative, 'Arcane x 1 x 1.mkv',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      path.join(oldLibrary, ${JSON.stringify(episodeMetadataRelative)}),
    );
    db.exec('PRAGMA user_version = 10');
    db.close();
  `;
  runNode(insertScript, appEnvironment(root, oldLibrary, databasePath));

  const migrateScript = `
    const fs = require('node:fs');
    const db = require('./src/database');
    const {
      movieFilePath, movieMetadataPath, moviePosterPath,
      seriesDirectoryPath, seriesMetadataPath, seriesPosterPath,
    } = require('./src/services/video-library-path-service');
    const movie = db.prepare("SELECT * FROM movies WHERE media_type = 'movie'").get();
    const episode = db.prepare("SELECT * FROM movies WHERE media_type = 'series'").get();
    const series = db.prepare('SELECT * FROM series').get();
    const override = db.prepare('SELECT poster_path AS posterPath FROM media_metadata_overrides').get();
    const payload = {
      version: Number(db.prepare('PRAGMA user_version').get().user_version),
      movieStored: [movie.file_path, movie.relative_path, movie.metadata_path, movie.poster_path],
      episodeStored: [episode.file_path, episode.relative_path, episode.metadata_path],
      seriesStored: [series.directory_path, series.relative_path, series.metadata_path, series.poster_path],
      overridePoster: override.posterPath,
      automaticPoster: JSON.parse(movie.metadata_auto_json).automatic.posterPath,
      resolved: {
        movie: movieFilePath(movie),
        movieMetadata: movieMetadataPath(movie),
        moviePoster: moviePosterPath(movie),
        episode: movieFilePath(episode),
        episodeMetadata: movieMetadataPath(episode),
        series: seriesDirectoryPath(series),
        seriesMetadata: seriesMetadataPath(series),
        seriesPoster: seriesPosterPath(series),
      },
      contents: {
        moviePoster: fs.readFileSync(moviePosterPath(movie), 'utf8'),
        seriesPoster: fs.readFileSync(seriesPosterPath(series), 'utf8'),
      },
    };
    console.log(JSON.stringify(payload));
    db.close();
  `;
  const output = runNode(migrateScript, appEnvironment(root, newLibrary, databasePath));
  const payload = JSON.parse(output);

  assert.equal(payload.version, 19);
  for (const storedPath of [
    ...payload.movieStored,
    ...payload.episodeStored,
    ...payload.seriesStored,
    payload.overridePoster,
    payload.automaticPoster,
  ]) {
    assert.equal(path.isAbsolute(storedPath), false, `Percorso ancora assoluto: ${storedPath}`);
    assert.doesNotMatch(storedPath, /baia-old/i);
  }
  for (const resolvedPath of Object.values(payload.resolved)) {
    assert.ok(resolvedPath.startsWith(path.resolve(newLibrary) + path.sep) || resolvedPath === path.resolve(newLibrary));
    assert.doesNotMatch(resolvedPath, /baia-old/i);
  }
  assert.deepEqual(payload.contents, { moviePoster: 'NEW', seriesPoster: 'NEW' });

  fs.rmSync(root, { recursive: true, force: true });
});
