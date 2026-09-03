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
  updateMusicFileCoverArt,
} = require('./music-tag-service');
const {
  MusicCoverEditError,
  normalizeMusicCoverChange,
} = require('./music-cover-edit-service');
const { withMusicMetadataEditLock } = require('./music-metadata-edit-lock');
const { musicTrackPath, musicCoverCachePath } = require('./music-library-path-service');

class MusicAlbumMetadataEditError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'MusicAlbumMetadataEditError';
    this.code = code;
    this.statusCode = options.statusCode || 422;
    this.contentPreserved = options.contentPreserved !== false;
  }
}

const findAlbum = db.prepare(`
  SELECT id, album_uuid AS albumUuid, title,
         directory_path AS directoryPath, relative_path AS relativePath,
         album_artists_json AS albumArtistsJson, genres_json AS genresJson,
         year, compilation, cover_cache_path AS coverCachePath
  FROM music_albums
  WHERE album_uuid = ?
  LIMIT 1
`);

const listAlbumTracks = db.prepare(`
  SELECT id, track_uuid AS trackUuid, album_id AS albumId,
         file_path AS filePath, relative_path AS relativePath,
         file_name AS fileName, title, available
  FROM music_tracks
  WHERE album_id = ? AND available = 1
  ORDER BY COALESCE(disc_number, 1), COALESCE(track_number, 999999), title COLLATE NOCASE, id
`);

const findTrackAtPath = db.prepare(`
  SELECT id, track_uuid AS trackUuid, album_id AS albumId
  FROM music_tracks
  WHERE relative_path = ? COLLATE NOCASE
  LIMIT 1
`);

const findAlbumAtDirectory = db.prepare(`
  SELECT id, album_uuid AS albumUuid
  FROM music_albums
  WHERE relative_path = ? COLLATE NOCASE
  LIMIT 1
`);

const findArtist = db.prepare(`
  SELECT id, artist_uuid AS artistUuid, name
  FROM music_artists
  WHERE name = ? COLLATE NOCASE
  LIMIT 1
`);

const insertArtist = db.prepare(`
  INSERT INTO music_artists (artist_uuid, name, updated_at)
  VALUES (?, ?, STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'))
`);

