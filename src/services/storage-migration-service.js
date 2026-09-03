'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const STORAGE_SCHEMA_VERSION = 14;
const SECTION_BY_READING_CATEGORY = Object.freeze({
  books: 'Libri',
  comics: 'Fumetti',
  manga: 'Manga',
});
const MANAGED_SECTIONS = Object.freeze(['Film', 'Serie', 'Libri', 'Fumetti', 'Manga', 'Musica']);

class StorageMigrationError extends Error {
  constructor(message, code = 'STORAGE_MIGRATION_FAILED', details = {}) {
    super(message);
    this.name = 'StorageMigrationError';
    this.code = code;
    this.details = details;
  }
}

function normalizeLibraryRelativePath(value, { allowRoot = false } = {}) {
  if (typeof value !== 'string') {
    throw new StorageMigrationError('Il percorso relativo deve essere una stringa.', 'INVALID_LIBRARY_PATH');
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed === '.') {
    if (allowRoot) return '';
    throw new StorageMigrationError('Il percorso relativo è vuoto.', 'INVALID_LIBRARY_PATH');
  }
  if (trimmed.includes('\0')) {
    throw new StorageMigrationError('Il percorso contiene un carattere NUL.', 'INVALID_LIBRARY_PATH');
  }
  if (isAbsoluteOnAnyPlatform(trimmed)) {
    throw new StorageMigrationError(
      `Il database contiene un percorso assoluto: ${trimmed}`,
      'ABSOLUTE_LIBRARY_PATH',
      { value: trimmed },
    );
  }
  const segments = trimmed.replaceAll('\\', '/').split('/');
  const normalized = [];
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      throw new StorageMigrationError(
        `Il percorso tenta di uscire dalla libreria: ${trimmed}`,
        'LIBRARY_PATH_TRAVERSAL',
        { value: trimmed },
      );
    }
    normalized.push(segment);
  }
  if (!normalized.length) {
    if (allowRoot) return '';
    throw new StorageMigrationError('Il percorso relativo è vuoto.', 'INVALID_LIBRARY_PATH');
  }
  return normalized.join('/');
}

