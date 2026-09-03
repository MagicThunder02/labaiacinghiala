'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('../config');
const db = require('../database');
const { getMusicFormat } = require('../music-formats');
const { sanitizeFileStem } = require('../utils/safe-filename');
const { readMusicFileMetadata } = require('./music-tag-service');
const { withMusicMetadataEditLock } = require('./music-metadata-edit-lock');

class MusicImportError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'MusicImportError';
    this.code = code;
    this.statusCode = options.statusCode || 422;
    this.contentPreserved = options.contentPreserved === true;
  }
}


const findArtistByName = db.prepare(`
  SELECT id, artist_uuid AS artistUuid, name
  FROM music_artists
  WHERE name = ? COLLATE NOCASE
  LIMIT 1
`);

const insertArtist = db.prepare(`
  INSERT INTO music_artists (artist_uuid, name, updated_at)
  VALUES (?, ?, STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'))
`);

const findAlbumByDirectory = db.prepare(`
  SELECT id, album_uuid AS albumUuid, title, directory_path AS directoryPath,
         relative_path AS relativePath, album_artists_json AS albumArtistsJson,
         genres_json AS genresJson, year, compilation
  FROM music_albums
  WHERE relative_path = ? COLLATE NOCASE
  LIMIT 1
`);

const insertAlbum = db.prepare(`
  INSERT INTO music_albums (
    album_uuid, title, directory_path, relative_path, album_artists_json,
    genres_json, year, compilation, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'))
`);

const updateAlbum = db.prepare(`
  UPDATE music_albums SET
    album_artists_json = ?,
    genres_json = ?,
    year = COALESCE(year, ?),
    compilation = CASE WHEN compilation = 1 OR ? = 1 THEN 1 ELSE 0 END,
    updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = ?
`);

const insertAlbumArtist = db.prepare(`
  INSERT OR IGNORE INTO music_album_artists (album_id, artist_id, position)
  VALUES (?, ?, ?)
`);

const findTrackByFilePath = db.prepare(`
  SELECT id, track_uuid AS trackUuid
  FROM music_tracks
  WHERE relative_path = ? COLLATE NOCASE
  LIMIT 1
`);

const insertTrack = db.prepare(`
  INSERT INTO music_tracks (
    track_uuid, album_id, file_path, relative_path, file_name, title,
    artists_json, genres_json, composers_json, comment, date_text, year,
    track_number, track_total, disc_number, disc_total, compilation,
    extension, mime_type, duration_seconds, duration_ms, bitrate_kbps,
    sample_rate_hz, channels, bits_per_sample, codec, container_format,
    is_lossless, bitrate_mode, size_bytes, modified_at, has_cover_art,
    available, last_seen_at, updated_at
  ) VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1,
    STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'),
    STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
`);

const updateTrack = db.prepare(`
  UPDATE music_tracks SET
    album_id = ?,
    file_path = ?,
    relative_path = ?,
    file_name = ?,
    title = ?,
    artists_json = ?,
    genres_json = ?,
    composers_json = ?,
    comment = ?,
    date_text = ?,
    year = ?,
    track_number = ?,
    track_total = ?,
    disc_number = ?,
    disc_total = ?,
    compilation = ?,
    extension = ?,
    mime_type = ?,
    duration_seconds = ?,
    duration_ms = ?,
    bitrate_kbps = ?,
    sample_rate_hz = ?,
    channels = ?,
    bits_per_sample = ?,
    codec = ?,
    container_format = ?,
    is_lossless = ?,
    bitrate_mode = ?,
    size_bytes = ?,
    modified_at = ?,
    has_cover_art = ?,
    available = 1,
    last_seen_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'),
    missing_since = NULL,
    updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = ?
`);

const deleteTrackArtists = db.prepare(`
  DELETE FROM music_track_artists
  WHERE track_id = ?
`);

const insertTrackArtist = db.prepare(`
  INSERT INTO music_track_artists (track_id, artist_id, position)
  VALUES (?, ?, ?)
`);

