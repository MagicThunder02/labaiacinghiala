'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const fsConstants = require('node:fs').constants;
const path = require('node:path');
const config = require('../config');
const db = require('../database');
const { getMusicFormat } = require('../music-formats');
const {
  MusicImportError,
  buildMusicStoragePlan,
  buildTrackMetadataValues,
} = require('./music-import-service');
const {
  MusicTagError,
  readMusicFileMetadata,
  updateMusicFileTags,
} = require('./music-tag-service');
const { withMusicMetadataEditLock } = require('./music-metadata-edit-lock');
const { musicTrackPath, musicCoverCachePath } = require('./music-library-path-service');

class MusicMetadataEditError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'MusicMetadataEditError';
    this.code = code;
    this.statusCode = options.statusCode || 422;
    this.contentPreserved = options.contentPreserved !== false;
  }
}


const findTrack = db.prepare(`
  SELECT t.id, t.track_uuid AS trackUuid, t.album_id AS albumId,
         t.file_path AS filePath, t.relative_path AS relativePath,
         t.file_name AS fileName, t.available,
         a.album_uuid AS albumUuid, a.directory_path AS albumDirectory,
         a.cover_cache_path AS albumCoverCachePath,
         a.title AS albumTitle, a.album_artists_json AS albumArtistsJson
  FROM music_tracks t
  JOIN music_albums a ON a.id = t.album_id
  WHERE t.track_uuid = ?
  LIMIT 1
`);

const findTrackAtPath = db.prepare(`
  SELECT id, track_uuid AS trackUuid
  FROM music_tracks
  WHERE relative_path = ? COLLATE NOCASE
  LIMIT 1
`);

const findAlbumAtDirectory = db.prepare(`
  SELECT id, album_uuid AS albumUuid, title,
         directory_path AS directoryPath, relative_path AS relativePath,
         album_artists_json AS albumArtistsJson,
         genres_json AS genresJson, year, compilation,
         cover_cache_path AS coverCachePath
  FROM music_albums
  WHERE relative_path = ? COLLATE NOCASE
  LIMIT 1
`);

const insertArtist = db.prepare(`
  INSERT INTO music_artists (artist_uuid, name, updated_at)
  VALUES (?, ?, STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'))
`);

const findArtist = db.prepare(`
  SELECT id, artist_uuid AS artistUuid, name
  FROM music_artists
  WHERE name = ? COLLATE NOCASE
  LIMIT 1
`);

const insertAlbum = db.prepare(`
  INSERT INTO music_albums (
    album_uuid, title, directory_path, relative_path, album_artists_json,
    genres_json, year, compilation, cover_cache_path, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'))
`);

const updateAlbumIdentity = db.prepare(`
  UPDATE music_albums SET
    title = ?, directory_path = ?, relative_path = ?, album_artists_json = ?,
    cover_cache_path = NULL,
    updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = ?
`);

const clearAlbumCoverCache = db.prepare(`
  UPDATE music_albums SET
    cover_cache_path = NULL,
    updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = ?
`);

const deleteAlbumArtists = db.prepare(`
  DELETE FROM music_album_artists WHERE album_id = ?
`);

const insertAlbumArtist = db.prepare(`
  INSERT INTO music_album_artists (album_id, artist_id, position)
  VALUES (?, ?, ?)
`);

const deleteTrackArtists = db.prepare(`
  DELETE FROM music_track_artists WHERE track_id = ?
`);

const insertTrackArtist = db.prepare(`
  INSERT INTO music_track_artists (track_id, artist_id, position)
  VALUES (?, ?, ?)
`);

const updateTrack = db.prepare(`
  UPDATE music_tracks SET
    album_id = ?, file_path = ?, relative_path = ?, file_name = ?, title = ?,
    artists_json = ?, genres_json = ?, composers_json = ?, comment = ?,
    date_text = ?, year = ?, track_number = ?, track_total = ?, disc_number = ?,
    disc_total = ?, compilation = ?, extension = ?, mime_type = ?,
    duration_seconds = ?, duration_ms = ?, bitrate_kbps = ?, sample_rate_hz = ?,
    channels = ?, bits_per_sample = ?, codec = ?, container_format = ?,
    is_lossless = ?, bitrate_mode = ?, size_bytes = ?, modified_at = ?,
    has_cover_art = ?, available = 1,
    last_seen_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'),
    missing_since = NULL,
    updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = ?
`);

