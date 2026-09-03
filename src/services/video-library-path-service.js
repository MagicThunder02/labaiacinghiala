'use strict';

const path = require('node:path');
const {
  normalizeLibraryRelativePath,
  resolveLibraryPath,
  toLibraryRelativePath,
} = require('./library-path-service');

function portableBasename(value) {
  const text = String(value || '').trim().replaceAll('\\', '/');
  if (!text) return null;
  const name = path.posix.basename(text);
  return name && name !== '.' && name !== '..' ? name : null;
}

function portableDirname(relativePath) {
  const normalized = normalizeLibraryRelativePath(relativePath);
  const directory = path.posix.dirname(normalized);
  return directory === '.' ? '' : directory;
}

function joinPortable(...parts) {
  return normalizeLibraryRelativePath(
    parts.filter((part) => String(part || '').trim()).join('/'),
  );
}

function storedPathToRelative(
  storedPath,
  { anchorRelativePath = null, anchorIsDirectory = false, fallbackFileName = null } = {},
) {
  const value = String(storedPath || '').trim();
  if (value) {
    try {
      const normalized = normalizeLibraryRelativePath(value);
      if (anchorRelativePath && !normalized.includes('/')) {
        const anchor = normalizeLibraryRelativePath(anchorRelativePath);
        const directory = anchorIsDirectory ? anchor : portableDirname(anchor);
        return joinPortable(directory, normalized);
      }
      return normalized;
    } catch (error) {
      if (error?.code !== 'ABSOLUTE_LIBRARY_PATH') throw error;
      const name = portableBasename(value);
      if (!name || !anchorRelativePath) throw error;
      const anchor = normalizeLibraryRelativePath(anchorRelativePath);
      const directory = anchorIsDirectory ? anchor : portableDirname(anchor);
      return joinPortable(directory, name);
    }
  }

  if (!fallbackFileName || !anchorRelativePath) return null;
  const anchor = normalizeLibraryRelativePath(anchorRelativePath);
  const directory = anchorIsDirectory ? anchor : portableDirname(anchor);
  return joinPortable(directory, portableBasename(fallbackFileName));
}

function resolveStoredLibraryPath(storedPath, options = {}) {
  const relativePath = storedPathToRelative(storedPath, options);
  return relativePath ? resolveLibraryPath(relativePath) : null;
}

function relativePathFromAbsolute(absolutePath) {
  return normalizeLibraryRelativePath(toLibraryRelativePath(absolutePath));
}

function movieFilePath(row) {
  return resolveLibraryPath(row.relativePath ?? row.relative_path);
}

function movieMetadataPath(row) {
  const relativePath = row.relativePath ?? row.relative_path;
  const fallback = row.mediaType === 'series' || row.media_type === 'series'
    ? `${path.posix.basename(String(relativePath).replaceAll('\\', '/'), path.posix.extname(String(relativePath).replaceAll('\\', '/')))}.metadata.json`
    : 'metadata.json';
  return resolveStoredLibraryPath(row.metadataPath ?? row.metadata_path, {
    anchorRelativePath: relativePath,
    fallbackFileName: fallback,
  });
}

function moviePosterPath(row) {
  return resolveStoredLibraryPath(row.posterPath ?? row.poster_path, {
    anchorRelativePath: row.relativePath ?? row.relative_path,
  });
}

function seriesDirectoryPath(row) {
  return resolveLibraryPath(row.relativePath ?? row.relative_path);
}

function seriesMetadataPath(row) {
  return resolveStoredLibraryPath(row.metadataPath ?? row.metadata_path, {
    anchorRelativePath: row.relativePath ?? row.relative_path,
    anchorIsDirectory: true,
    fallbackFileName: 'metadata.json',
  });
}

function seriesPosterPath(row) {
  return resolveStoredLibraryPath(row.posterPath ?? row.poster_path, {
    anchorRelativePath: row.relativePath ?? row.relative_path,
    anchorIsDirectory: true,
  });
}

module.exports = {
  portableBasename,
  portableDirname,
  joinPortable,
  storedPathToRelative,
  resolveStoredLibraryPath,
  relativePathFromAbsolute,
  movieFilePath,
  movieMetadataPath,
  moviePosterPath,
  seriesDirectoryPath,
  seriesMetadataPath,
  seriesPosterPath,
};