function normalizedKey(value) {
  return String(value || '').trim().toLocaleLowerCase('it');
}

function sameTextList(left, right) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => normalizedKey(value) === normalizedKey(right[index]));
}

function parseJsonList(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function mergeTextLists(left, right) {
  const result = [];
  const seen = new Set();
  for (const item of [...left, ...right]) {
    const text = String(item || '').trim();
    const key = normalizedKey(text);
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function isInsideDirectory(parentDirectory, candidatePath) {
  const parent = path.resolve(parentDirectory);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function assertUploadSource(sourcePath) {
  const absolutePath = path.resolve(String(sourcePath || ''));
  if (!isInsideDirectory(config.uploadTempPath, absolutePath)) {
    throw new MusicImportError(
      'MUSIC_IMPORT_SOURCE_OUTSIDE_UPLOADS',
      'Il file musicale da importare deve provenire dalla cartella temporanea degli upload.',
      { statusCode: 400 },
    );
  }

  const format = getMusicFormat(absolutePath);
  if (!format) {
    throw new MusicImportError(
      'UNSUPPORTED_MUSIC_FORMAT',
      'Formato musicale non supportato. Sono ammessi soltanto MP3, FLAC e WAV.',
    );
  }

  let stats;
  try {
    stats = await fs.stat(absolutePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new MusicImportError('MUSIC_IMPORT_SOURCE_MISSING', 'Il file temporaneo non esiste più.', {
        statusCode: 404,
        cause: error,
      });
    }
    throw error;
  }

  if (!stats.isFile()) {
    throw new MusicImportError('MUSIC_IMPORT_SOURCE_INVALID', 'Il file temporaneo non è un file regolare.');
  }

  return { absolutePath, format, stats };
}

function requiredText(value, label) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    throw new MusicImportError('MUSIC_IMPORT_TAGS_INCOMPLETE', `${label} è obbligatorio nei tag del file.`);
  }
  return text;
}

function positiveTrackNumber(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 100000) {
    throw new MusicImportError(
      'MUSIC_IMPORT_TAGS_INCOMPLETE',
      'Il numero della traccia è obbligatorio e deve essere un intero positivo.',
    );
  }
  return number;
}

function optionalPositiveInteger(value, label) {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 100000) {
    throw new MusicImportError(
      'MUSIC_IMPORT_TAGS_INCOMPLETE',
      `${label} deve essere un intero positivo.`,
    );
  }
  return number;
}