function isInsideDirectory(rootPath, candidatePath) {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(root, candidate);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function portableText(value) {
  return String(value ?? '').trim().replaceAll('\\', '/');
}

function portableBasename(value) {
  const text = portableText(value);
  if (!text) return null;
  const basename = path.posix.basename(text);
  return basename && basename !== '.' && basename !== '..' ? basename : null;
}

function portableDirname(value) {
  const normalized = normalizeLibraryRelativePath(value);
  const directory = path.posix.dirname(normalized);
  return directory === '.' ? '' : directory;
}

function portableJoin(...parts) {
  return normalizeLibraryRelativePath(
    parts.filter((part) => String(part ?? '').trim()).join('/'),
  );
}

function equalPortable(left, right) {
  return String(left ?? '') === String(right ?? '');
}

function caseKey(value) {
  return String(value ?? '').normalize('NFC').toLocaleLowerCase('it');
}

function isAbsoluteOnAnyPlatform(value) {
  return path.isAbsolute(value) || path.win32.isAbsolute(value) || path.posix.isAbsolute(value);
}

function sectionMatches(segment, expectedSection) {
  return String(segment || '').localeCompare(expectedSection, 'it', { sensitivity: 'base' }) === 0;
}

function assertExpectedSection(relativePath, expectedSection, { allowSectionRoot = false } = {}) {
  const normalized = normalizeLibraryRelativePath(relativePath);
  const segments = normalized.split('/');
  if (!sectionMatches(segments[0], expectedSection)) {
    throw new StorageMigrationError(
      `Il percorso “${normalized}” non appartiene alla sezione ${expectedSection}.`,
      'STORAGE_SECTION_MISMATCH',
      { relativePath: normalized, expectedSection },
    );
  }
  if (!allowSectionRoot && segments.length < 2) {
    throw new StorageMigrationError(
      `Il percorso “${normalized}” identifica soltanto la radice ${expectedSection}.`,
      'STORAGE_PATH_INCOMPLETE',
      { relativePath: normalized, expectedSection },
    );
  }
  segments[0] = expectedSection;
  return segments.join('/');
}

function recoverSectionRelativePath(value, expectedSection, options = {}) {
  const text = portableText(value);
  if (!text) return null;

  if (!isAbsoluteOnAnyPlatform(text)) {
    try {
      return assertExpectedSection(text, expectedSection, options);
    } catch (error) {
      if (!['STORAGE_SECTION_MISMATCH', 'ABSOLUTE_LIBRARY_PATH'].includes(error?.code)) throw error;
    }
  }

  const segments = text.split('/').filter(Boolean);
  const sectionIndex = segments.findIndex((segment) => sectionMatches(segment, expectedSection));
  if (sectionIndex < 0) return null;
  return assertExpectedSection(segments.slice(sectionIndex).join('/'), expectedSection, options);
}

function primaryRelativePath(row, {
  expectedSection,
  relativeColumn = 'relative_path',
  legacyColumn,
  allowSectionRoot = false,
} = {}) {
  const candidates = [
    { column: relativeColumn, value: row?.[relativeColumn] },
    { column: legacyColumn, value: row?.[legacyColumn] },
  ];
  const failures = [];

  for (const candidate of candidates) {
    if (!String(candidate.value ?? '').trim()) continue;
    try {
      const relativePath = recoverSectionRelativePath(candidate.value, expectedSection, { allowSectionRoot });
      if (relativePath) {
        return {
          relativePath,
          sourceColumn: candidate.column,
          sourceValue: candidate.value,
          recovered: relativePath !== portableText(candidate.value),
        };
      }
      failures.push({ column: candidate.column, value: candidate.value });
    } catch (error) {
      failures.push({ column: candidate.column, value: candidate.value, error });
    }
  }

  throw new StorageMigrationError(
    `Impossibile ricostruire un percorso portabile nella sezione ${expectedSection}.`,
    'STORAGE_PATH_UNMAPPABLE',
    { expectedSection, failures },
  );
}

function companionRelativePath(storedValue, primaryPath, {
  fallbackFileName = null,
  optional = false,
  primaryIsDirectory = false,
} = {}) {
  const primaryDirectory = primaryIsDirectory
    ? normalizeLibraryRelativePath(primaryPath)
    : portableDirname(primaryPath);
  const storedText = portableText(storedValue);
  if (!storedText) {
    if (optional && !fallbackFileName) return null;
    if (!fallbackFileName) return null;
    return portableJoin(primaryDirectory, portableBasename(fallbackFileName));
  }

  let normalized = null;
  try {
    normalized = normalizeLibraryRelativePath(storedText);
  } catch (error) {
    if (error?.code !== 'ABSOLUTE_LIBRARY_PATH') throw error;
  }

  if (normalized && normalized.includes('/')) {
    const normalizedDirectory = portableDirname(normalized);
    if (caseKey(normalizedDirectory) === caseKey(primaryDirectory)) return normalized;
  }

  const basename = portableBasename(storedText);
  if (!basename) {
    throw new StorageMigrationError(
      `Impossibile ricostruire il file associato a “${primaryPath}”.`,
      'STORAGE_COMPANION_UNMAPPABLE',
      { storedValue, primaryPath },
    );
  }
  return portableJoin(primaryDirectory, basename);
}

function movieExpectedSection(row) {
  return String(row.media_type || '').toLowerCase() === 'series' ? 'Serie' : 'Film';
}

function movieMetadataFallback(row, relativePath) {
  if (movieExpectedSection(row) !== 'Serie') return 'metadata.json';
  const basename = path.posix.basename(relativePath);
  const extension = path.posix.extname(basename);
  return `${basename.slice(0, basename.length - extension.length)}.metadata.json`;
}

function issueDetails(error) {
  if (!error) return {};
  return {
    errorCode: error.code,
    errorDetails: error.details,
  };
}

function tableExists(database, tableName) {
  return Boolean(database.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1
  `).get(tableName));
}

function tableColumns(database, tableName) {
  if (!tableExists(database, tableName)) return new Set();
  return new Set(database.prepare(`PRAGMA table_info(${tableName})`).all().map((column) => column.name));
}

function requireColumns(report, database, tableName, requiredColumns) {
  if (!tableExists(database, tableName)) return false;
  const columns = tableColumns(database, tableName);
  const missing = requiredColumns.filter((column) => !columns.has(column));
  if (!missing.length) return true;
  report.issues.push({
    severity: 'error',
    code: 'STORAGE_SCHEMA_UNSUPPORTED',
    table: tableName,
    message: `La tabella ${tableName} non contiene le colonne richieste: ${missing.join(', ')}.`,
    missingColumns: missing,
  });
  return false;
}

function categoryStats(label) {
  return {
    label,
    records: 0,
    migratable: 0,
    alreadyPortable: 0,
    missing: 0,
  };
}

function createReport({ databasePath, libraryPath, schemaVersion }) {
  return {
    databasePath,
    libraryPath,
    schemaVersion,
    targetSchemaVersion: STORAGE_SCHEMA_VERSION,
    categories: {
      movies: categoryStats('Film'),
      series: categoryStats('Serie'),
      reading: categoryStats('Libri, Fumetti e Manga'),
      music: categoryStats('Musica'),
    },
    changes: [],
    issues: [],
    collisions: [],
    cacheEntriesInvalidated: 0,
    legacyAbsolutePaths: 0,
    backupPath: null,
    applied: false,
  };
}

function recordIssue(report, issue) {
  report.issues.push(issue);
}

function addChange(report, change) {
  report.changes.push(change);
}

function changedValues(row, values) {
  return Object.fromEntries(
    Object.entries(values).filter(([column, value]) => !equalPortable(row[column], value)),
  );
}

function resolvedLocalPath(libraryPath, relativePath) {
  const normalized = normalizeLibraryRelativePath(relativePath);
  const candidate = path.resolve(libraryPath, ...normalized.split('/'));
  if (!isInsideDirectory(libraryPath, candidate)) {
    throw new StorageMigrationError(
      `Il percorso risolto esce dalla libreria: ${candidate}`,
      'STORAGE_PATH_OUTSIDE_LIBRARY',
      { libraryPath, relativePath, candidate },
    );
  }
  return candidate;
}

function nearestExistingAncestor(candidatePath) {
  let current = path.resolve(candidatePath);
  while (true) {
    try {
      fs.lstatSync(current);
      return current;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function validateRealTarget(libraryPath, relativePath) {
  const candidate = resolvedLocalPath(libraryPath, relativePath);
  const realRoot = fs.realpathSync(libraryPath);
  const existingAncestor = nearestExistingAncestor(candidate);
  const realAncestor = fs.realpathSync(existingAncestor);
  if (!isInsideDirectory(realRoot, realAncestor)) {
    throw new StorageMigrationError(
      `Il percorso attraversa un collegamento simbolico esterno alla libreria: ${candidate}`,
      'STORAGE_SYMLINK_ESCAPE',
      { libraryPath: realRoot, candidatePath: realAncestor, relativePath },
    );
  }
  return candidate;
}

function primaryExists(libraryPath, relativePath, expectedType) {
  const candidate = validateRealTarget(libraryPath, relativePath);
  try {
    const stats = fs.statSync(candidate);
    if (expectedType === 'directory') return stats.isDirectory();
    return stats.isFile();
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    throw error;
  }
}

function processPrimaryRecord(report, {
  row,
  table,
  idColumn = 'id',
  category,
  expectedSection,
  legacyColumn,
  expectedType = 'file',
  values,
  collisionDomain,
}) {
  const stats = report.categories[category];
  stats.records += 1;
  const id = row[idColumn];

  try {
    const primary = primaryRelativePath(row, {
      expectedSection,
      legacyColumn,
      allowSectionRoot: false,
    });
    const targetValues = values(primary.relativePath);
    const changes = changedValues(row, targetValues);
    const exists = primaryExists(report.libraryPath, primary.relativePath, expectedType);
    if (!exists) {
      stats.missing += 1;
      recordIssue(report, {
        severity: 'warning',
        code: 'STORAGE_PRIMARY_MISSING',
        table,
        id,
        relativePath: primary.relativePath,
        message: `${expectedType === 'directory' ? 'Cartella non trovata' : 'File non trovato'} nella libreria configurata: ${primary.relativePath}`,
      });
    }

    if (Object.keys(changes).length) {
      report.legacyAbsolutePaths += Object.keys(changes).filter((column) => (
        isAbsoluteOnAnyPlatform(portableText(row[column]))
      )).length;
      stats.migratable += 1;
      addChange(report, { table, idColumn, id, values: changes, relativePath: primary.relativePath });
    } else {
      stats.alreadyPortable += 1;
    }

    collisionDomain.push({ table, id, relativePath: primary.relativePath });
    return primary.relativePath;
  } catch (error) {
    recordIssue(report, {
      severity: 'error',
      code: error?.code || 'STORAGE_RECORD_INVALID',
      table,
      id,
      message: `${table}#${id}: ${error.message}`,
      ...issueDetails(error),
    });
    return null;
  }
}