const countAlbumTracks = db.prepare(`
  SELECT COUNT(*) AS count FROM music_tracks WHERE album_id = ?
`);

const listAlbumTrackAggregates = db.prepare(`
  SELECT genres_json AS genresJson, year, compilation
  FROM music_tracks
  WHERE album_id = ?
  ORDER BY COALESCE(disc_number, 1), COALESCE(track_number, 999999), id
`);

const updateAlbumAggregates = db.prepare(`
  UPDATE music_albums SET
    genres_json = ?, year = ?, compilation = ?,
    updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = ?
`);

const deleteAlbum = db.prepare(`
  DELETE FROM music_albums WHERE id = ?
`);

const deleteOrphanArtists = db.prepare(`
  DELETE FROM music_artists
  WHERE NOT EXISTS (
    SELECT 1 FROM music_album_artists aa WHERE aa.artist_id = music_artists.id
  ) AND NOT EXISTS (
    SELECT 1 FROM music_track_artists ta WHERE ta.artist_id = music_artists.id
  )
`);

function normalizedKey(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('it');
}

function parseJsonList(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.map((item) => String(item || '').trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function sameTextList(left, right) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => normalizedKey(value) === normalizedKey(right[index]));
}

function mergeTextLists(...lists) {
  const result = [];
  const seen = new Set();
  for (const list of lists) {
    for (const item of Array.isArray(list) ? list : []) {
      const text = String(item || '').trim();
      const key = normalizedKey(text);
      if (!text || seen.has(key)) continue;
      seen.add(key);
      result.push(text);
    }
  }
  return result;
}

function pathKey(value) {
  return path.resolve(value).replaceAll('/', path.sep).toLocaleLowerCase('en-US');
}

function samePath(left, right) {
  return pathKey(left) === pathKey(right);
}