const updateAlbum = db.prepare(`
  UPDATE music_albums SET
    title = ?, directory_path = ?, relative_path = ?,
    album_artists_json = ?, genres_json = ?, year = ?, compilation = ?,
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

const deleteOrphanArtists = db.prepare(`
  DELETE FROM music_artists
  WHERE NOT EXISTS (
    SELECT 1 FROM music_album_artists aa WHERE aa.artist_id = music_artists.id
  ) AND NOT EXISTS (
    SELECT 1 FROM music_track_artists ta WHERE ta.artist_id = music_artists.id
  )
`);

function parseJsonList(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed)
      ? parsed.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function cleanText(value, maximum = 500) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum);
}

function normalizeTextList(value, options = {}) {
  const input = Array.isArray(value) ? value : (value == null ? [] : [value]);
  const maximum = options.maximum || 500;
  const maxItems = options.maxItems || 50;
  const result = [];
  const seen = new Set();
  for (const item of input) {
    const text = cleanText(item, maximum);
    const key = text.toLocaleLowerCase('it');
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
    if (result.length >= maxItems) break;
  }
  return result;
}

function nullablePositiveInteger(value, label, maximum = 100000) {
  if (value === '' || value == null) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new MusicAlbumMetadataEditError(
      'INVALID_MUSIC_ALBUM_TAGS',
      `${label} deve essere un intero compreso tra 1 e ${maximum}.`,
      { statusCode: 400 },
    );
  }
  return parsed;
}

function normalizeAlbumChanges(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new MusicAlbumMetadataEditError(
      'INVALID_MUSIC_ALBUM_TAGS',
      'Le modifiche dell’album devono essere un oggetto.',
      { statusCode: 400 },
    );
  }

  const album = cleanText(input.album, 500);
  if (!album) {
    throw new MusicAlbumMetadataEditError(
      'INVALID_MUSIC_ALBUM_TAGS',
      'Il titolo dell’album è obbligatorio.',
      { statusCode: 400 },
    );
  }
  const albumArtists = normalizeTextList(input.albumArtists ?? input.albumArtist, { maximum: 500 });
  if (!albumArtists.length) {
    throw new MusicAlbumMetadataEditError(
      'INVALID_MUSIC_ALBUM_TAGS',
      'È obbligatorio indicare almeno un artista album.',
      { statusCode: 400 },
    );
  }

  const genres = normalizeTextList(input.genres ?? input.genre, { maximum: 100, maxItems: 30 });
  const date = cleanText(input.date, 50);
  const year = nullablePositiveInteger(input.year, 'L’anno', 9999);
  const trackTotal = nullablePositiveInteger(input.trackTotal ?? input.totalTracks, 'Il totale tracce');
  const discTotal = nullablePositiveInteger(input.discTotal ?? input.totalDiscs, 'Il totale dischi');
  const compilation = input.compilation === true;
  const coverChange = normalizeMusicCoverChange(input);

  return { album, albumArtists, genres, date, year, trackTotal, discTotal, compilation, coverChange };
}

function normalizedKey(value) {
  return cleanText(value).toLocaleLowerCase('it');
}

function sameTextList(left, right) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => normalizedKey(value) === normalizedKey(right[index]));
}

function mergeTextLists(...lists) {
  return normalizeTextList(lists.flat(), { maximum: 100, maxItems: 30 });
}

function commonScalar(values, fallback = null) {
  if (!values.length) return fallback;
  const first = values[0];
  return values.every((value) => value === first) ? first : fallback;
}

function commonText(values, fallback = '') {
  if (!values.length) return fallback;
  const first = cleanText(values[0]);
  return values.every((value) => normalizedKey(value) === normalizedKey(first)) ? first : fallback;
}

function commonTextList(values, fallback = []) {
  if (!values.length) return [...fallback];
  const first = normalizeTextList(values[0]);
  return values.every((value) => sameTextList(first, normalizeTextList(value))) ? first : [...fallback];
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

async function assertAlbum(albumId) {
  const album = findAlbum.get(String(albumId || '').trim());
  if (!album) {
    throw new MusicAlbumMetadataEditError(
      'MUSIC_ALBUM_METADATA_NOT_FOUND',
      'Album musicale non trovato.',
      { statusCode: 404 },
    );
  }
  const tracks = listAlbumTracks.all(album.id);
  if (!tracks.length) {
    throw new MusicAlbumMetadataEditError(
      'MUSIC_ALBUM_METADATA_EMPTY',
      'L’album non contiene brani disponibili.',
      { statusCode: 409 },
    );
  }
  return { album, tracks };
}

async function assertTrackFile(track) {
  const filePath = musicTrackPath(track);
  if (!isInsideDirectory(config.mediaPaths.music, filePath)) {
    throw new MusicAlbumMetadataEditError(
      'MUSIC_ALBUM_METADATA_PATH_INVALID',
      'Un file indicizzato non appartiene alla libreria musicale.',
      { statusCode: 409 },
    );
  }
  if (!getMusicFormat(filePath)) {
    throw new MusicAlbumMetadataEditError(
      'UNSUPPORTED_MUSIC_FORMAT',
      'Formato musicale non supportato. Sono ammessi soltanto MP3, FLAC e WAV.',
      { statusCode: 422 },
    );
  }
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) throw new Error('not-file');
  } catch (error) {
    throw new MusicAlbumMetadataEditError(
      'MUSIC_ALBUM_METADATA_FILE_MISSING',
      `Il file “${track.fileName}” non è disponibile sul server.`,
      { statusCode: 404, cause: error },
    );
  }
  return filePath;
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

function serializeAlbumMetadata(album, entries, options = {}) {
  const metadataRows = entries.map((entry) => entry.metadata);
  const tags = metadataRows.map((metadata) => metadata.tags || {});
  const storedAlbumArtists = parseJsonList(album.albumArtistsJson);
  const storedGenres = parseJsonList(album.genresJson);
  const mixedFields = [];

  const albumValue = commonText(tags.map((item) => item.album), album.title || '');
  if (!tags.every((item) => normalizedKey(item.album) === normalizedKey(albumValue))) mixedFields.push('album');

  const albumArtists = commonTextList(tags.map((item) => item.albumArtists), storedAlbumArtists);
  if (!tags.every((item) => sameTextList(normalizeTextList(item.albumArtists), albumArtists))) mixedFields.push('albumArtists');

  const commonGenres = commonTextList(tags.map((item) => item.genres), []);
  const genres = commonGenres.length ? commonGenres : mergeTextLists(storedGenres, ...tags.map((item) => item.genres));
  if (!tags.every((item) => sameTextList(normalizeTextList(item.genres), commonGenres))) mixedFields.push('genres');

  const date = commonText(tags.map((item) => item.date), '');
  if (!tags.every((item) => normalizedKey(item.date) === normalizedKey(date))) mixedFields.push('date');

  const year = commonScalar(tags.map((item) => item.year), album.year == null ? null : Number(album.year));
  if (!tags.every((item) => item.year === year)) mixedFields.push('year');

  const maximumTrackNumber = Math.max(...tags.map((item) => Number(item.trackNumber) || 0), entries.length);
  const trackTotal = commonScalar(tags.map((item) => item.trackTotal), maximumTrackNumber || null);
  if (!tags.every((item) => item.trackTotal === trackTotal)) mixedFields.push('trackTotal');

  const maximumDiscNumber = Math.max(...tags.map((item) => Number(item.discNumber) || 1), 1);
  const discTotal = commonScalar(tags.map((item) => item.discTotal), maximumDiscNumber);
  if (!tags.every((item) => item.discTotal === discTotal)) mixedFields.push('discTotal');

  const compilation = commonScalar(tags.map((item) => item.compilation === true), Number(album.compilation) === 1);
  if (!tags.every((item) => (item.compilation === true) === compilation)) mixedFields.push('compilation');

  const hasCoverArt = entries.some((entry) => entry.metadata.hasCoverArt === true);
  return {
    albumId: album.albumUuid,
    kind: 'music-album',
    current: {
      album: albumValue,
      albumArtists,
      genres,
      date,
      year,
      trackTotal,
      discTotal,
      compilation,
    },
    mixedFields: [...new Set(mixedFields)],
    trackCount: entries.length,
    tracks: entries.map((entry) => ({
      trackId: entry.track.trackUuid,
      title: entry.metadata.tags.title,
      artists: [...entry.metadata.tags.artists],
      trackNumber: entry.metadata.tags.trackNumber,
      discNumber: entry.metadata.tags.discNumber,
      fileName: options.fileNames?.get(entry.track.id) || entry.track.fileName,
    })),
    hasCoverArt,
    coverUrl: hasCoverArt
      ? `/api/music/albums/${encodeURIComponent(album.albumUuid)}/cover`
      : null,
    destinationChanged: options.destinationChanged === true,
    coverChanged: options.coverChanged === true,
  };
}

async function readAlbumEntries(album, tracks, metadataReader) {
  const entries = [];
  for (const track of tracks) {
    const filePath = await assertTrackFile(track);
    const metadata = await metadataReader(filePath);
    entries.push({ track, filePath, metadata });
  }
  return entries;
}

async function getMusicAlbumEmbeddedMetadata(albumId, options = {}) {
  return withMusicMetadataEditLock(async () => {
    const { album, tracks } = await assertAlbum(albumId);
    const metadataReader = options.metadataReader || readMusicFileMetadata;
    try {
      const entries = await readAlbumEntries(album, tracks, metadataReader);
      return serializeAlbumMetadata(album, entries);
    } catch (error) {
      if (error instanceof MusicAlbumMetadataEditError) throw error;
      if (error instanceof MusicCoverEditError) {
        throw new MusicAlbumMetadataEditError(error.code, error.message, {
          statusCode: error.statusCode || 400,
          cause: error,
        });
      }
      if (error instanceof MusicTagError) {
        throw new MusicAlbumMetadataEditError(error.code, error.message, {
          statusCode: 422,
          cause: error,
        });
      }
      throw error;
    }
  });
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

async function removeCoverCacheFile(candidate) {
  if (!candidate) return;
  const resolved = musicCoverCachePath(candidate);
  if (!resolved || !isInsideDirectory(config.musicCoverCachePath, resolved)) return;
  await fs.rm(resolved, { force: true }).catch(() => {});
}

function albumPatch(changes) {
  return {
    album: changes.album,
    albumArtists: changes.albumArtists,
    genres: changes.genres,
    date: changes.date,
    year: changes.year,
    trackTotal: changes.trackTotal,
    discTotal: changes.discTotal,
    compilation: changes.compilation,
  };
}

function updateCatalog(album, prepared, changes) {
  const representative = prepared[0];
  const destinationDirectory = path.resolve(representative.plan.albumDirectory);
  const destinationAlbum = findAlbumAtDirectory.get(representative.plan.albumRelativePath);
  if (destinationAlbum && Number(destinationAlbum.id) !== Number(album.id)) {
    throw new MusicAlbumMetadataEditError(
      'MUSIC_ALBUM_METADATA_DESTINATION_ALBUM_EXISTS',
      'La destinazione appartiene già a un altro album del catalogo.',
      { statusCode: 409 },
    );
  }

  const albumArtists = changes.albumArtists.map(ensureArtist);
  updateAlbum.run(
    changes.album,
    representative.plan.albumRelativePath,
    representative.plan.albumRelativePath,
    JSON.stringify(changes.albumArtists),
    JSON.stringify(changes.genres),
    changes.year,
    changes.compilation ? 1 : 0,
    album.id,
  );
  replaceAlbumArtistRows(album.id, albumArtists);

  for (const entry of prepared) {
    const trackArtists = entry.plan.artists.map(ensureArtist);
    const values = buildTrackMetadataValues(album.id, entry.plan, entry.metadata, entry.stats);
    updateTrack.run(
      values[0],
      entry.plan.relativePath,
      ...values.slice(1),
      entry.track.id,
    );
    replaceTrackArtistRows(entry.track.id, trackArtists);
  }

  deleteOrphanArtists.run();
}

async function updateMusicAlbumEmbeddedMetadata(albumId, input, options = {}) {
  return withMusicMetadataEditLock(async () => {
    const changes = normalizeAlbumChanges(input);
    const { album, tracks } = await assertAlbum(albumId);
    const metadataUpdater = options.metadataUpdater || updateMusicFileTags;
    const coverUpdater = options.coverUpdater || updateMusicFileCoverArt;
    const originalPaths = new Set();
    const prepared = [];
    const movedBackups = [];
    const installedDestinations = [];
    let transactionOpen = false;
    let databaseCommitted = false;

    try {
      for (const track of tracks) {
        const originalPath = await assertTrackFile(track);
        originalPaths.add(pathKey(originalPath));
        const stagedPath = temporarySiblingPath(originalPath, 'album-stage');
        const backupPath = temporarySiblingPath(originalPath, 'album-backup');
        await fs.copyFile(originalPath, stagedPath, fsConstants.COPYFILE_EXCL);
        let metadata = await metadataUpdater(stagedPath, albumPatch(changes));
        if (changes.coverChange.action !== 'keep') {
          metadata = await coverUpdater(stagedPath, changes.coverChange);
        }
        const plan = buildMusicStoragePlan(metadata);
        prepared.push({ track, originalPath, stagedPath, backupPath, metadata, plan, stats: null });
      }

      const destinationKeys = new Set();
      for (const entry of prepared) {
        const destinationPath = path.resolve(entry.plan.destinationPath);
        const key = pathKey(destinationPath);
        if (destinationKeys.has(key)) {
          throw new MusicAlbumMetadataEditError(
            'MUSIC_ALBUM_METADATA_DUPLICATE_DESTINATION',
            'Due brani dell’album produrrebbero la stessa destinazione.',
            { statusCode: 409 },
          );
        }
        destinationKeys.add(key);

        if (await pathExists(destinationPath) && !originalPaths.has(key)) {
          throw new MusicAlbumMetadataEditError(
            'MUSIC_ALBUM_METADATA_DESTINATION_EXISTS',
            `Esiste già il file “${entry.plan.fileName}” nella destinazione calcolata.`,
            { statusCode: 409 },
          );
        }
        const conflictingTrack = findTrackAtPath.get(entry.plan.relativePath);
        if (conflictingTrack && Number(conflictingTrack.albumId) !== Number(album.id)) {
          throw new MusicAlbumMetadataEditError(
            'MUSIC_ALBUM_METADATA_DESTINATION_CATALOG_CONFLICT',
            'Un brano esterno all’album usa già una delle destinazioni calcolate.',
            { statusCode: 409 },
          );
        }
      }

      const destinationAlbum = findAlbumAtDirectory.get(prepared[0].plan.albumRelativePath);
      if (destinationAlbum && Number(destinationAlbum.id) !== Number(album.id)) {
        throw new MusicAlbumMetadataEditError(
          'MUSIC_ALBUM_METADATA_DESTINATION_ALBUM_EXISTS',
          'La destinazione appartiene già a un altro album del catalogo.',
          { statusCode: 409 },
        );
      }

      for (const entry of prepared) {
        await fs.mkdir(path.dirname(entry.plan.destinationPath), { recursive: true });
      }
      for (const entry of prepared) {
        await fs.rename(entry.originalPath, entry.backupPath);
        movedBackups.push(entry);
      }
      for (const entry of prepared) {
        await fs.rename(entry.stagedPath, entry.plan.destinationPath);
        installedDestinations.push(entry);
        entry.stats = await fs.stat(entry.plan.destinationPath);
      }

      db.exec('BEGIN IMMEDIATE');
      transactionOpen = true;
      updateCatalog(album, prepared, changes);
      if (typeof options.beforeDatabaseCommit === 'function') {
        options.beforeDatabaseCommit({ album, prepared, changes });
      }
      db.exec('COMMIT');
      transactionOpen = false;
      databaseCommitted = true;

      for (const entry of movedBackups) {
        await fs.rm(entry.backupPath, { force: true }).catch(() => {});
      }
      await removeCoverCacheFile(album.coverCachePath);
      const oldDirectories = new Set(prepared.map((entry) => path.dirname(entry.originalPath)));
      for (const directory of oldDirectories) {
        if (!samePath(directory, prepared[0].plan.albumDirectory)) {
          await removeEmptyMusicParents(directory);
        }
      }

      const fileNames = new Map(prepared.map((entry) => [entry.track.id, entry.plan.fileName]));
      return serializeAlbumMetadata(album, prepared, {
        fileNames,
        destinationChanged: prepared.some((entry) => !samePath(entry.originalPath, entry.plan.destinationPath)),
        coverChanged: changes.coverChange.action !== 'keep',
      });
    } catch (error) {
      if (transactionOpen) {
        try { db.exec('ROLLBACK'); } catch {}
      }

      if (!databaseCommitted) {
        for (const entry of installedDestinations) {
          await fs.rm(entry.plan.destinationPath, { force: true }).catch(() => {});
        }
        let rollbackFailure = null;
        for (const entry of movedBackups) {
          try {
            await fs.mkdir(path.dirname(entry.originalPath), { recursive: true });
            await fs.rename(entry.backupPath, entry.originalPath);
          } catch (rollbackError) {
            rollbackFailure ||= rollbackError;
          }
        }
        for (const entry of prepared) {
          await fs.rm(entry.stagedPath, { force: true }).catch(() => {});
          await fs.rm(entry.backupPath, { force: true }).catch(() => {});
          await removeEmptyMusicParents(path.dirname(entry.plan.destinationPath));
        }
        if (rollbackFailure) {
          throw new MusicAlbumMetadataEditError(
            'MUSIC_ALBUM_METADATA_ROLLBACK_FAILED',
            `I metadati non sono stati salvati e il ripristino automatico dell’album non è riuscito: ${error.message}`,
            { statusCode: 500, contentPreserved: false, cause: rollbackFailure },
          );
        }
      }

      if (error instanceof MusicAlbumMetadataEditError) throw error;
      if (error instanceof MusicImportError) {
        throw new MusicAlbumMetadataEditError(error.code, error.message, {
          statusCode: error.statusCode,
          cause: error,
        });
      }
      if (error instanceof MusicCoverEditError) {
        throw new MusicAlbumMetadataEditError(error.code, error.message, {
          statusCode: error.statusCode || 400,
          cause: error,
        });
      }
      if (error instanceof MusicTagError) {
        const statusCode = /INVALID|EMPTY/.test(error.code) ? 400 : 422;
        throw new MusicAlbumMetadataEditError(error.code, error.message, { statusCode, cause: error });
      }
      throw new MusicAlbumMetadataEditError(
        'MUSIC_ALBUM_METADATA_UPDATE_FAILED',
        `Impossibile aggiornare i metadati reali dell’album: ${error.message}`,
        { statusCode: 500, cause: error },
      );
    } finally {
      for (const entry of prepared) {
        await fs.rm(entry.stagedPath, { force: true }).catch(() => {});
        if (databaseCommitted) await fs.rm(entry.backupPath, { force: true }).catch(() => {});
      }
    }
  });
}

module.exports = {
  MusicAlbumMetadataEditError,
  getMusicAlbumEmbeddedMetadata,
  normalizeAlbumChanges,
  serializeAlbumMetadata,
  updateMusicAlbumEmbeddedMetadata,
};
