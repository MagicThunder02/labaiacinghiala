'use strict';

const path = require('node:path');
const config = require('../config');
const {
  normalizeLibraryRelativePath,
  resolveLibraryPath,
} = require('./library-path-service');

const MUSIC_DIRECTORY = 'Musica';
const MUSIC_COVER_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif']);

function assertMusicRelativePath(value, { allowRoot = false } = {}) {
  const normalized = normalizeLibraryRelativePath(value, { allowRoot });
  if (!normalized && allowRoot) return normalized;
  const first = normalized.split('/')[0];
  if (first.localeCompare(MUSIC_DIRECTORY, 'it', { sensitivity: 'base' }) !== 0) {
    const error = new Error(`Il percorso “${normalized}” non appartiene alla cartella ${MUSIC_DIRECTORY}.`);
    error.code = 'MUSIC_PATH_OUTSIDE_LIBRARY_SECTION';
    throw error;
  }
  return normalized;
}

function relativePathFromLegacyMusicAbsolute(value) {
  const text = String(value || '').trim().replaceAll('\\', '/');
  if (!text) return null;
  const segments = text.split('/').filter(Boolean);
  const index = segments.findIndex(
    (segment) => segment.localeCompare(MUSIC_DIRECTORY, 'it', { sensitivity: 'base' }) === 0,
  );
  if (index < 0 || index === segments.length - 1) return null;
  return assertMusicRelativePath(segments.slice(index).join('/'));
}

function musicRelativePath(row, { directory = false } = {}) {
  const candidates = [
    row?.relativePath,
    row?.relative_path,
    directory ? row?.directoryPath : row?.filePath,
    directory ? row?.directory_path : row?.file_path,
  ];

  for (const candidate of candidates) {
    if (!String(candidate || '').trim()) continue;
    try {
      return assertMusicRelativePath(candidate);
    } catch (error) {
      if (error?.code !== 'ABSOLUTE_LIBRARY_PATH') throw error;
      const recovered = relativePathFromLegacyMusicAbsolute(candidate);
      if (recovered) return recovered;
    }
  }

  const error = new Error(
    `Impossibile ricostruire un percorso musicale portabile per ${row?.id ?? row?.trackUuid ?? row?.albumUuid ?? '(record sconosciuto)'}.`,
  );
  error.code = 'MUSIC_PATH_NOT_PORTABLE';
  throw error;
}

function musicTrackRelativePath(row) {
  return musicRelativePath(row, { directory: false });
}

function musicAlbumRelativePath(row) {
  return musicRelativePath(row, { directory: true });
}

function musicTrackPath(row) {
  return resolveLibraryPath(musicTrackRelativePath(row));
}

function musicAlbumDirectoryPath(row) {
  return resolveLibraryPath(musicAlbumRelativePath(row));
}

function normalizeMusicCoverCacheKey(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (text.includes('\0')) {
    const error = new Error('La chiave della cache copertine contiene un carattere NUL.');
    error.code = 'INVALID_MUSIC_COVER_CACHE_KEY';
    throw error;
  }

  const normalized = text.replaceAll('\\', '/');
  const fileName = path.posix.basename(normalized);
  if (!fileName || fileName === '.' || fileName === '..') return null;
  if (normalized !== fileName && !path.win32.isAbsolute(text) && !path.posix.isAbsolute(text)) {
    const error = new Error('La cache musicale deve usare soltanto un nome file, non un percorso.');
    error.code = 'INVALID_MUSIC_COVER_CACHE_KEY';
    throw error;
  }
  const extension = path.extname(fileName).toLowerCase();
  if (!MUSIC_COVER_EXTENSIONS.has(extension)) return null;
  return fileName;
}

function musicCoverCachePath(key) {
  const normalized = normalizeMusicCoverCacheKey(key);
  return normalized ? path.join(config.musicCoverCachePath, normalized) : null;
}

function musicCoverCacheKey(albumUuid, extension) {
  const ext = String(extension || '').toLowerCase();
  if (!MUSIC_COVER_EXTENSIONS.has(ext)) {
    const error = new Error(`Estensione cache musicale non valida: ${extension || '(vuota)'}`);
    error.code = 'INVALID_MUSIC_COVER_CACHE_EXTENSION';
    throw error;
  }
  return `${String(albumUuid || '').trim()}${ext}`;
}

module.exports = {
  MUSIC_DIRECTORY,
  MUSIC_COVER_EXTENSIONS,
  assertMusicRelativePath,
  relativePathFromLegacyMusicAbsolute,
  musicRelativePath,
  musicTrackRelativePath,
  musicAlbumRelativePath,
  musicTrackPath,
  musicAlbumDirectoryPath,
  normalizeMusicCoverCacheKey,
  musicCoverCachePath,
  musicCoverCacheKey,
};
