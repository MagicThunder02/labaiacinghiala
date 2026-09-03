'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const {
  readingRelativePath,
  readingMetadataRelativePath,
  readingCoverRelativePath,
  relativePathFromLegacyAbsolute,
} = require('../src/services/reading-library-path-service');

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

function runNode(script, env, { expectFailure = false } = {}) {
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: projectRoot,
    encoding: 'utf8',
    env,
  });
  if (expectFailure) {
    assert.notEqual(result.status, 0, 'Lo script avrebbe dovuto fallire.');
    return `${result.stderr}\n${result.stdout}`;
  }
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim().split(/\r?\n/).at(-1);
}

function writeFile(root, relativePath, contents) {
  const destination = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, contents);
}

test('i percorsi reading legacy vengono ricostruiti dentro la categoria corretta', () => {
  const row = {
    id: 7,
    category: 'books',
    relative_path: 'Libri\\Una vita (1892)\\Una vita.pdf',
    file_path: 'C:\\vecchia\\media\\Libri\\Una vita (1892)\\Una vita.pdf',
    metadata_path: 'C:\\vecchia\\media\\Libri\\Una vita (1892)\\metadata.json',
    cover_path: 'C:\\vecchia\\media\\Libri\\Una vita (1892)\\cover.jpg',
  };
  assert.equal(readingRelativePath(row), 'Libri/Una vita (1892)/Una vita.pdf');
  assert.equal(readingMetadataRelativePath(row), 'Libri/Una vita (1892)/metadata.json');
  assert.equal(readingCoverRelativePath(row), 'Libri/Una vita (1892)/cover.jpg');
  assert.equal(
    relativePathFromLegacyAbsolute('/old/media/Manga/Akira (1982)/Akira.cbz', 'manga'),
    'Manga/Akira (1982)/Akira.cbz',
  );
});

test('un file associato relativo esterno alla cartella del contenuto viene rifiutato', () => {
  assert.throws(() => readingCoverRelativePath({
    id: 8,
    category: 'books',
    relative_path: 'Libri/Test/Test.pdf',
    cover_path: 'Fumetti/Altro/cover.jpg',
  }), /esterno alla cartella del contenuto/);
});

