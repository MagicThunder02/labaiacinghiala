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
const { STORAGE_VERSION, normalizeDocument, writeJsonAtomically, refreshPosterCache } = require('./content-metadata-service');
const { SERIES_STORAGE_VERSION, normalizeSeriesDocument, writeSeriesDocument, readSeriesMetadata, stageSeriesMetadataChange } = require('./series-metadata-service');
const {
  relativePathFromAbsolute,
  resolveStoredLibraryPath,
} = require('./video-library-path-service');

const getSeries = db.prepare(`
  SELECT series_uuid AS seriesUuid, relative_path AS relativePath, title, year,
         genres_json AS genresJson, poster_path AS posterPath, added_at AS addedAt
  FROM series WHERE series_uuid = ? AND available = 1
`);
const findEpisode = db.prepare(`
  SELECT id FROM movies
  WHERE series_uuid = ? AND media_type = 'series' AND available = 1
    AND season_number = ? AND episode_number = ?
  LIMIT 1
`);
const getCreatedEpisodes = db.prepare(`
  SELECT id, title, season_number AS seasonNumber, episode_number AS episodeNumber,
         file_name AS fileName, relative_path AS relativePath
  FROM movies
  WHERE series_uuid = ? AND media_type = 'series' AND available = 1
  ORDER BY season_number, episode_number
`);
const findReusableEpisode = db.prepare(`
  SELECT id, content_uuid AS contentUuid
  FROM movies
  WHERE series_uuid = ? AND media_type = 'series' AND available = 0
    AND season_number = ? AND episode_number = ?
  ORDER BY updated_at DESC
  LIMIT 1
`);
const upsertSeries = db.prepare(`
  INSERT INTO series (
    series_uuid, directory_path, relative_path, title, year, genres_json, director,
    poster_path, metadata_path, storage_version, available, last_seen_at, missing_since, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 1,
    STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL,
    STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(series_uuid) DO UPDATE SET
    directory_path = excluded.directory_path,
    relative_path = excluded.relative_path,
    title = excluded.title,
    year = excluded.year,
    genres_json = excluded.genres_json,
    director = NULL,
    poster_path = excluded.poster_path,
    metadata_path = excluded.metadata_path,
    storage_version = excluded.storage_version,
    available = 1,
    last_seen_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'),
    missing_since = NULL,
    updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
`);
const updateSeriesEpisodesCommon = db.prepare(`
  UPDATE movies SET
    series_title = ?, year = ?, genres_json = ?, director = NULL,
    updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE series_uuid = ? AND media_type = 'series'
`);
const insertEpisode = db.prepare(`
  INSERT INTO movies (
    content_uuid, metadata_path, storage_version, available, last_seen_at, missing_since,
    file_path, relative_path, file_name, title, year, extension, mime_type,
    size_bytes, modified_at, media_type, series_uuid, series_title,
    season_number, episode_number, genres_json, director, poster_path,
    metadata_auto_json, updated_at
  ) VALUES (?, ?, ?, 1, STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL,
    ?, ?, ?, ?, ?, ?, ?, ?, ?, 'series', ?, ?, ?, ?, ?, NULL, NULL, ?,
    STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'))
`);
const reactivateEpisode = db.prepare(`
  UPDATE movies SET
    content_uuid = ?, metadata_path = ?, storage_version = ?,
    available = 1, last_seen_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'), missing_since = NULL,
    file_path = ?, relative_path = ?, file_name = ?, title = ?, year = ?,
    extension = ?, mime_type = ?, size_bytes = ?, modified_at = ?,
    media_type = 'series', series_uuid = ?, series_title = ?,
    season_number = ?, episode_number = ?, genres_json = ?, director = NULL,
    poster_path = NULL, metadata_auto_json = ?,
    updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = ? AND available = 0
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
function positiveInteger(value, label) {
  const number = Number.parseInt(value, 10);
  if (!Number.isInteger(number) || number < 1 || number > 999) {
    throw new Error(`${label} deve essere un numero compreso tra 1 e 999.`);
  }
  return number;
}
function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}
function parseEpisodePlan(raw, videos) {
  const parsed = typeof raw === 'string' ? parseJson(raw, null) : raw;
  if (!Array.isArray(parsed) || parsed.length !== videos.length) {
    throw new Error('La numerazione degli episodi non corrisponde ai file selezionati.');
  }
  const seen = new Set();
  return parsed.map((item, index) => {
    const seasonNumber = positiveInteger(item?.seasonNumber ?? item?.season, 'La stagione');
    const episodeNumber = positiveInteger(item?.episodeNumber ?? item?.episode, "L'episodio");
    const key = `${seasonNumber}:${episodeNumber}`;
    if (seen.has(key)) throw new Error(`S${seasonNumber}E${episodeNumber} è stato assegnato più di una volta.`);
    seen.add(key);
    const title = String(item?.title || '').replace(/\s+/g, ' ').trim().slice(0, 300)
      || `Episodio ${episodeNumber}`;
    return { index, seasonNumber, episodeNumber, title };
  });
}
function videoExtension(file) {
  const extension = path.extname(file?.originalname || '').toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) throw new Error(`Formato video non supportato: ${file?.originalname || 'file'}.`);
  return extension;
}
async function pathExists(candidate) {
  try { await fs.access(candidate); return true; } catch { return false; }
}
async function moveSameVolume(source, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.rename(source, destination);
  } catch (error) {
    if (error.code === 'EXDEV') throw new Error('La cartella temporanea degli upload deve trovarsi sullo stesso volume della libreria.');
    throw error;
  }
}
function parseSeriesGenres(value) {
  return normalizeGenres(value || []).slice(0, 30);
}
function newSeriesFields(fields) {
  const title = requiredText(fields?.title, 'Il titolo della serie', 300);
  const year = validYear(fields?.year);
  const genres = parseSeriesGenres(fields?.genre || fields?.genres || []);
  if (!genres.length) throw new Error('Il genere è obbligatorio.');
  return { title, year, genres };
}
function posterInfo(poster, required) {
  if (!poster) {
    if (required) throw new Error('La copertina è obbligatoria per una nuova serie.');
    return null;
  }
  if (Number(poster.size || 0) > MAX_POSTER_BYTES) throw new Error('La copertina deve avere dimensione massima di 6 MB.');
  const extension = extensionFromMime(poster.mimetype)
    || normalizeExtension(path.extname(poster.originalname || ''));
  if (!extension) throw new Error('Formato copertina non supportato.');
  return { extension };
}
async function ensureNoConflicts(seriesUuid, finalDirectory, seriesTitle, videos, plan) {
  for (const item of plan) {
    if (seriesUuid && findEpisode.get(seriesUuid, item.seasonNumber, item.episodeNumber)) {
      const error = new Error(`S${item.seasonNumber}E${item.episodeNumber} è già presente nella serie.`);
      error.statusCode = 409;
      throw error;
    }
    const extension = videoExtension(videos[item.index]);
    const fileName = `${sanitizeFileStem(seriesTitle, 'serie')} x ${item.seasonNumber} x ${item.episodeNumber}${extension}`;
    const finalVideoPath = path.join(finalDirectory, `Stagione ${item.seasonNumber}`, fileName);
    if (await pathExists(finalVideoPath)) {
      const error = new Error(`${fileName} esiste già sul server.`);
      error.statusCode = 409;
      throw error;
    }
  }
}

async function prepareEpisodeFiles({ stagingDirectory, seriesTitle, seriesUuid, videos, plan }) {
  const prepared = [];
  for (const item of plan) {
    const video = videos[item.index];
    const extension = videoExtension(video);
    const fileName = `${sanitizeFileStem(seriesTitle, 'serie')} x ${item.seasonNumber} x ${item.episodeNumber}${extension}`;
    const seasonDirectory = path.join(stagingDirectory, `Stagione ${item.seasonNumber}`);
    const videoPath = path.join(seasonDirectory, fileName);
    await moveSameVolume(video.path, videoPath);
    const reusable = seriesUuid
      ? findReusableEpisode.get(seriesUuid, item.seasonNumber, item.episodeNumber)
      : null;
    const contentId = reusable?.contentUuid || crypto.randomUUID();
    const metadataPath = path.join(seasonDirectory, `${path.basename(fileName, extension)}.metadata.json`);
    const now = new Date().toISOString();
    const document = normalizeDocument({
      schemaVersion: 1,
      contentId,
      type: 'series',
      title: item.title,
      year: null,
      genres: [],
      seriesTitle,
      seasonNumber: item.seasonNumber,
      episodeNumber: item.episodeNumber,
      videoFile: fileName,
      posterFile: null,
      createdAt: now,
      updatedAt: now,
    }, { filePath: videoPath, mediaType: 'series', fallbackUuid: contentId });
    await writeJsonAtomically(metadataPath, document);
    prepared.push({ ...item, contentId, reusableId: reusable?.id || null, extension, fileName, videoPath, metadataPath });
  }
  return prepared;
}


async function registerSeriesUpload({
  seriesUuid,
  finalDirectory,
  metadata,
  prepared,
  videos,
}) {
  const storedSeries = await readSeriesMetadata(finalDirectory);
  if (!storedSeries || storedSeries.document.seriesId !== seriesUuid) {
    throw new Error('Verifica dei metadati della serie non riuscita.');
  }

  const seriesRelativePath = relativePathFromAbsolute(finalDirectory);
  const episodeRows = [];
  for (const item of prepared) {
    // prepared è dentro <staging>/Stagione N/file; ricostruiamo il percorso dalla stagione.
    const seasonDirectoryName = path.basename(path.dirname(item.videoPath));
    const finalVideoPath = path.join(finalDirectory, seasonDirectoryName, item.fileName);
    const finalMetadataPath = path.join(finalDirectory, seasonDirectoryName, path.basename(item.metadataPath));
    const stats = await fs.stat(finalVideoPath);
    const relativePath = relativePathFromAbsolute(finalVideoPath);
    const sourceVideo = videos[item.index];
    episodeRows.push({
      ...item,
      finalVideoPath,
      finalMetadataPath,
      relativePath,
      mimeType: mime.lookup(item.extension) || sourceVideo?.mimetype || 'application/octet-stream',
      sizeBytes: Number(stats.size || 0),
      modifiedAt: Math.trunc(stats.mtimeMs),
    });
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    upsertSeries.run(
      seriesUuid,
      seriesRelativePath,
      seriesRelativePath,
      metadata.title,
      metadata.year,
      JSON.stringify(metadata.genres),
      storedSeries.posterPath ? relativePathFromAbsolute(storedSeries.posterPath) : null,
      relativePathFromAbsolute(storedSeries.metadataPath),
      SERIES_STORAGE_VERSION,
    );
    updateSeriesEpisodesCommon.run(metadata.title, metadata.year, JSON.stringify(metadata.genres), seriesUuid);

    for (const row of episodeRows) {
      const metadataAuto = JSON.stringify({
        version: 1,
        reader: 'uploader',
        automatic: {
          title: row.title,
          year: metadata.year,
          genres: metadata.genres,
          seriesTitle: metadata.title,
          seasonNumber: row.seasonNumber,
          episodeNumber: row.episodeNumber,
        },
      });
      if (row.reusableId) {
        const result = reactivateEpisode.run(
          row.contentId,
          relativePathFromAbsolute(row.finalMetadataPath),
          STORAGE_VERSION,
          row.relativePath,
          row.relativePath,
          row.fileName,
          row.title,
          metadata.year,
          row.extension,
          row.mimeType,
          row.sizeBytes,
          row.modifiedAt,
          seriesUuid,
          metadata.title,
          row.seasonNumber,
          row.episodeNumber,
          JSON.stringify(metadata.genres),
          metadataAuto,
          row.reusableId,
        );
        if (Number(result.changes) !== 1) throw new Error('Un episodio offline non è più disponibile per la riattivazione.');
      } else {
        insertEpisode.run(
          row.contentId,
          relativePathFromAbsolute(row.finalMetadataPath),
          STORAGE_VERSION,
          row.relativePath,
          row.relativePath,
          row.fileName,
          row.title,
          metadata.year,
          row.extension,
          row.mimeType,
          row.sizeBytes,
          row.modifiedAt,
          seriesUuid,
          metadata.title,
          row.seasonNumber,
          row.episodeNumber,
          JSON.stringify(metadata.genres),
          metadataAuto,
        );
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  if (storedSeries.posterPath) {
    await refreshPosterCache(seriesUuid, storedSeries.posterPath).catch((error) => {
      console.warn('Cache copertina serie upload non aggiornata:', error.message);
    });
  }
}

async function createSeriesFromUpload({ videos, poster, fields }) {
  if (!Array.isArray(videos) || videos.length < 1) throw new Error('Seleziona almeno un episodio.');
  if (videos.length > 100) throw new Error('Puoi caricare al massimo 100 episodi in una sessione.');
  const requestedSeriesUuid = String(fields?.seriesUuid || '').trim();
  const existing = requestedSeriesUuid ? getSeries.get(requestedSeriesUuid) : null;
  if (requestedSeriesUuid && !existing) {
    const error = new Error('La serie selezionata non è più disponibile.');
    error.statusCode = 404;
    throw error;
  }

  const metadata = existing ? {
    title: requiredText(fields?.title || existing.title, 'Il titolo della serie', 300),
    year: fields?.year ? validYear(fields.year) : existing.year,
    genres: fields?.genre !== undefined || fields?.genres !== undefined
      ? parseSeriesGenres(fields?.genre || fields?.genres || [])
      : parseJson(existing.genresJson, []),
  } : newSeriesFields(fields);
  if (!metadata.genres.length) throw new Error('Il genere è obbligatorio.');
  const seriesUuid = existing?.seriesUuid || crypto.randomUUID();
  const posterDetails = posterInfo(poster, !existing);
  const plan = parseEpisodePlan(fields?.episodes, videos);
  const finalDirectory = existing?.relativePath
    ? resolveStoredLibraryPath(existing.relativePath)
    : path.join(config.mediaPaths.series, sanitizeFileStem(metadata.title, 'serie'));

  if (!existing && await pathExists(finalDirectory)) {
    const error = new Error(`Esiste già una cartella chiamata “${path.basename(finalDirectory)}”. Se è la stessa serie, selezionala dall'elenco.`);
    error.statusCode = 409;
    throw error;
  }
  await ensureNoConflicts(existing?.seriesUuid || null, finalDirectory, metadata.title, videos, plan);

  const stagingRoot = path.join(config.uploadTempPath, `series-${seriesUuid}-${Date.now()}`);
  const stagingSeriesDirectory = path.join(stagingRoot, 'series');
  const installedPaths = [];
  let installedNewSeries = false;
  let installationCommitted = false;

  try {
    await fs.mkdir(stagingSeriesDirectory, { recursive: true });
    const prepared = await prepareEpisodeFiles({
      stagingDirectory: stagingSeriesDirectory,
      seriesTitle: metadata.title,
      seriesUuid,
      videos,
      plan,
    });

    if (!existing) {
      const posterBuffer = await fs.readFile(poster.path);
      validatePosterBuffer(posterBuffer);
      const posterFile = `poster${posterDetails.extension}`;
      await moveSameVolume(poster.path, path.join(stagingSeriesDirectory, posterFile));
      const now = new Date().toISOString();
      const seriesDocument = normalizeSeriesDocument({
        seriesId: seriesUuid,
        type: 'series',
        title: metadata.title,
        year: metadata.year,
        genres: metadata.genres,
        posterFile,
        createdAt: now,
        updatedAt: now,
      }, { fallbackUuid: seriesUuid, fallbackTitle: metadata.title });
      await writeSeriesDocument(stagingSeriesDirectory, seriesDocument);
      await fs.mkdir(path.dirname(finalDirectory), { recursive: true });
      await fs.rename(stagingSeriesDirectory, finalDirectory);
      installedNewSeries = true;
    } else {
      await readSeriesMetadata(finalDirectory);
      let stagedSeriesMetadata = null;
      try {
        let posterData = null;
        if (poster) {
          const posterBuffer = await fs.readFile(poster.path);
          validatePosterBuffer(posterBuffer);
          posterData = { buffer: posterBuffer, extension: posterDetails.extension };
        }
        stagedSeriesMetadata = await stageSeriesMetadataChange({
          seriesDirectory: finalDirectory,
          seriesId: seriesUuid,
          title: metadata.title,
          year: metadata.year,
          genres: metadata.genres,
          posterData,
          legacyPosterPath: existing.posterPath ? resolveStoredLibraryPath(existing.posterPath, {
            anchorRelativePath: existing.relativePath,
            anchorIsDirectory: true,
          }) : null,
          createdAt: existing.addedAt,
        });
        await stagedSeriesMetadata.apply();

        for (const item of prepared) {
          const relativeVideo = path.relative(stagingSeriesDirectory, item.videoPath);
          const relativeMetadata = path.relative(stagingSeriesDirectory, item.metadataPath);
          const targetVideo = path.join(finalDirectory, relativeVideo);
          const targetMetadata = path.join(finalDirectory, relativeMetadata);
          await moveSameVolume(item.videoPath, targetVideo);
          installedPaths.push(targetVideo);
          await moveSameVolume(item.metadataPath, targetMetadata);
          installedPaths.push(targetMetadata);
        }
        await stagedSeriesMetadata.commit();
      } catch (error) {
        if (stagedSeriesMetadata) await stagedSeriesMetadata.rollback().catch(() => {});
        throw error;
      } finally {
        if (poster) await fs.rm(poster.path, { force: true }).catch(() => {});
      }
    }

    installationCommitted = true;
    try {
      await registerSeriesUpload({ seriesUuid, finalDirectory, metadata, prepared, videos });
    } catch (error) {
      error.contentPreserved = true;
      error.message = `La serie è stata salvata sul RAID, ma SQLite non è stato aggiornato: ${error.message}`;
      throw error;
    }
    const episodes = getCreatedEpisodes.all(seriesUuid);
    return {
      series: {
        seriesUuid,
        title: metadata.title,
        year: metadata.year,
        genres: metadata.genres,
        relativePath: relativePathFromAbsolute(finalDirectory),
      },
      uploadedEpisodes: plan.map((item) => episodes.find((episode) => (
        Number(episode.seasonNumber) === item.seasonNumber && Number(episode.episodeNumber) === item.episodeNumber
      ))).filter(Boolean),
    };
  } catch (error) {
    if (!installationCommitted) {
      if (installedNewSeries) {
        await fs.rm(finalDirectory, { recursive: true, force: true }).catch(() => {});
      } else {
        for (const candidate of installedPaths.reverse()) await fs.rm(candidate, { force: true }).catch(() => {});
      }
    }
    throw error;
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { createSeriesFromUpload };