function buildMusicStoragePlan(metadata, options = {}) {
  const tags = metadata?.tags || {};
  const title = requiredText(tags.title, 'Il titolo');
  const album = requiredText(tags.album, 'L’album');
  const artists = Array.isArray(tags.artists)
    ? tags.artists.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  if (!artists.length) {
    throw new MusicImportError('MUSIC_IMPORT_TAGS_INCOMPLETE', 'L’artista del brano è obbligatorio nei tag del file.');
  }

  const explicitAlbumArtists = Array.isArray(tags.albumArtists)
    ? tags.albumArtists.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  const albumArtists = explicitAlbumArtists.length ? explicitAlbumArtists : artists;
  if (tags.compilation === true && !explicitAlbumArtists.length) {
    throw new MusicImportError(
      'MUSIC_IMPORT_TAGS_INCOMPLETE',
      'Per una compilation è obbligatorio indicare l’artista album nei tag del file.',
    );
  }

  const trackNumber = positiveTrackNumber(tags.trackNumber);
  const discNumber = optionalPositiveInteger(tags.discNumber, 'Il numero del disco');
  const discTotal = optionalPositiveInteger(tags.discTotal, 'Il totale dei dischi');
  if (discTotal != null && discNumber != null && discNumber > discTotal) {
    throw new MusicImportError(
      'MUSIC_IMPORT_TAGS_INCOMPLETE',
      'Il numero del disco non può superare il totale dei dischi.',
    );
  }
  if ((discTotal != null && discTotal > 1) && discNumber == null) {
    throw new MusicImportError(
      'MUSIC_IMPORT_TAGS_INCOMPLETE',
      'Per un album multidisco è obbligatorio indicare il numero del disco.',
    );
  }
  if (discNumber != null && discNumber > 1 && (discTotal == null || discTotal < discNumber)) {
    throw new MusicImportError(
      'MUSIC_IMPORT_TAGS_INCOMPLETE',
      'Per un album multidisco è obbligatorio indicare un totale dischi coerente.',
    );
  }
  const extension = getMusicFormat(metadata?.extension || metadata?.fileName)?.extension;
  if (!extension) {
    throw new MusicImportError(
      'UNSUPPORTED_MUSIC_FORMAT',
      'Formato musicale non supportato. Sono ammessi soltanto MP3, FLAC e WAV.',
    );
  }

  const musicRoot = path.resolve(options.musicRoot || config.mediaPaths.music);
  const libraryRoot = path.resolve(options.libraryRoot || config.libraryPath);
  const artistFolder = sanitizeFileStem(albumArtists.join(' & '), 'Artista');
  const albumFolder = sanitizeFileStem(album, 'Album');
  const titleStem = sanitizeFileStem(title, 'Brano');
  const width = Math.max(2, String(tags.trackTotal || trackNumber).length);
  const trackPrefix = String(trackNumber).padStart(width, '0');
  const multiDisc = Number(discTotal || 1) > 1;
  const discPrefix = multiDisc ? `${discNumber}-` : '';
  const fileName = `${discPrefix}${trackPrefix} ${titleStem}${extension}`;
  const albumDirectory = path.join(musicRoot, artistFolder, albumFolder);
  const destinationPath = path.join(albumDirectory, fileName);
  const relativePath = path.relative(libraryRoot, destinationPath).split(path.sep).join('/');
  const albumRelativePath = path.relative(libraryRoot, albumDirectory).split(path.sep).join('/');

  if (
    !relativePath
    || relativePath === '..'
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath)
  ) {
    throw new MusicImportError('MUSIC_IMPORT_DESTINATION_INVALID', 'La destinazione musicale non è valida.');
  }

  return {
    title,
    album,
    artists,
    albumArtists,
    trackNumber,
    discNumber,
    discTotal,
    multiDisc,
    artistFolder,
    albumFolder,
    fileName,
    albumDirectory,
    destinationPath,
    relativePath,
    albumRelativePath,
    extension,
  };
}

async function pathExists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function moveOnSameVolume(source, destination) {
  try {
    await fs.rename(source, destination);
  } catch (error) {
    if (error.code === 'EXDEV') {
      throw new MusicImportError(
        'MUSIC_IMPORT_CROSS_VOLUME',
        'La cartella temporanea degli upload deve trovarsi sullo stesso volume della libreria musicale.',
        { statusCode: 500, cause: error },
      );
    }
    throw error;
  }
}