function isInsideDirectory(parentDirectory, candidatePath) {
  const parent = path.resolve(parentDirectory);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(parent, candidate);
  return Boolean(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function temporarySiblingPath(filePath, label) {
  const parsed = path.parse(filePath);
  const token = `${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
  return path.join(parsed.dir, `.${parsed.name}.baia-${label}-${token}${parsed.ext}`);
}

async function pathExists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function assertTrackFile(track) {
  if (!track) {
    throw new MusicMetadataEditError(
      'MUSIC_METADATA_TRACK_NOT_FOUND',
      'Brano musicale non trovato.',
      { statusCode: 404 },
    );
  }

  const filePath = musicTrackPath(track);
  if (!isInsideDirectory(config.mediaPaths.music, filePath)) {
    throw new MusicMetadataEditError(
      'MUSIC_METADATA_PATH_INVALID',
      'Il file indicizzato non appartiene alla libreria musicale.',
      { statusCode: 409 },
    );
  }
  if (!getMusicFormat(filePath)) {
    throw new MusicMetadataEditError(
      'UNSUPPORTED_MUSIC_FORMAT',
      'Formato musicale non supportato. Sono ammessi soltanto MP3, FLAC e WAV.',
      { statusCode: 422 },
    );
  }

  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) throw new Error('not-file');
  } catch (error) {
    throw new MusicMetadataEditError(
      'MUSIC_METADATA_FILE_MISSING',
      'Il file musicale indicizzato non è disponibile sul server.',
      { statusCode: 404, cause: error },
    );
  }

  return filePath;
}

function serializeEmbeddedMetadata(track, metadata, options = {}) {
  return {
    trackId: track.trackUuid,
    albumId: options.albumUuid || track.albumUuid,
    kind: 'music-track',
    fileName: options.fileName || track.fileName,
    current: {
      title: metadata.tags.title,
      artists: [...metadata.tags.artists],
      album: metadata.tags.album,
      albumArtists: [...metadata.tags.albumArtists],
      genres: [...metadata.tags.genres],
      composers: [...metadata.tags.composers],
      comment: metadata.tags.comment,
      date: metadata.tags.date,
      year: metadata.tags.year,
      trackNumber: metadata.tags.trackNumber,
      trackTotal: metadata.tags.trackTotal,
      discNumber: metadata.tags.discNumber,
      discTotal: metadata.tags.discTotal,
      compilation: metadata.tags.compilation === true,
    },
    properties: { ...metadata.properties },
    pictures: (metadata.pictures || []).map((picture) => ({ ...picture })),
    hasCoverArt: metadata.hasCoverArt === true,
    coverUrl: `/api/music/albums/${encodeURIComponent(options.albumUuid || track.albumUuid)}/cover`,
    destinationChanged: options.destinationChanged === true,
  };
}

function ensureArtist(name) {
  const existing = findArtist.get(name);
  if (existing) return existing;
  const artistUuid = crypto.randomUUID();
  const id = Number(insertArtist.run(artistUuid, name).lastInsertRowid);
  return { id, artistUuid, name };
}

function replaceAlbumArtistRows(albumId, artists) {
  deleteAlbumArtists.run(albumId);
  for (const [position, artist] of artists.entries()) {
    insertAlbumArtist.run(albumId, artist.id, position);
  }
}

function replaceTrackArtistRows(trackId, artists) {
  deleteTrackArtists.run(trackId);
  for (const [position, artist] of artists.entries()) {
    insertTrackArtist.run(trackId, artist.id, position);
  }
}

function refreshAlbumAggregates(albumId) {
  const rows = listAlbumTrackAggregates.all(albumId);
  const genres = mergeTextLists(...rows.map((row) => parseJsonList(row.genresJson)));
  const years = rows.map((row) => row.year).filter((value) => Number.isInteger(value));
  const year = years.length && years.every((value) => value === years[0]) ? years[0] : null;
  const compilation = rows.some((row) => Number(row.compilation) === 1) ? 1 : 0;
  updateAlbumAggregates.run(JSON.stringify(genres), year, compilation, albumId);
}

function ensureDestinationAlbum(track, plan, metadata) {
  const destinationDirectory = path.resolve(plan.albumDirectory);
  const existing = findAlbumAtDirectory.get(plan.albumRelativePath);
  const albumArtistRows = plan.albumArtists.map(ensureArtist);
  const oldAlbumTrackCount = Number(countAlbumTracks.get(track.albumId).count);

  if (existing) {
    const storedArtists = parseJsonList(existing.albumArtistsJson);
    const sameAlbum = Number(existing.id) === Number(track.albumId);
    const identityChanged = normalizedKey(existing.title) !== normalizedKey(plan.album)
      || !sameTextList(storedArtists, plan.albumArtists);

    if (sameAlbum) {
      if (identityChanged && oldAlbumTrackCount > 1) {
        throw new MusicMetadataEditError(
          'MUSIC_METADATA_SHARED_ALBUM_COLLISION',
          'La modifica produrrebbe la stessa cartella di un album condiviso da più brani. Modifica l’intero album oppure scegli metadati che generino una nuova destinazione.',
          { statusCode: 409 },
        );
      }
      updateAlbumIdentity.run(
        plan.album,
        plan.albumRelativePath,
        plan.albumRelativePath,
        JSON.stringify(plan.albumArtists),
        existing.id,
      );
      replaceAlbumArtistRows(existing.id, albumArtistRows);
    } else {
      if (identityChanged) {
        throw new MusicMetadataEditError(
          'MUSIC_METADATA_ALBUM_COLLISION',
          'La destinazione appartiene già a un album con titolo o artista album differenti.',
          { statusCode: 409 },
        );
      }
      clearAlbumCoverCache.run(existing.id);
    }

    return {
      id: Number(existing.id),
      albumUuid: existing.albumUuid,
      coverCachePath: existing.coverCachePath,
    };
  }

  const albumUuid = crypto.randomUUID();
  const id = Number(insertAlbum.run(
    albumUuid,
    plan.album,
    plan.albumRelativePath,
    plan.albumRelativePath,
    JSON.stringify(plan.albumArtists),
    JSON.stringify(metadata.tags.genres || []),
    metadata.tags.year == null ? null : Number(metadata.tags.year),
    metadata.tags.compilation === true ? 1 : 0,
  ).lastInsertRowid);
  replaceAlbumArtistRows(id, albumArtistRows);
  return { id, albumUuid, coverCachePath: null };
}

function updateCatalog(track, plan, metadata, stats) {
  const destinationPath = path.resolve(plan.destinationPath);
  const conflictingTrack = findTrackAtPath.get(plan.relativePath);
  if (conflictingTrack && Number(conflictingTrack.id) !== Number(track.id)) {
    throw new MusicMetadataEditError(
      'MUSIC_METADATA_DESTINATION_CATALOG_CONFLICT',
      'Un altro brano del catalogo usa già la destinazione calcolata.',
      { statusCode: 409 },
    );
  }

  const destinationAlbum = ensureDestinationAlbum(track, plan, metadata);
  const trackArtists = plan.artists.map(ensureArtist);
  const values = buildTrackMetadataValues(destinationAlbum.id, plan, metadata, stats);
  updateTrack.run(
    values[0],
    plan.relativePath,
    ...values.slice(1),
    track.id,
  );
  replaceTrackArtistRows(track.id, trackArtists);
  refreshAlbumAggregates(destinationAlbum.id);

  const coverPaths = new Set();
  if (track.albumCoverCachePath) coverPaths.add(musicCoverCachePath(track.albumCoverCachePath));
  if (destinationAlbum.coverCachePath) coverPaths.add(musicCoverCachePath(destinationAlbum.coverCachePath));
  clearAlbumCoverCache.run(destinationAlbum.id);

  if (Number(track.albumId) !== Number(destinationAlbum.id)) {
    const remaining = Number(countAlbumTracks.get(track.albumId).count);
    if (remaining === 0) {
      deleteAlbum.run(track.albumId);
    } else {
      clearAlbumCoverCache.run(track.albumId);
      refreshAlbumAggregates(track.albumId);
    }
  }

  deleteOrphanArtists.run();
  return { destinationAlbum, coverPaths };
}

async function removeCoverCacheFiles(paths) {
  for (const candidate of paths) {
    if (!candidate || !isInsideDirectory(config.musicCoverCachePath, candidate)) continue;
    await fs.rm(candidate, { force: true }).catch(() => {});
  }
}

async function removeEmptyMusicParents(startDirectory) {
  const stop = path.resolve(config.mediaPaths.music);
  let current = path.resolve(startDirectory);
  while (current !== stop && isInsideDirectory(stop, current)) {
    try {
      await fs.rmdir(current);
    } catch {
      break;
    }
    current = path.dirname(current);
  }
}

async function getMusicTrackEmbeddedMetadata(trackId, options = {}) {
  const track = findTrack.get(String(trackId || '').trim());
  const filePath = await assertTrackFile(track);
  const metadataReader = options.metadataReader || readMusicFileMetadata;
  try {
    const metadata = await metadataReader(filePath);
    return serializeEmbeddedMetadata(track, metadata);
  } catch (error) {
    if (error instanceof MusicMetadataEditError) throw error;
    if (error instanceof MusicTagError) {
      throw new MusicMetadataEditError(error.code, error.message, {
        statusCode: 422,
        cause: error,
      });
    }
    throw error;
  }
}

async function updateMusicTrackEmbeddedMetadata(trackId, changes, options = {}) {
  return withMusicMetadataEditLock(async () => {
    const track = findTrack.get(String(trackId || '').trim());
    const originalPath = await assertTrackFile(track);
    const metadataUpdater = options.metadataUpdater || updateMusicFileTags;
    const stagedPath = temporarySiblingPath(originalPath, 'metadata-stage');
    const backupPath = temporarySiblingPath(originalPath, 'metadata-backup');
    let destinationPath = null;
    let originalMoved = false;
    let stagedInstalled = false;
    let transactionOpen = false;
    let databaseCommitted = false;

    try {
      await fs.copyFile(originalPath, stagedPath, fsConstants.COPYFILE_EXCL);
      const metadata = await metadataUpdater(stagedPath, changes);
      const plan = buildMusicStoragePlan(metadata);
      destinationPath = path.resolve(plan.destinationPath);
      const sameLocation = samePath(originalPath, destinationPath);

      if (!sameLocation && await pathExists(destinationPath)) {
        throw new MusicMetadataEditError(
          'MUSIC_METADATA_DESTINATION_EXISTS',
          `Esiste già il file “${plan.fileName}” nella destinazione calcolata.`,
          { statusCode: 409 },
        );
      }

      const conflictingTrack = findTrackAtPath.get(plan.relativePath);
      if (conflictingTrack && Number(conflictingTrack.id) !== Number(track.id)) {
        throw new MusicMetadataEditError(
          'MUSIC_METADATA_DESTINATION_CATALOG_CONFLICT',
          'Un altro brano del catalogo usa già la destinazione calcolata.',
          { statusCode: 409 },
        );
      }

      await fs.mkdir(path.dirname(destinationPath), { recursive: true });
      await fs.rename(originalPath, backupPath);
      originalMoved = true;
      await fs.rename(stagedPath, destinationPath);
      stagedInstalled = true;
      const stats = await fs.stat(destinationPath);

      db.exec('BEGIN IMMEDIATE');
      transactionOpen = true;
      const catalogResult = updateCatalog(track, plan, metadata, stats);
      if (typeof options.beforeDatabaseCommit === 'function') {
        options.beforeDatabaseCommit({ track, plan, metadata });
      }
      db.exec('COMMIT');
      transactionOpen = false;
      databaseCommitted = true;

      await fs.rm(backupPath, { force: true }).catch(() => {});
      await removeCoverCacheFiles(catalogResult.coverPaths);
      if (!samePath(path.dirname(originalPath), path.dirname(destinationPath))) {
        await removeEmptyMusicParents(path.dirname(originalPath));
      }

      return serializeEmbeddedMetadata(track, metadata, {
        albumUuid: catalogResult.destinationAlbum.albumUuid,
        fileName: plan.fileName,
        destinationChanged: path.resolve(originalPath) !== destinationPath,
      });
    } catch (error) {
      if (transactionOpen) {
        try { db.exec('ROLLBACK'); } catch {}
      }

      if (!databaseCommitted) {
        if (stagedInstalled && destinationPath) {
          await fs.rm(destinationPath, { force: true }).catch(() => {});
        }
        if (originalMoved) {
          try {
            await fs.rename(backupPath, originalPath);
          } catch (rollbackError) {
            throw new MusicMetadataEditError(
              'MUSIC_METADATA_ROLLBACK_FAILED',
              `I metadati non sono stati salvati e il ripristino automatico del file non è riuscito: ${error.message}`,
              { statusCode: 500, contentPreserved: false, cause: rollbackError },
            );
          }
        }
        if (destinationPath) await removeEmptyMusicParents(path.dirname(destinationPath));
      }

      await fs.rm(stagedPath, { force: true }).catch(() => {});
      await fs.rm(backupPath, { force: true }).catch(() => {});

      if (error instanceof MusicMetadataEditError) throw error;
      if (error instanceof MusicImportError) {
        throw new MusicMetadataEditError(error.code, error.message, {
          statusCode: error.statusCode,
          cause: error,
        });
      }
      if (error instanceof MusicTagError) {
        const statusCode = /INVALID|EMPTY/.test(error.code) ? 400 : 422;
        throw new MusicMetadataEditError(error.code, error.message, { statusCode, cause: error });
      }
      throw new MusicMetadataEditError(
        'MUSIC_METADATA_UPDATE_FAILED',
        `Impossibile aggiornare i metadati reali del brano: ${error.message}`,
        { statusCode: 500, cause: error },
      );
    } finally {
      await fs.rm(stagedPath, { force: true }).catch(() => {});
    }
  });
}

module.exports = {
  MusicMetadataEditError,
  getMusicTrackEmbeddedMetadata,
  serializeEmbeddedMetadata,
  updateMusicTrackEmbeddedMetadata,
};