function processMovies(report, database, collisionDomains) {
  if (!requireColumns(report, database, 'movies', [
    'id', 'file_path', 'relative_path', 'media_type', 'metadata_path', 'poster_path', 'metadata_auto_json',
  ])) return;

  const rows = database.prepare('SELECT * FROM movies ORDER BY id').all();
  const movieRelativeById = new Map();
  for (const row of rows) {
    const category = movieExpectedSection(row) === 'Serie' ? 'series' : 'movies';
    const relativePath = processPrimaryRecord(report, {
      row,
      table: 'movies',
      category,
      expectedSection: movieExpectedSection(row),
      legacyColumn: 'file_path',
      collisionDomain: collisionDomains.movies,
      values(primary) {
        let metadataAutoJson = row.metadata_auto_json;
        if (metadataAutoJson) {
          try {
            const parsed = JSON.parse(metadataAutoJson);
            if (parsed?.automatic?.posterPath) {
              parsed.automatic.posterPath = companionRelativePath(parsed.automatic.posterPath, primary, { optional: true });
              metadataAutoJson = JSON.stringify(parsed);
            }
          } catch (error) {
            recordIssue(report, {
              severity: 'warning',
              code: 'STORAGE_METADATA_JSON_INVALID',
              table: 'movies',
              id: row.id,
              message: `metadata_auto_json non valido per movies#${row.id}; il valore viene conservato.`,
            });
          }
        }
        return {
          file_path: primary,
          relative_path: primary,
          metadata_path: companionRelativePath(row.metadata_path, primary, {
            fallbackFileName: movieMetadataFallback(row, primary),
          }),
          poster_path: companionRelativePath(row.poster_path, primary, { optional: true }),
          metadata_auto_json: metadataAutoJson,
        };
      },
    });
    if (relativePath) movieRelativeById.set(Number(row.id), relativePath);
  }

  if (!tableExists(database, 'media_metadata_overrides')) return;
  if (!requireColumns(report, database, 'media_metadata_overrides', ['movie_id', 'poster_path'])) return;
  const overrides = database.prepare(`
    SELECT movie_id, poster_path FROM media_metadata_overrides
    WHERE COALESCE(poster_path, '') <> ''
    ORDER BY movie_id
  `).all();
  for (const row of overrides) {
    const primary = movieRelativeById.get(Number(row.movie_id));
    if (!primary) continue;
    try {
      const posterPath = companionRelativePath(row.poster_path, primary, { optional: true });
      if (!equalPortable(row.poster_path, posterPath)) {
        if (isAbsoluteOnAnyPlatform(portableText(row.poster_path))) report.legacyAbsolutePaths += 1;
        addChange(report, {
          table: 'media_metadata_overrides',
          idColumn: 'movie_id',
          id: row.movie_id,
          values: { poster_path: posterPath },
          relativePath: primary,
        });
      }
    } catch (error) {
      recordIssue(report, {
        severity: 'error',
        code: error?.code || 'STORAGE_OVERRIDE_INVALID',
        table: 'media_metadata_overrides',
        id: row.movie_id,
        message: `media_metadata_overrides#${row.movie_id}: ${error.message}`,
        ...issueDetails(error),
      });
    }
  }
}

