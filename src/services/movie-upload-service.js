const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const mime = require('mime-types');
const config = require('../config');
const db = require('../database');
const { SUPPORTED_EXTENSIONS } = require('../media-formats');
const { normalizeGenres } = require('../utils/movie-metadata');
const { sanitizeFileStem } = require('../utils/safe-filename');
const {
  MAX_POSTER_BYTES,
  extensionFromMime,
  normalizeExtension,
  validatePosterBuffer,
} = require('./managed-poster-service');
const {
  STORAGE_VERSION,
  normalizeDocument,
  writeJsonAtomically,
  readContentMetadata,
  refreshPosterCache,
} = require('./content-metadata-service');
const {
  relativePathFromAbsolute,
  resolveStoredLibraryPath,
} = require('./video-library-path-service');

const insertMovie = db.prepare(`
  INSERT INTO movies (
    content_uuid, metadata_path, storage_version, available, last_seen_at,
    file_path, relative_path, file_name, title, year, extension,
    mime_type, size_bytes, modified_at, media_type, genres_json,
    director, poster_path, metadata_auto_json, updated_at
  ) VALUES (?, ?, ?, 1, STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'),
    ?, ?, ?, ?, ?, ?, ?, ?, ?, 'movie', ?, ?, ?, ?,
    STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'))
`);

const reactivateMovie = db.prepare(`
  UPDATE movies SET
    content_uuid = ?,
    metadata_path = ?,
    storage_version = ?,
    available = 1,
    last_seen_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'),
    missing_since = NULL,
    file_path = ?,
    relative_path = ?,
    file_name = ?,
    title = ?,
    year = ?,
    extension = ?,
    mime_type = ?,
    size_bytes = ?,
    modified_at = ?,
    media_type = 'movie',
    series_title = NULL,
    season_number = NULL,
    episode_number = NULL,
    genres_json = ?,
    director = ?,
    poster_path = ?,
    metadata_auto_json = ?,
    updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = ? AND available = 0
`);

const deleteOverrides = db.prepare(`
  DELETE FROM media_metadata_overrides WHERE movie_id = ?
`);

const markUnavailable = db.prepare(`
  UPDATE movies SET
    available = 0,
    missing_since = COALESCE(missing_since, STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = ?
`);

const findActiveDuplicate = db.prepare(`
  SELECT id, content_uuid AS contentUuid, relative_path AS relativePath,
         metadata_path AS metadataPath, title, year, file_name AS fileName
  FROM movies
  WHERE media_type = 'movie'
    AND available = 1
    AND title = ? COLLATE NOCASE
    AND COALESCE(year, 0) = ?
  LIMIT 1
`);

const findOfflineExact = db.prepare(`
  SELECT id, content_uuid AS contentUuid, relative_path AS relativePath,
         metadata_path AS metadataPath, title, year
  FROM movies
  WHERE media_type = 'movie'
    AND available = 0
    AND title = ? COLLATE NOCASE
    AND COALESCE(year, 0) = ?
  ORDER BY updated_at DESC
  LIMIT 1
`);

const findOfflineByTitle = db.prepare(`
  SELECT id, content_uuid AS contentUuid, relative_path AS relativePath,
         metadata_path AS metadataPath, title, year
  FROM movies
  WHERE media_type = 'movie'
    AND available = 0
    AND title = ? COLLATE NOCASE
  ORDER BY updated_at DESC
  LIMIT 2
`);

function requiredText(value, label, maximum = 500) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error(`${label} è obbligatorio.`);
  return text.slice(0, maximum);
}

function validYear(value) {
  const year = Number.parseInt(value, 10);
  const maximum = new Date().getFullYear() + 2;
  if (!Number.isInteger(year) || year < 1888 || year > maximum) {
    throw new Error(`L'anno deve essere compreso tra 1888 e ${maximum}.`);
  }
  return year;
}

function validateFields(fields) {
  const title = requiredText(fields?.title, 'Il titolo', 300);
  const director = requiredText(fields?.director, 'Il regista', 500);
  const year = validYear(fields?.year);
  const genres = normalizeGenres(fields?.genre || fields?.genres || []).slice(0, 30);
  if (!genres.length) throw new Error('Il genere è obbligatorio.');
  return { title, director, year, genres };
}

async function pathExists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