test('schema 19 rende le letture portabili, deduplica i percorsi e conserva il bookmark più recente', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-reading-portable-'));
  const oldLibraryA = path.join(root, 'old-a', 'media');
  const oldLibraryB = path.join(root, 'old-b', 'media');
  const newLibrary = path.join(root, 'new', 'media');
  const databasePath = path.join(root, 'data', 'media.sqlite');
  const existingRelative = path.join('Libri', 'Presente (2020)', 'Presente.pdf');
  const missingRelative = path.join('Manga', 'Mancante (1990)', 'Mancante.cbz');
  const duplicateRelative = path.join('Fumetti', 'Duplicato (2001)', 'Duplicato.cbz');

  for (const library of [oldLibraryA, oldLibraryB]) {
    writeFile(library, existingRelative, 'OLD');
    writeFile(library, path.join('Libri', 'Presente (2020)', 'cover.jpg'), 'OLD-COVER');
    writeFile(library, path.join('Libri', 'Presente (2020)', 'metadata.json'), '{}');
    writeFile(library, duplicateRelative, 'OLD-DUPLICATE');
  }
  writeFile(newLibrary, existingRelative, 'NEW');
  writeFile(newLibrary, path.join('Libri', 'Presente (2020)', 'cover.jpg'), 'NEW-COVER');
  writeFile(newLibrary, path.join('Libri', 'Presente (2020)', 'metadata.json'), '{}');
  writeFile(newLibrary, duplicateRelative, 'NEW-DUPLICATE');

  const insertScript = `
    const path = require('node:path');
    const db = require('./src/database');
    db.exec('DROP INDEX IF EXISTS idx_reading_relative_path');
    const rows = ${JSON.stringify([
      { uuid: '11111111-1111-4111-8111-111111111111', category: 'books', relative: existingRelative, title: 'Presente', ext: '.pdf', root: oldLibraryA },
      { uuid: '22222222-2222-4222-8222-222222222222', category: 'manga', relative: missingRelative, title: 'Mancante', ext: '.cbz', root: oldLibraryA },
      { uuid: '33333333-3333-4333-8333-333333333333', category: 'comics', relative: duplicateRelative, title: 'Duplicato A', ext: '.cbz', root: oldLibraryA },
      { uuid: '44444444-4444-4444-8444-444444444444', category: 'comics', relative: duplicateRelative, title: 'Duplicato B', ext: '.cbz', root: oldLibraryB },
    ])};
    const insert = db.prepare(\`INSERT INTO reading_items (
      content_uuid, category, file_path, relative_path, file_name, title, year,
      author, genres_json, extension, mime_type, size_bytes, modified_at,
      cover_path, metadata_path, storage_version, available
    ) VALUES (?, ?, ?, ?, ?, ?, 2020, 'Autore', '[]', ?, 'application/octet-stream', 3, 1, ?, ?, 1, 1)\`);
    let firstId = null;
    const duplicateIds = [];
    for (const row of rows) {
      const directory = path.dirname(row.relative);
      const id = Number(insert.run(
        row.uuid, row.category, path.join(row.root, row.relative), row.relative,
        path.basename(row.relative), row.title, row.ext,
        path.join(row.root, directory, 'cover.jpg'),
        path.join(row.root, directory, 'metadata.json'),
      ).lastInsertRowid);
      if (firstId === null) firstId = id;
      if (row.title.startsWith('Duplicato')) duplicateIds.push(id);
    }
    db.prepare(\`INSERT INTO reading_bookmarks (reading_item_id, profile_key, locator_json, updated_at)
      VALUES (?, 'default', '{"kind":"page","page":3}', '2026-01-01T10:00:00.000Z')\`).run(firstId);
    db.prepare(\`INSERT INTO reading_bookmarks (reading_item_id, profile_key, locator_json, updated_at)
      VALUES (?, 'default', '{"kind":"page","page":4}', '2026-01-01T10:00:00.000Z')\`).run(duplicateIds[0]);
    db.prepare(\`INSERT INTO reading_bookmarks (reading_item_id, profile_key, locator_json, updated_at)
      VALUES (?, 'default', '{"kind":"page","page":9}', '2026-01-02T10:00:00.000Z')\`).run(duplicateIds[1]);
    db.exec('PRAGMA user_version = 11');
    db.close();
  `;
  runNode(insertScript, appEnvironment(root, oldLibraryA, databasePath));

  const migrateScript = `
    const fs = require('node:fs');
    const path = require('node:path');
    const db = require('./src/database');
    const { readingFilePath, readingCoverPath, readingMetadataPath } = require('./src/services/reading-library-path-service');
    const rows = db.prepare('SELECT * FROM reading_items ORDER BY id').all();
    const payload = {
      version: Number(db.prepare('PRAGMA user_version').get().user_version),
      rows: rows.map((row) => ({
        id: row.id,
        stored: [row.file_path, row.relative_path, row.cover_path, row.metadata_path],
        available: row.available,
        resolved: {
          file: readingFilePath(row),
          cover: readingCoverPath(row),
          metadata: readingMetadataPath(row),
        },
      })),
      bookmarkCount: Number(db.prepare('SELECT COUNT(*) AS count FROM reading_bookmarks').get().count),
      duplicateCount: Number(db.prepare('SELECT COUNT(*) AS count FROM reading_items WHERE relative_path = ? COLLATE NOCASE').get(${JSON.stringify(duplicateRelative.replaceAll('\\', '/'))}).count),
      duplicateBookmark: db.prepare(\`SELECT b.locator_json AS locatorJson
        FROM reading_bookmarks b JOIN reading_items r ON r.id = b.reading_item_id
        WHERE r.relative_path = ? COLLATE NOCASE AND b.profile_key = 'default'\`).get(${JSON.stringify(duplicateRelative.replaceAll('\\', '/'))})?.locatorJson,
      existingContents: fs.readFileSync(readingFilePath(rows[0]), 'utf8'),
      coverContents: fs.readFileSync(readingCoverPath(rows[0]), 'utf8'),
      foreignKeyProblems: db.prepare('PRAGMA foreign_key_check').all().length,
    };
    console.log(JSON.stringify(payload));
    db.close();
  `;
  const payload = JSON.parse(runNode(migrateScript, appEnvironment(root, newLibrary, databasePath)));

  assert.equal(payload.version, 19);
  assert.equal(payload.bookmarkCount, 2);
  assert.equal(payload.duplicateCount, 1);
  assert.equal(JSON.parse(payload.duplicateBookmark).page, 9);
  assert.equal(payload.foreignKeyProblems, 0);
  assert.equal(payload.existingContents, 'NEW');
  assert.equal(payload.coverContents, 'NEW-COVER');
  assert.equal(payload.rows[0].available, 1);
  assert.equal(payload.rows[1].available, 0);
  for (const row of payload.rows) {
    for (const storedPath of row.stored.filter(Boolean)) {
      assert.equal(path.isAbsolute(storedPath), false, `Percorso ancora assoluto: ${storedPath}`);
      assert.doesNotMatch(storedPath, /old-a|old-b/i);
      assert.doesNotMatch(storedPath, /\\/);
    }
    for (const resolvedPath of Object.values(row.resolved).filter(Boolean)) {
      assert.ok(resolvedPath.startsWith(path.resolve(newLibrary) + path.sep));
      assert.doesNotMatch(resolvedPath, /old-a|old-b/i);
    }
  }

  fs.rmSync(root, { recursive: true, force: true });
});