function processSeries(report, database, collisionDomains) {
  if (!requireColumns(report, database, 'series', [
    'id', 'directory_path', 'relative_path', 'metadata_path', 'poster_path',
  ])) return;
  for (const row of database.prepare('SELECT * FROM series ORDER BY id').all()) {
    processPrimaryRecord(report, {
      row,
      table: 'series',
      category: 'series',
      expectedSection: 'Serie',
      legacyColumn: 'directory_path',
      expectedType: 'directory',
      collisionDomain: collisionDomains.series,
      values(primary) {
        return {
          directory_path: primary,
          relative_path: primary,
          metadata_path: companionRelativePath(row.metadata_path, primary, {
            fallbackFileName: 'metadata.json',
            primaryIsDirectory: true,
          }),
          poster_path: companionRelativePath(row.poster_path, primary, {
            optional: true,
            primaryIsDirectory: true,
          }),
        };
      },
    });
  }
}

function processReading(report, database, collisionDomains) {
  if (!requireColumns(report, database, 'reading_items', [
    'id', 'category', 'file_path', 'relative_path', 'metadata_path', 'cover_path',
  ])) return;
  for (const row of database.prepare('SELECT * FROM reading_items ORDER BY id').all()) {
    const expectedSection = SECTION_BY_READING_CATEGORY[String(row.category || '').trim()];
    if (!expectedSection) {
      report.categories.reading.records += 1;
      recordIssue(report, {
        severity: 'error',
        code: 'STORAGE_READING_CATEGORY_INVALID',
        table: 'reading_items',
        id: row.id,
        message: `Categoria di lettura non valida per reading_items#${row.id}: ${row.category}`,
      });
      continue;
    }
    processPrimaryRecord(report, {
      row,
      table: 'reading_items',
      category: 'reading',
      expectedSection,
      legacyColumn: 'file_path',
      collisionDomain: collisionDomains.reading,
      values(primary) {
        return {
          file_path: primary,
          relative_path: primary,
          metadata_path: companionRelativePath(row.metadata_path, primary, {
            fallbackFileName: 'metadata.json',
          }),
          cover_path: companionRelativePath(row.cover_path, primary, { optional: true }),
        };
      },
    });
  }
}

