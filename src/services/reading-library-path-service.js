'use strict';

const path = require('node:path');
const {
  normalizeLibraryRelativePath,
  resolveLibraryPath,
  toLibraryRelativePath,
} = require('./library-path-service');
const {
  portableBasename,
  portableDirname,
  joinPortable,
  storedPathToRelative,
} = require('./video-library-path-service');

const READING_CATEGORY_DIRECTORIES = Object.freeze({
  books: 'Libri',
  comics: 'Fumetti',
  manga: 'Manga',
});

function categoryDirectory(category) {
  const directory = READING_CATEGORY_DIRECTORIES[String(category || '').trim()];
  if (!directory) {
    const error = new Error(`Categoria di lettura non valida: ${category || '(vuota)'}`);
    error.code = 'INVALID_READING_CATEGORY';
    throw error;
  }
  return directory;
}

function assertReadingCategoryPath(relativePath, category) {
  const normalized = normalizeLibraryRelativePath(relativePath);
  const expected = categoryDirectory(category);
  const firstSegment = normalized.split('/')[0];
  if (firstSegment.localeCompare(expected, 'it', { sensitivity: 'base' }) !== 0) {
    const error = new Error(
      `Il percorso “${normalized}” non appartiene alla cartella ${expected} prevista per la categoria ${category}.`,
    );
    error.code = 'READING_CATEGORY_PATH_MISMATCH';
    throw error;
  }
  return normalized;
}

function relativePathFromLegacyAbsolute(value, category) {
  const text = String(value || '').trim().replaceAll('\\', '/');
  if (!text) return null;
  const expected = categoryDirectory(category);
  const segments = text.split('/').filter(Boolean);
  const index = segments.findIndex(
    (segment) => segment.localeCompare(expected, 'it', { sensitivity: 'base' }) === 0,
  );
  if (index < 0 || index === segments.length - 1) return null;
  return assertReadingCategoryPath(segments.slice(index).join('/'), category);
}

function readingRelativePath(row) {
  const category = row.category;
  const storedRelative = row.relativePath ?? row.relative_path;
  if (String(storedRelative || '').trim()) {
    try {
      return assertReadingCategoryPath(storedRelative, category);
    } catch (error) {
      if (error?.code !== 'ABSOLUTE_LIBRARY_PATH') throw error;
      const recovered = relativePathFromLegacyAbsolute(storedRelative, category);
      if (recovered) return recovered;
    }
  }

  const recovered = relativePathFromLegacyAbsolute(row.filePath ?? row.file_path, category);
  if (recovered) return recovered;

  const error = new Error(
    `Impossibile ricostruire un percorso portabile per il contenuto di lettura ${row.id ?? row.content_uuid ?? '(sconosciuto)'}.`,
  );
  error.code = 'READING_PATH_NOT_PORTABLE';
  throw error;
}

function companionRelativePath(storedPath, row, { fallbackFileName = null, optional = false } = {}) {
  const fileRelativePath = readingRelativePath(row);
  if (!String(storedPath || '').trim() && optional && !fallbackFileName) return null;
  const relative = storedPathToRelative(storedPath, {
    anchorRelativePath: fileRelativePath,
    fallbackFileName,
  });
  if (!relative) return null;

  const itemDirectory = portableDirname(fileRelativePath);
  const companionDirectory = portableDirname(relative);
  if (itemDirectory.localeCompare(companionDirectory, 'it', { sensitivity: 'base' }) !== 0) {
    const error = new Error(
      `Il file associato “${relative}” è esterno alla cartella del contenuto “${fileRelativePath}”.`,
    );
    error.code = 'READING_COMPANION_PATH_MISMATCH';
    throw error;
  }
  return normalizeLibraryRelativePath(relative);
}

function readingFilePath(row) {
  return resolveLibraryPath(readingRelativePath(row));
}

function readingMetadataRelativePath(row) {
  return companionRelativePath(row.metadataPath ?? row.metadata_path, row, {
    fallbackFileName: 'metadata.json',
  });
}

function readingMetadataPath(row) {
  return resolveLibraryPath(readingMetadataRelativePath(row));
}

function readingCoverRelativePath(row) {
  return companionRelativePath(row.coverPath ?? row.cover_path, row, { optional: true });
}

function readingCoverPath(row) {
  const relative = readingCoverRelativePath(row);
  return relative ? resolveLibraryPath(relative) : null;
}

function relativeReadingPathFromAbsolute(absolutePath, category) {
  return assertReadingCategoryPath(toLibraryRelativePath(absolutePath), category);
}

function readingDirectoryRelativePath(row) {
  return portableDirname(readingRelativePath(row));
}

function readingDirectoryPath(row) {
  return resolveLibraryPath(readingDirectoryRelativePath(row));
}

function buildReadingRelativePath(category, ...parts) {
  return assertReadingCategoryPath(joinPortable(categoryDirectory(category), ...parts), category);
}

module.exports = {
  READING_CATEGORY_DIRECTORIES,
  categoryDirectory,
  assertReadingCategoryPath,
  relativePathFromLegacyAbsolute,
  readingRelativePath,
  readingFilePath,
  readingMetadataRelativePath,
  readingMetadataPath,
  readingCoverRelativePath,
  readingCoverPath,
  relativeReadingPathFromAbsolute,
  readingDirectoryRelativePath,
  readingDirectoryPath,
  buildReadingRelativePath,
  portableBasename,
};
