'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('../config');

class LibraryPathError extends Error {
  constructor(message, code = 'INVALID_LIBRARY_PATH', details = {}) {
    super(message);
    this.name = 'LibraryPathError';
    this.code = code;
    this.details = details;
  }
}

function configuredLibraryRoot(libraryRoot = config.libraryPath) {
  const value = String(libraryRoot || '').trim();
  if (!value) {
    throw new LibraryPathError('La radice della libreria non è configurata.', 'LIBRARY_ROOT_MISSING');
  }
  return path.resolve(value);
}

function isAbsoluteOnAnyPlatform(value) {
  return path.isAbsolute(value) || path.win32.isAbsolute(value) || path.posix.isAbsolute(value);
}

function normalizeLibraryRelativePath(value, { allowRoot = false } = {}) {
  if (typeof value !== 'string') {
    throw new LibraryPathError('Il percorso relativo della libreria deve essere una stringa.');
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed === '.') {
    if (allowRoot) return '';
    throw new LibraryPathError('Il percorso relativo della libreria è vuoto.');
  }
  if (trimmed.includes('\0')) {
    throw new LibraryPathError('Il percorso contiene un carattere NUL non valido.');
  }
  if (isAbsoluteOnAnyPlatform(trimmed)) {
    throw new LibraryPathError(
      `Il database non può contenere un percorso assoluto della libreria: ${trimmed}`,
      'ABSOLUTE_LIBRARY_PATH',
      { value: trimmed },
    );
  }

  const segments = trimmed.replaceAll('\\', '/').split('/');
  const normalized = [];
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      throw new LibraryPathError(
        `Il percorso tenta di uscire dalla libreria: ${trimmed}`,
        'LIBRARY_PATH_TRAVERSAL',
        { value: trimmed },
      );
    }
    normalized.push(segment);
  }

  if (!normalized.length) {
    if (allowRoot) return '';
    throw new LibraryPathError('Il percorso relativo della libreria è vuoto.');
  }
  return normalized.join('/');
}

function isInsideDirectory(rootPath, candidatePath) {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertInsideLibrary(candidatePath, { libraryRoot = config.libraryPath, allowRoot = true } = {}) {
  const root = configuredLibraryRoot(libraryRoot);
  const candidate = path.resolve(String(candidatePath || ''));
  if (!isInsideDirectory(root, candidate) || (!allowRoot && candidate === root)) {
    throw new LibraryPathError(
      `Il percorso risolto è esterno alla libreria configurata: ${candidate}`,
      'PATH_OUTSIDE_LIBRARY',
      { libraryRoot: root, candidatePath: candidate },
    );
  }
  return candidate;
}

function resolveLibraryPath(relativePath, { libraryRoot = config.libraryPath, allowRoot = false } = {}) {
  const root = configuredLibraryRoot(libraryRoot);
  const normalized = normalizeLibraryRelativePath(relativePath, { allowRoot });
  const candidate = normalized
    ? path.resolve(root, ...normalized.split('/'))
    : root;
  return assertInsideLibrary(candidate, { libraryRoot: root, allowRoot: true });
}

function toLibraryRelativePath(absolutePath, { libraryRoot = config.libraryPath, allowRoot = false } = {}) {
  const root = configuredLibraryRoot(libraryRoot);
  const candidateValue = String(absolutePath || '').trim();
  if (!candidateValue || !isAbsoluteOnAnyPlatform(candidateValue)) {
    throw new LibraryPathError(
      `È richiesto un percorso assoluto da convertire: ${candidateValue || '(vuoto)'}`,
      'ABSOLUTE_PATH_REQUIRED',
    );
  }

  const candidate = assertInsideLibrary(candidateValue, { libraryRoot: root, allowRoot: true });
  const relative = path.relative(root, candidate).split(path.sep).join('/');
  return normalizeLibraryRelativePath(relative, { allowRoot });
}

async function nearestExistingAncestor(candidatePath) {
  let current = path.resolve(candidatePath);
  while (true) {
    try {
      await fs.lstat(current);
      return current;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function assertRealPathInsideLibrary(
  candidatePath,
  { libraryRoot = config.libraryPath, allowMissing = false, allowRoot = true } = {},
) {
  const root = configuredLibraryRoot(libraryRoot);
  const candidate = assertInsideLibrary(candidatePath, { libraryRoot: root, allowRoot });
  const realRoot = await fs.realpath(root);

  let checkedPath = candidate;
  if (allowMissing) checkedPath = await nearestExistingAncestor(candidate);
  const realCandidate = await fs.realpath(checkedPath);

  if (!isInsideDirectory(realRoot, realCandidate)) {
    throw new LibraryPathError(
      `Il percorso attraversa un collegamento esterno alla libreria: ${candidate}`,
      'LIBRARY_SYMLINK_ESCAPE',
      { libraryRoot: realRoot, candidatePath: realCandidate },
    );
  }
  return candidate;
}

async function resolveLibraryPathForWrite(relativePath, options = {}) {
  const candidate = resolveLibraryPath(relativePath, options);
  await assertRealPathInsideLibrary(candidate, { ...options, allowMissing: true });
  return candidate;
}

module.exports = {
  LibraryPathError,
  normalizeLibraryRelativePath,
  resolveLibraryPath,
  resolveLibraryPathForWrite,
  toLibraryRelativePath,
  assertInsideLibrary,
  assertRealPathInsideLibrary,
  isInsideDirectory,
};