function processMusic(report, database, collisionDomains) {
  if (requireColumns(report, database, 'music_albums', [
    'id', 'directory_path', 'relative_path', 'cover_cache_path',
  ])) {
    for (const row of database.prepare('SELECT * FROM music_albums ORDER BY id').all()) {
      processPrimaryRecord(report, {
        row,
        table: 'music_albums',
        category: 'music',
        expectedSection: 'Musica',
        legacyColumn: 'directory_path',
        expectedType: 'directory',
        collisionDomain: collisionDomains.musicAlbums,
        values(primary) {
          if (String(row.cover_cache_path || '').trim()) report.cacheEntriesInvalidated += 1;
          return {
            directory_path: primary,
            relative_path: primary,
            cover_cache_path: null,
          };
        },
      });
    }
  }

  if (requireColumns(report, database, 'music_tracks', [
    'id', 'file_path', 'relative_path',
  ])) {
    for (const row of database.prepare('SELECT * FROM music_tracks ORDER BY id').all()) {
      processPrimaryRecord(report, {
        row,
        table: 'music_tracks',
        category: 'music',
        expectedSection: 'Musica',
        legacyColumn: 'file_path',
        collisionDomain: collisionDomains.musicTracks,
        values(primary) {
          return { file_path: primary, relative_path: primary };
        },
      });
    }
  }
}