function validateFiles(video, poster) {
  if (!video) throw new Error('Il file video è obbligatorio.');
  if (!poster) throw new Error('La copertina è obbligatoria.');
  const videoExtension = path.extname(video.originalname || '').toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(videoExtension)) throw new Error('Formato video non supportato.');
  const posterExtension = extensionFromMime(poster.mimetype)
    || normalizeExtension(path.extname(poster.originalname || '').toLowerCase());
  if (!posterExtension) throw new Error('Formato copertina non supportato.');
  if (Number(poster.size || 0) > MAX_POSTER_BYTES) {
    throw new Error('La copertina deve avere dimensione massima di 6 MB.');
  }
  return { videoExtension, posterExtension };
}

function reusableOfflineRecord(title, year) {
  const exact = findOfflineExact.get(title, year);
  if (exact) return exact;
  const sameTitle = findOfflineByTitle.all(title);
  return sameTitle.length === 1 ? sameTitle[0] : null;
}

async function moveIntoDirectory(source, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.rename(source, destination);
  } catch (error) {
    if (error.code === 'EXDEV') {
      throw new Error('La cartella temporanea degli upload deve trovarsi sullo stesso volume della libreria.');
    }
    throw error;
  }
}

async function directoryContainsVideo(directory) {
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      if (entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        return true;
      }
    }
  }
  return false;
}

