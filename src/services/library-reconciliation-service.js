const fs = require('node:fs/promises');
const path = require('node:path');
const db = require('../database');
const { checkLibraryStorage } = require('./library-storage-service');
const { resolveLibraryPath } = require('./library-path-service');
const { readingFilePath } = require('./reading-library-path-service');
const { musicTrackPath } = require('./music-library-path-service');

const getKnownContents = db.prepare(`
  SELECT id, relative_path AS relativePath, available, size_bytes AS sizeBytes, modified_at AS modifiedAt
  FROM movies
`);
const getKnownSeries = db.prepare(`
  SELECT id, relative_path AS relativePath, available
  FROM series
`);
const getKnownReadingItems = db.prepare(`
  SELECT id, category, relative_path AS relativePath, file_path AS filePath,
         available, size_bytes AS sizeBytes, modified_at AS modifiedAt
  FROM reading_items
`);
const getKnownMusicTracks = db.prepare(`
  SELECT id, relative_path AS relativePath, available, size_bytes AS sizeBytes, modified_at AS modifiedAt
  FROM music_tracks
`);
const setContentAvailable = db.prepare(`
  UPDATE movies SET
    available = 1,
    size_bytes = ?,
    modified_at = ?,
    last_seen_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'),
    missing_since = NULL,
    updated_at = CASE
      WHEN available <> 1 OR size_bytes <> ? OR modified_at <> ?
      THEN STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
      ELSE updated_at
    END
  WHERE id = ?
`);
const setContentUnavailable = db.prepare(`
  UPDATE movies SET
    available = 0,
    missing_since = COALESCE(missing_since, STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at = CASE
      WHEN available <> 0 THEN STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
      ELSE updated_at
    END
  WHERE id = ?
`);
const setReadingAvailable = db.prepare(`
  UPDATE reading_items SET
    available = 1,
    size_bytes = ?,
    modified_at = ?,
    last_seen_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'),
    missing_since = NULL,
    updated_at = CASE
      WHEN available <> 1 OR size_bytes <> ? OR modified_at <> ?
      THEN STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
      ELSE updated_at
    END
  WHERE id = ?
`);
const setReadingUnavailable = db.prepare(`
  UPDATE reading_items SET
    available = 0,
    missing_since = COALESCE(missing_since, STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at = CASE
      WHEN available <> 0 THEN STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
      ELSE updated_at
    END
  WHERE id = ?
`);
const setMusicTrackAvailable = db.prepare(`
  UPDATE music_tracks SET
    available = 1,
    size_bytes = ?,
    modified_at = ?,
    last_seen_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'),
    missing_since = NULL,
    updated_at = CASE
      WHEN available <> 1 OR size_bytes <> ? OR modified_at <> ?
      THEN STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
      ELSE updated_at
    END
  WHERE id = ?
`);
const setMusicTrackUnavailable = db.prepare(`
  UPDATE music_tracks SET
    available = 0,
    missing_since = COALESCE(missing_since, STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at = CASE
      WHEN available <> 0 THEN STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
      ELSE updated_at
    END
  WHERE id = ?
`);
const setSeriesAvailable = db.prepare(`
  UPDATE series SET
    available = 1,
    last_seen_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'),
    missing_since = NULL,
    updated_at = CASE
      WHEN available <> 1 THEN STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
      ELSE updated_at
    END
  WHERE id = ?
`);
const setSeriesUnavailable = db.prepare(`
  UPDATE series SET
    available = 0,
    missing_since = COALESCE(missing_since, STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at = CASE
      WHEN available <> 0 THEN STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
      ELSE updated_at
    END
  WHERE id = ?
`);
const countAvailableEpisodes = db.prepare(`
  SELECT COUNT(*) AS count
  FROM movies
  WHERE media_type = 'series' AND series_uuid = (
    SELECT series_uuid FROM series WHERE id = ?
  ) AND available = 1
`);

async function fileStats(candidate) {
  try {
    const stats = await fs.stat(path.resolve(candidate));
    return stats.isFile() ? stats : null;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

async function directoryExists(candidate) {
  try {
    const stats = await fs.stat(path.resolve(candidate));
    return stats.isDirectory();
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

/**
 * Verifica esclusivamente i contenuti già presenti in SQLite.
 * Non percorre media/, non importa file sconosciuti, non legge/crea sidecar e non ricava metadati.
 */
async function reconcileLibraryAvailability() {
  const startedAt = Date.now();

  // Prima di toccare i record verifichiamo che l'archivio sia davvero leggibile e scrivibile.
  // Se il volume non è raggiungibile, conserviamo lo stato del catalogo invece di marcare tutto offline.
  const storage = await checkLibraryStorage();
  if (!storage.available) {
    return {
      checked: 0,
      available: 0,
      unavailable: 0,
      restored: 0,
      storageAvailable: false,
      storageError: storage.error,
      elapsedMs: Date.now() - startedAt,
    };
  }

  const contents = getKnownContents.all();
  let available = 0;
  let unavailable = 0;
  let restored = 0;

  for (const row of contents) {
    const stats = await fileStats(resolveLibraryPath(row.relativePath));
    if (!stats) {
      if (Number(row.available) === 1) unavailable += 1;
      setContentUnavailable.run(row.id);
      continue;
    }

    if (Number(row.available) === 0) restored += 1;
    available += 1;
    const size = Number(stats.size || 0);
    const modifiedAt = Math.trunc(stats.mtimeMs);
    setContentAvailable.run(size, modifiedAt, size, modifiedAt, row.id);
  }

  const readingItems = getKnownReadingItems.all();
  for (const row of readingItems) {
    const stats = await fileStats(readingFilePath(row));
    if (!stats) {
      if (Number(row.available) === 1) unavailable += 1;
      setReadingUnavailable.run(row.id);
      continue;
    }

    if (Number(row.available) === 0) restored += 1;
    available += 1;
    const size = Number(stats.size || 0);
    const modifiedAt = Math.trunc(stats.mtimeMs);
    setReadingAvailable.run(size, modifiedAt, size, modifiedAt, row.id);
  }

  const musicTracks = getKnownMusicTracks.all();
  for (const row of musicTracks) {
    const stats = await fileStats(musicTrackPath(row));
    if (!stats) {
      if (Number(row.available) === 1) unavailable += 1;
      setMusicTrackUnavailable.run(row.id);
      continue;
    }

    if (Number(row.available) === 0) restored += 1;
    available += 1;
    const size = Number(stats.size || 0);
    const modifiedAt = Math.trunc(stats.mtimeMs);
    setMusicTrackAvailable.run(size, modifiedAt, size, modifiedAt, row.id);
  }

  // Una serie è disponibile solo se la sua directory esiste e possiede almeno un episodio disponibile.
  for (const row of getKnownSeries.all()) {
    const directoryPresent = await directoryExists(resolveLibraryPath(row.relativePath));
    const episodeCount = directoryPresent ? Number(countAvailableEpisodes.get(row.id)?.count || 0) : 0;
    if (directoryPresent && episodeCount > 0) setSeriesAvailable.run(row.id);
    else setSeriesUnavailable.run(row.id);
  }

  return {
    checked: contents.length + readingItems.length + musicTracks.length,
    available,
    unavailable,
    restored,
    storageAvailable: true,
    elapsedMs: Date.now() - startedAt,
  };
}

module.exports = { reconcileLibraryAvailability };