function findCollisions(report, domainName, rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = caseKey(row.relativePath);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const collision = {
      domain: domainName,
      relativePath: group[0].relativePath,
      records: group.map(({ table, id }) => ({ table, id })),
    };
    report.collisions.push(collision);
    recordIssue(report, {
      severity: 'error',
      code: 'STORAGE_RELATIVE_PATH_COLLISION',
      message: `Più record convergono sul percorso ${group[0].relativePath}.`,
      ...collision,
    });
  }
}

function finalizeReport(report, collisionDomains) {
  findCollisions(report, 'movies', collisionDomains.movies);
  findCollisions(report, 'series', collisionDomains.series);
  findCollisions(report, 'reading', collisionDomains.reading);
  findCollisions(report, 'music_albums', collisionDomains.musicAlbums);
  findCollisions(report, 'music_tracks', collisionDomains.musicTracks);

  report.summary = {
    records: Object.values(report.categories).reduce((sum, item) => sum + item.records, 0),
    migratable: Object.values(report.categories).reduce((sum, item) => sum + item.migratable, 0),
    alreadyPortable: Object.values(report.categories).reduce((sum, item) => sum + item.alreadyPortable, 0),
    missing: Object.values(report.categories).reduce((sum, item) => sum + item.missing, 0),
    changes: report.changes.length,
    errors: report.issues.filter((issue) => issue.severity === 'error').length,
    warnings: report.issues.filter((issue) => issue.severity === 'warning').length,
    externalPaths: report.issues.filter((issue) => [
      'STORAGE_PATH_UNMAPPABLE',
      'STORAGE_SECTION_MISMATCH',
      'STORAGE_PATH_OUTSIDE_LIBRARY',
      'STORAGE_SYMLINK_ESCAPE',
    ].includes(issue.code)).length,
  };
  report.canApply = report.summary.errors === 0;
  return report;
}

function analyzeDatabase(database, { databasePath, libraryPath }) {
  const resolvedDatabasePath = path.resolve(databasePath);
  const resolvedLibraryPath = path.resolve(libraryPath);
  const rootStats = fs.statSync(resolvedLibraryPath);
  if (!rootStats.isDirectory()) {
    throw new StorageMigrationError(
      `LIBRARY_PATH non è una cartella: ${resolvedLibraryPath}`,
      'STORAGE_LIBRARY_UNAVAILABLE',
    );
  }

  const schemaVersion = Number(database.prepare('PRAGMA user_version').get()?.user_version || 0);
  const report = createReport({
    databasePath: resolvedDatabasePath,
    libraryPath: resolvedLibraryPath,
    schemaVersion,
  });
  const collisionDomains = {
    movies: [],
    series: [],
    reading: [],
    musicAlbums: [],
    musicTracks: [],
  };

  processMovies(report, database, collisionDomains);
  processSeries(report, database, collisionDomains);
  processReading(report, database, collisionDomains);
  processMusic(report, database, collisionDomains);
  return finalizeReport(report, collisionDomains);
}

function analyzeStorageMigration({ databasePath, libraryPath }) {
  const resolvedDatabasePath = path.resolve(databasePath);
  if (!fs.existsSync(resolvedDatabasePath)) {
    throw new StorageMigrationError(
      `Database non trovato: ${resolvedDatabasePath}`,
      'STORAGE_DATABASE_NOT_FOUND',
    );
  }
  const database = new DatabaseSync(resolvedDatabasePath, { readOnly: true });
  try {
    database.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;');
    return analyzeDatabase(database, { databasePath: resolvedDatabasePath, libraryPath });
  } finally {
    database.close();
  }
}

function createMigrationBackup(database, { databasePath, backupsPath }) {
  const destinationDirectory = path.resolve(backupsPath);
  fs.mkdirSync(destinationDirectory, { recursive: true });
  const baseName = path.basename(databasePath, path.extname(databasePath)) || 'media';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = path.join(
    destinationDirectory,
    `${baseName}-${stamp}-prima-step-23e.sqlite`,
  );
  database.exec(`VACUUM INTO ${sqlString(destination)}`);
  return destination;
}