async function displaceStaleDirectory(finalDirectory, reusableRecord) {
  if (!await pathExists(finalDirectory)) return null;

  const oldDirectory = reusableRecord?.relativePath
    ? path.dirname(resolveStoredLibraryPath(reusableRecord.relativePath))
    : null;
  const sameDirectory = oldDirectory === path.resolve(finalDirectory);
  const containsVideo = await directoryContainsVideo(finalDirectory);

  if (!reusableRecord || !sameDirectory || containsVideo) {
    const error = new Error(`Esiste già una cartella chiamata “${path.basename(finalDirectory)}”.`);
    error.statusCode = 409;
    throw error;
  }

  const backupDirectory = path.join(
    config.uploadTempPath,
    `offline-${reusableRecord.id}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
  );
  await fs.mkdir(path.dirname(backupDirectory), { recursive: true });
  await fs.rename(finalDirectory, backupDirectory);
  return backupDirectory;
}

function saveMovieRow({ reusableRecord, contentId, finalMetadataPath, finalVideoPath,
  relativePath, fileName, title, year, videoExtension, videoMimeType,
  finalStats, genres, director, finalPosterPath, metadataAuto }) {
  if (!reusableRecord) {
    return Number(insertMovie.run(
      contentId,
      relativePathFromAbsolute(finalMetadataPath),
      STORAGE_VERSION,
      relativePath,
      relativePath,
      fileName,
      title,
      year,
      videoExtension,
      videoMimeType,
      finalStats.size,
      Math.trunc(finalStats.mtimeMs),
      JSON.stringify(genres),
      director,
      relativePathFromAbsolute(finalPosterPath),
      JSON.stringify(metadataAuto),
    ).lastInsertRowid);
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const result = reactivateMovie.run(
      contentId,
      relativePathFromAbsolute(finalMetadataPath),
      STORAGE_VERSION,
      relativePath,
      relativePath,
      fileName,
      title,
      year,
      videoExtension,
      videoMimeType,
      finalStats.size,
      Math.trunc(finalStats.mtimeMs),
      JSON.stringify(genres),
      director,
      relativePathFromAbsolute(finalPosterPath),
      JSON.stringify(metadataAuto),
      reusableRecord.id,
    );
    if (Number(result.changes) !== 1) {
      throw new Error('Il record non è più disponibile per la riattivazione.');
    }
    deleteOverrides.run(reusableRecord.id);
    db.exec('COMMIT');
    return Number(reusableRecord.id);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

async function createMovieFromUpload({ video, poster, fields }) {
  const { title, director, year, genres } = validateFields(fields);
  const { videoExtension, posterExtension } = validateFiles(video, poster);
  const activeDuplicate = findActiveDuplicate.get(title, year);
  let reusableRecord = reusableOfflineRecord(title, year);
  if (activeDuplicate) {
    let filePresent = false;
    try {
      const stats = await fs.stat(resolveStoredLibraryPath(activeDuplicate.relativePath));
      filePresent = stats.isFile();
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new Error(`Non è stato possibile verificare il film già registrato: ${error.message}`);
      }
    }

    if (filePresent) {
      const error = new Error(`Esiste già il film “${title}” (${year}).`);
      error.statusCode = 409;
      throw error;
    }

    markUnavailable.run(activeDuplicate.id);
    reusableRecord = activeDuplicate;
  }

  const contentId = reusableRecord?.contentUuid || crypto.randomUUID();
  const titleStem = sanitizeFileStem(title, 'film');
  const folderStem = sanitizeFileStem(`${title} (${year})`, `film-${year}`);
  const finalDirectory = path.join(config.mediaPaths.movies, folderStem);
  const stagingDirectory = path.join(config.uploadTempPath, `movie-${contentId}-${Date.now()}`);
  const fileName = `${titleStem}${videoExtension}`;
  const posterFileName = `poster${posterExtension}`;
  const stagingVideoPath = path.join(stagingDirectory, fileName);
  const stagingPosterPath = path.join(stagingDirectory, posterFileName);
  const stagingMetadataPath = path.join(stagingDirectory, 'metadata.json');
  const finalVideoPath = path.join(finalDirectory, fileName);
  const finalPosterPath = path.join(finalDirectory, posterFileName);
  const finalMetadataPath = path.join(finalDirectory, 'metadata.json');
  let installed = false;
  let displacedDirectory = null;

  try {
    await fs.mkdir(stagingDirectory, { recursive: false });
    await moveIntoDirectory(video.path, stagingVideoPath);
    const posterBuffer = await fs.readFile(poster.path);
    validatePosterBuffer(posterBuffer);
    await fs.writeFile(stagingPosterPath, posterBuffer, { flag: 'wx' });
    await fs.rm(poster.path, { force: true }).catch(() => {});

    const now = new Date().toISOString();
    const document = normalizeDocument({
      schemaVersion: STORAGE_VERSION,
      contentId,
      type: 'movie',
      title,
      year,
      genres,
      director,
      videoFile: fileName,
      posterFile: posterFileName,
      createdAt: now,
      updatedAt: now,
    }, { filePath: stagingVideoPath, mediaType: 'movie', fallbackUuid: contentId });
    await writeJsonAtomically(stagingMetadataPath, document);

    const verification = await readContentMetadata({
      filePath: stagingVideoPath,
      mediaType: 'movie',
      knownPath: stagingMetadataPath,
    });
    if (!verification || verification.document.contentId !== contentId) {
      throw new Error('Verifica dei metadati del film non riuscita.');
    }

    displacedDirectory = await displaceStaleDirectory(finalDirectory, reusableRecord);
    await fs.rename(stagingDirectory, finalDirectory);
    installed = true;
    if (displacedDirectory) {
      await fs.rm(displacedDirectory, { recursive: true, force: true }).catch(() => {});
      displacedDirectory = null;
    }

    const finalStats = await fs.stat(finalVideoPath);
    const relativePath = relativePathFromAbsolute(finalVideoPath);
    const metadataAuto = {
      version: 1,
      reader: 'uploader',
      automatic: { title, year, genres, director, posterPath: relativePathFromAbsolute(finalPosterPath) },
    };

    let movieId;
    try {
      movieId = saveMovieRow({
        reusableRecord,
        contentId,
        finalMetadataPath,
        finalVideoPath,
        relativePath,
        fileName,
        title,
        year,
        videoExtension,
        videoMimeType: mime.lookup(videoExtension) || video.mimetype || 'application/octet-stream',
        finalStats,
        genres,
        director,
        finalPosterPath,
        metadataAuto,
      });
    } catch (error) {
      error.contentPreserved = true;
      error.message = `Il film è stato salvato sul RAID, ma SQLite non è stato aggiornato: ${error.message}`;
      throw error;
    }

    await refreshPosterCache(contentId, finalPosterPath).catch((error) => {
      console.warn('Cache copertina upload non aggiornata:', error.message);
    });

    return {
      id: movieId,
      contentId,
      title,
      year,
      genres,
      director,
      fileName,
      relativePath,
      metadataPath: relativePathFromAbsolute(finalMetadataPath),
      restored: Boolean(reusableRecord),
      posterUrl: `/api/movies/${movieId}/poster?v=${Date.now()}`,
    };
  } catch (error) {
    if (!installed) {
      await fs.rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
      if (displacedDirectory && !await pathExists(finalDirectory)) {
        await fs.rename(displacedDirectory, finalDirectory).catch(() => {});
      }
    }
    throw error;
  }
}

module.exports = {
  validateFields,
  validateFiles,
  createMovieFromUpload,
};
