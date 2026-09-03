'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('../config');
const { resolveLibraryPath, assertRealPathInsideLibrary } = require('./library-path-service');

const LIBRARY_IDENTITY_FILE = '.baia-library.json';
const LIBRARY_FORMAT_VERSION = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class LibraryIdentityError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'LibraryIdentityError';
    this.code = code;
    this.details = details;
  }
}

function validateIdentity(value, source) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LibraryIdentityError(
      `Identità libreria non valida in ${source}.`,
      'INVALID_LIBRARY_IDENTITY',
      { source },
    );
  }

  const libraryId = String(value.libraryId || '').trim();
  const formatVersion = Number(value.formatVersion);
  if (!UUID_PATTERN.test(libraryId)) {
    throw new LibraryIdentityError(
      `libraryId non valido in ${source}.`,
      'INVALID_LIBRARY_IDENTITY',
      { source, libraryId },
    );
  }
  if (!Number.isInteger(formatVersion) || formatVersion !== LIBRARY_FORMAT_VERSION) {
    throw new LibraryIdentityError(
      `Versione identità libreria non supportata in ${source}: ${value.formatVersion}`,
      'UNSUPPORTED_LIBRARY_FORMAT',
      { source, formatVersion: value.formatVersion, supportedVersion: LIBRARY_FORMAT_VERSION },
    );
  }
  return { libraryId, formatVersion };
}

function readDatabaseIdentity(database) {
  const table = database.prepare(`
    SELECT 1 AS present
    FROM sqlite_master
    WHERE type = 'table' AND name = 'library_identity'
    LIMIT 1
  `).get();
  if (!table) {
    throw new LibraryIdentityError(
      'Schema database incompleto: manca library_identity.',
      'LIBRARY_IDENTITY_SCHEMA_MISSING',
    );
  }

  const row = database.prepare(`
    SELECT library_id AS libraryId, format_version AS formatVersion
    FROM library_identity
    WHERE singleton_id = 1
  `).get();
  return row ? validateIdentity(row, 'SQLite') : null;
}

async function readMarker(markerPath) {
  try {
    const stats = await fs.lstat(markerPath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new LibraryIdentityError(
        `Il marcatore della libreria non è un file regolare: ${markerPath}`,
        'INVALID_LIBRARY_MARKER',
        { markerPath },
      );
    }
    const text = await fs.readFile(markerPath, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new LibraryIdentityError(
        `Il marcatore della libreria contiene JSON non valido: ${markerPath}`,
        'INVALID_LIBRARY_MARKER',
        { markerPath, cause: error.message },
      );
    }
    return validateIdentity(parsed, markerPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function insertDatabaseIdentity(database, identity) {
  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare(`
      INSERT INTO library_identity (
        singleton_id, library_id, format_version, created_at, updated_at
      ) VALUES (1, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(identity.libraryId, identity.formatVersion);
    database.exec('COMMIT');
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

async function writeMarkerAtomically(markerPath, identity) {
  const temporaryPath = path.join(
    path.dirname(markerPath),
    `.${path.basename(markerPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  const payload = `${JSON.stringify(identity, null, 2)}\n`;
  try {
    await fs.writeFile(temporaryPath, payload, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await fs.rename(temporaryPath, markerPath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

function mismatchError(databaseIdentity, markerIdentity, markerPath, libraryRoot) {
  return new LibraryIdentityError(
    [
      'La cartella media configurata non appartiene al database corrente.',
      `Database: ${databaseIdentity.libraryId}`,
      `Libreria: ${markerIdentity.libraryId}`,
      `Percorso: ${libraryRoot}`,
      'Avvio bloccato per evitare letture o scritture nella libreria sbagliata.',
    ].join('\n'),
    'LIBRARY_IDENTITY_MISMATCH',
    { databaseIdentity, markerIdentity, markerPath, libraryRoot },
  );
}

async function ensureLibraryIdentity({ database, libraryRoot = config.libraryPath } = {}) {
  if (!database) throw new TypeError('ensureLibraryIdentity richiede una connessione SQLite.');

  const root = path.resolve(libraryRoot);
  await assertRealPathInsideLibrary(root, { libraryRoot: root, allowRoot: true });
  const markerPath = resolveLibraryPath(LIBRARY_IDENTITY_FILE, { libraryRoot: root });
  const [databaseIdentity, markerIdentity] = await Promise.all([
    Promise.resolve(readDatabaseIdentity(database)),
    readMarker(markerPath),
  ]);

  if (databaseIdentity && markerIdentity) {
    if (
      databaseIdentity.libraryId !== markerIdentity.libraryId
      || databaseIdentity.formatVersion !== markerIdentity.formatVersion
    ) {
      throw mismatchError(databaseIdentity, markerIdentity, markerPath, root);
    }
    return { ...databaseIdentity, markerPath, initialized: false };
  }

  if (databaseIdentity && !markerIdentity) {
    throw new LibraryIdentityError(
      [
        'Manca il marcatore .baia-library.json della libreria associata al database.',
        `Database: ${databaseIdentity.libraryId}`,
        `Percorso atteso: ${markerPath}`,
        'Avvio bloccato: non viene creata automaticamente una nuova associazione.',
      ].join('\n'),
      'LIBRARY_MARKER_MISSING',
      { databaseIdentity, markerPath, libraryRoot: root },
    );
  }

  if (!databaseIdentity && markerIdentity) {
    throw new LibraryIdentityError(
      [
        'La cartella media possiede già un’identità, ma il database corrente non è associato.',
        `Libreria: ${markerIdentity.libraryId}`,
        `Percorso: ${root}`,
        'Avvio bloccato: non viene adottata automaticamente una libreria esistente.',
      ].join('\n'),
      'DATABASE_IDENTITY_MISSING',
      { markerIdentity, markerPath, libraryRoot: root },
    );
  }

  const identity = {
    libraryId: crypto.randomUUID(),
    formatVersion: LIBRARY_FORMAT_VERSION,
  };

  await writeMarkerAtomically(markerPath, identity);
  try {
    insertDatabaseIdentity(database, identity);
  } catch (error) {
    await fs.rm(markerPath, { force: true }).catch(() => {});
    throw new LibraryIdentityError(
      `Impossibile registrare l’identità della libreria nel database: ${error.message}`,
      'LIBRARY_IDENTITY_DATABASE_WRITE_FAILED',
      { markerPath, libraryRoot: root },
    );
  }

  return { ...identity, markerPath, initialized: true };
}

module.exports = {
  LIBRARY_IDENTITY_FILE,
  LIBRARY_FORMAT_VERSION,
  LibraryIdentityError,
  ensureLibraryIdentity,
  readDatabaseIdentity,
};