function applyChanges(database, changes) {
  const statementCache = new Map();
  for (const change of changes) {
    const columns = Object.keys(change.values).sort();
    if (!columns.length) continue;
    const cacheKey = `${change.table}|${change.idColumn}|${columns.join(',')}`;
    let statement = statementCache.get(cacheKey);
    if (!statement) {
      const assignments = columns.map((column) => `${column} = ?`).join(', ');
      statement = database.prepare(`
        UPDATE ${change.table} SET ${assignments} WHERE ${change.idColumn} = ?
      `);
      statementCache.set(cacheKey, statement);
    }
    statement.run(...columns.map((column) => change.values[column]), change.id);
  }
}

function applyStorageMigration({ databasePath, libraryPath, backupsPath }) {
  const resolvedDatabasePath = path.resolve(databasePath);
  if (!fs.existsSync(resolvedDatabasePath)) {
    throw new StorageMigrationError(
      `Database non trovato: ${resolvedDatabasePath}`,
      'STORAGE_DATABASE_NOT_FOUND',
    );
  }

  const database = new DatabaseSync(resolvedDatabasePath);
  try {
    database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    const initialReport = analyzeDatabase(database, {
      databasePath: resolvedDatabasePath,
      libraryPath,
    });
    if (!initialReport.canApply) {
      throw new StorageMigrationError(
        `Migrazione bloccata: trovati ${initialReport.summary.errors} errori da risolvere.`,
        'STORAGE_MIGRATION_BLOCKED',
        { report: initialReport },
      );
    }
    if (!initialReport.changes.length) return initialReport;

    const backupPath = createMigrationBackup(database, {
      databasePath: resolvedDatabasePath,
      backupsPath,
    });

    database.exec('BEGIN IMMEDIATE');
    try {
      const lockedReport = analyzeDatabase(database, {
        databasePath: resolvedDatabasePath,
        libraryPath,
      });
      if (!lockedReport.canApply) {
        throw new StorageMigrationError(
          'Il database è cambiato durante la preparazione e ora contiene errori bloccanti.',
          'STORAGE_MIGRATION_CHANGED',
          { report: lockedReport },
        );
      }
      applyChanges(database, lockedReport.changes);
      const verification = analyzeDatabase(database, {
        databasePath: resolvedDatabasePath,
        libraryPath,
      });
      if (!verification.canApply || verification.changes.length) {
        throw new StorageMigrationError(
          'La verifica finale ha rilevato percorsi non portabili dopo la migrazione.',
          'STORAGE_MIGRATION_VERIFICATION_FAILED',
          { report: verification },
        );
      }
      const foreignKeyProblems = database.prepare('PRAGMA foreign_key_check').all();
      if (foreignKeyProblems.length) {
        throw new StorageMigrationError(
          'La verifica dei vincoli SQLite ha rilevato errori.',
          'STORAGE_MIGRATION_FOREIGN_KEYS',
          { foreignKeyProblems },
        );
      }
      const integrityRows = database.prepare('PRAGMA integrity_check').all();
      if (integrityRows.length !== 1 || integrityRows[0].integrity_check !== 'ok') {
        throw new StorageMigrationError(
          'La verifica di integrità SQLite non è stata superata.',
          'STORAGE_MIGRATION_INTEGRITY_CHECK',
          { integrityRows },
        );
      }
      database.exec('COMMIT');

      lockedReport.applied = true;
      lockedReport.appliedChanges = lockedReport.changes.length;
      lockedReport.backupPath = backupPath;
      lockedReport.postMigration = {
        summary: verification.summary,
        categories: verification.categories,
      };
      return lockedReport;
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch {}
      throw error;
    }
  } finally {
    database.close();
  }
}

module.exports = {
  STORAGE_SCHEMA_VERSION,
  MANAGED_SECTIONS,
  StorageMigrationError,
  recoverSectionRelativePath,
  companionRelativePath,
  analyzeStorageMigration,
  applyStorageMigration,
};