async function removeEmptyParents(startDirectory) {
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

function ensureArtist(name) {
  const existing = findArtistByName.get(name);
  if (existing) return existing;
  const artistUuid = crypto.randomUUID();
  const id = Number(insertArtist.run(artistUuid, name).lastInsertRowid);
  return { id, artistUuid, name };
}

function ensureAlbum(plan, metadata, albumArtistRows) {
  const existing = findAlbumByDirectory.get(plan.albumRelativePath);
  const genres = Array.isArray(metadata.tags.genres) ? metadata.tags.genres : [];
  const year = metadata.tags.year == null ? null : Number(metadata.tags.year);
  const compilation = metadata.tags.compilation === true ? 1 : 0;

  if (existing) {
    if (normalizedKey(existing.title) !== normalizedKey(plan.album)) {
      throw new MusicImportError(
        'MUSIC_IMPORT_ALBUM_COLLISION',
        `La cartella “${plan.artistFolder}\\${plan.albumFolder}” appartiene già a un album con un titolo differente.`,
        { statusCode: 409 },
      );
    }
    const storedAlbumArtists = parseJsonList(existing.albumArtistsJson);
    if (!sameTextList(storedAlbumArtists, plan.albumArtists)) {
      throw new MusicImportError(
        'MUSIC_IMPORT_ALBUM_COLLISION',
        'L’album esistente usa artisti album differenti.',
        { statusCode: 409 },
      );
    }
    const mergedGenres = mergeTextLists(parseJsonList(existing.genresJson), genres);
    updateAlbum.run(
      JSON.stringify(plan.albumArtists),
      JSON.stringify(mergedGenres),
      year,
      compilation,
      existing.id,
    );
    return existing;
  }

  const albumUuid = crypto.randomUUID();
  const albumId = Number(insertAlbum.run(
    albumUuid,
    plan.album,
    plan.albumRelativePath,
    plan.albumRelativePath,
    JSON.stringify(plan.albumArtists),
    JSON.stringify(genres),
    year,
    compilation,
  ).lastInsertRowid);

  for (const [position, artist] of albumArtistRows.entries()) {
    insertAlbumArtist.run(albumId, artist.id, position);
  }

  return { id: albumId, albumUuid, title: plan.album };
}

function buildTrackMetadataValues(albumId, plan, metadata, stats) {
  const format = getMusicFormat(plan.extension);
  const tags = metadata.tags;
  const properties = metadata.properties || {};
  return [
    albumId,
    plan.relativePath,
    plan.fileName,
    plan.title,
    JSON.stringify(plan.artists),
    JSON.stringify(Array.isArray(tags.genres) ? tags.genres : []),
    JSON.stringify(Array.isArray(tags.composers) ? tags.composers : []),
    String(tags.comment || ''),
    String(tags.date || ''),
    tags.year == null ? null : Number(tags.year),
    plan.trackNumber,
    tags.trackTotal == null ? null : Number(tags.trackTotal),
    tags.discNumber == null ? null : Number(tags.discNumber),
    tags.discTotal == null ? null : Number(tags.discTotal),
    tags.compilation === true ? 1 : 0,
    plan.extension,
    format.mimeTypes[0],
    Number(properties.durationSeconds || 0),
    Number(properties.durationMs || 0),
    properties.bitrateKbps == null ? null : Number(properties.bitrateKbps),
    properties.sampleRateHz == null ? null : Number(properties.sampleRateHz),
    properties.channels == null ? null : Number(properties.channels),
    properties.bitsPerSample == null ? null : Number(properties.bitsPerSample),
    properties.codec || null,
    properties.containerFormat || null,
    properties.isLossless === true ? 1 : 0,
    properties.bitrateMode || null,
    Number(stats.size || 0),
    Math.trunc(stats.mtimeMs),
    metadata.hasCoverArt === true ? 1 : 0,
  ];
}

function saveMusicTrackIndex(plan, metadata, stats) {
  const albumArtistRows = plan.albumArtists.map(ensureArtist);
  const trackArtistRows = plan.artists.map(ensureArtist);
  const album = ensureAlbum(plan, metadata, albumArtistRows);
  for (const [position, artist] of albumArtistRows.entries()) {
    insertAlbumArtist.run(album.id, artist.id, position);
  }

  const absoluteDestination = path.resolve(plan.destinationPath);
  const existingTrack = findTrackByFilePath.get(plan.relativePath);
  const metadataValues = buildTrackMetadataValues(album.id, plan, metadata, stats);
  let trackId;
  let trackUuid;
  let restoredExisting = false;

  if (existingTrack) {
    trackId = Number(existingTrack.id);
    trackUuid = existingTrack.trackUuid;
    restoredExisting = true;
    deleteTrackArtists.run(trackId);
    updateTrack.run(metadataValues[0], plan.relativePath, ...metadataValues.slice(1), trackId);
  } else {
    trackUuid = crypto.randomUUID();
    trackId = Number(insertTrack.run(
      trackUuid,
      album.id,
      plan.relativePath,
      ...metadataValues.slice(1),
    ).lastInsertRowid);
  }

  for (const [position, artist] of trackArtistRows.entries()) {
    insertTrackArtist.run(trackId, artist.id, position);
  }

  return {
    id: trackId,
    trackUuid,
    albumId: Number(album.id),
    albumUuid: album.albumUuid,
    restoredExisting,
  };
}

async function inspectMusicUpload(sourcePath, options = {}) {
  const { absolutePath } = await assertUploadSource(sourcePath);
  const metadataReader = options.metadataReader || readMusicFileMetadata;
  const metadata = await metadataReader(absolutePath);
  const plan = buildMusicStoragePlan(metadata, options);
  return {
    title: plan.title,
    artists: [...plan.artists],
    album: plan.album,
    albumArtists: [...plan.albumArtists],
    trackNumber: plan.trackNumber,
    trackTotal: metadata.tags.trackTotal,
    discNumber: metadata.tags.discNumber,
    discTotal: metadata.tags.discTotal,
    year: metadata.tags.year,
    genres: [...(metadata.tags.genres || [])],
    extension: plan.extension,
    format: metadata.format,
    durationSeconds: Number(metadata.properties?.durationSeconds || 0),
    hasCoverArt: metadata.hasCoverArt === true,
    proposedRelativePath: plan.relativePath,
  };
}

async function importMusicUpload(sourcePath, options = {}) {
  return withMusicMetadataEditLock(async () => {
    const { absolutePath } = await assertUploadSource(sourcePath);
    const metadataReader = options.metadataReader || readMusicFileMetadata;
    const metadata = await metadataReader(absolutePath);
    const plan = buildMusicStoragePlan(metadata, options);

    if (await pathExists(plan.destinationPath)) {
      throw new MusicImportError(
        'MUSIC_IMPORT_DESTINATION_EXISTS',
        `Esiste già il brano “${plan.fileName}” nell’album selezionato.`,
        { statusCode: 409 },
      );
    }

    await fs.mkdir(plan.albumDirectory, { recursive: true });
    let moved = false;
    let databaseCommitted = false;

    try {
      await moveOnSameVolume(absolutePath, plan.destinationPath);
      moved = true;
      const stats = await fs.stat(plan.destinationPath);

      db.exec('BEGIN IMMEDIATE');
      let saved;
      try {
        saved = saveMusicTrackIndex(plan, metadata, stats);
        db.exec('COMMIT');
        databaseCommitted = true;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }

      return {
        ...saved,
        title: plan.title,
        artists: [...plan.artists],
        album: plan.album,
        albumArtists: [...plan.albumArtists],
        trackNumber: plan.trackNumber,
        trackTotal: metadata.tags.trackTotal,
        discNumber: metadata.tags.discNumber,
        discTotal: metadata.tags.discTotal,
        year: metadata.tags.year,
        genres: [...(metadata.tags.genres || [])],
        extension: plan.extension,
        format: metadata.format,
        durationSeconds: Number(metadata.properties?.durationSeconds || 0),
        hasCoverArt: metadata.hasCoverArt === true,
        relativePath: plan.relativePath,
      };
    } catch (error) {
      if (moved && !databaseCommitted) {
        try {
          await moveOnSameVolume(plan.destinationPath, absolutePath);
        } catch (rollbackError) {
          throw new MusicImportError(
            'MUSIC_IMPORT_ROLLBACK_FAILED',
            `Il file è stato conservato nella libreria, ma il catalogo non è stato aggiornato: ${error.message}`,
            { statusCode: 500, contentPreserved: true, cause: rollbackError },
          );
        }
      }
      if (!databaseCommitted) await removeEmptyParents(plan.albumDirectory);
      if (error instanceof MusicImportError) throw error;
      throw new MusicImportError(
        'MUSIC_IMPORT_FAILED',
        `Impossibile importare il file musicale: ${error.message}`,
        { statusCode: 500, cause: error },
      );
    }
  });
}

module.exports = {
  MusicImportError,
  buildMusicStoragePlan,
  buildTrackMetadataValues,
  saveMusicTrackIndex,
  inspectMusicUpload,
  importMusicUpload,
};