test('la migrazione blocca un percorso esterno senza categoria ricostruibile', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-reading-invalid-'));
  const library = path.join(root, 'media');
  const databasePath = path.join(root, 'data', 'media.sqlite');
  fs.mkdirSync(library, { recursive: true });
  const insertScript = `
    const db = require('./src/database');
    db.prepare(\`INSERT INTO reading_items (
      content_uuid, category, file_path, relative_path, file_name, title,
      author, genres_json, extension, mime_type, size_bytes, modified_at,
      metadata_path, storage_version, available
    ) VALUES ('55555555-5555-4555-8555-555555555555', 'books',
      'D:\\\\archivio-esterno\\\\Segreto.pdf', '', 'Segreto.pdf', 'Segreto',
      'Autore', '[]', '.pdf', 'application/pdf', 1, 1,
      'D:\\\\archivio-esterno\\\\metadata.json', 1, 1)\`).run();
    db.exec('PRAGMA user_version = 11');
    db.close();
  `;
  runNode(insertScript, appEnvironment(root, library, databasePath));
  const failure = runNode("require('./src/database')", appEnvironment(root, library, databasePath), { expectFailure: true });
  assert.match(failure, /Impossibile ricostruire un percorso portabile|Migrazione dei percorsi Libri\/Fumetti\/Manga non riuscita/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('un nuovo upload reading salva in SQLite soltanto percorsi relativi', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-reading-upload-portable-'));
  const library = path.join(root, 'media');
  const databasePath = path.join(root, 'data', 'media.sqlite');
  const temporary = path.join(library, '.uploads');
  fs.mkdirSync(temporary, { recursive: true });
  const documentPath = path.join(temporary, 'document.tmp');
  const posterPath = path.join(temporary, 'poster.tmp');
  fs.writeFileSync(documentPath, 'PDF');
  fs.writeFileSync(posterPath, 'JPEG');

  const script = `
    (async () => {
      const fs = require('node:fs');
      const db = require('./src/database');
      const { createReadingItemFromUpload } = require('./src/services/reading-upload-service');
      const result = await createReadingItemFromUpload({
        category: 'books',
        document: {
          path: ${JSON.stringify(documentPath)}, originalname: 'Portabile.pdf',
          mimetype: 'application/pdf', size: 3,
        },
        poster: {
          path: ${JSON.stringify(posterPath)}, originalname: 'cover.jpg',
          mimetype: 'image/jpeg', size: 4,
        },
        fields: { title: 'Portabile', author: 'Autore', year: '2024', genre: 'Romanzo' },
      });
      const row = db.prepare('SELECT * FROM reading_items WHERE id = ?').get(result.id);
      const { readingFilePath, readingCoverPath, readingMetadataPath } = require('./src/services/reading-library-path-service');
      console.log(JSON.stringify({
        row: [row.file_path, row.relative_path, row.cover_path, row.metadata_path],
        exists: [readingFilePath(row), readingCoverPath(row), readingMetadataPath(row)].map((candidate) => fs.existsSync(candidate)),
        responseMetadataPath: result.metadataPath,
      }));
      db.close();
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  const payload = JSON.parse(runNode(script, appEnvironment(root, library, databasePath)));
  assert.deepEqual(payload.exists, [true, true, true]);
  assert.equal(path.isAbsolute(payload.responseMetadataPath), false);
  for (const storedPath of payload.row) {
    assert.equal(path.isAbsolute(storedPath), false);
    assert.doesNotMatch(storedPath, /\\/);
  }
  fs.rmSync(root, { recursive: true, force: true });
});
