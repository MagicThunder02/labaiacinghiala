const express = require('express');
const fs = require('node:fs/promises');
const path = require('node:path');
const db = require('../database');
const config = require('../config');
const { normalizeGenres } = require('../utils/movie-metadata');
const { sanitizeFileStem } = require('../utils/safe-filename');
const { parsePosterDataUrl } = require('../services/managed-poster-service');
const {
  STORAGE_VERSION,
  previousMetadataPath,
  stageContentMetadataChange,
  readContentMetadata,
  normalizeDocument,
  writeJsonAtomically,
} = require('../services/content-metadata-service');
const { SERIES_STORAGE_VERSION, stageSeriesMetadataChange } = require('../services/series-metadata-service');
const { READING_CATEGORIES } = require('../reading-formats');
const { READING_STORAGE_VERSION, stageReadingMetadataChange } = require('../services/reading-metadata-service');
const { getProfileKey } = require('../utils/profile-key');
const {
  ContentDeleteError,
  deleteMovie,
  deleteSeries,
  deleteReading,
} = require('../services/content-delete-service');
const { listMusicAlbums, listMusicTracks } = require('../services/music-catalog-service');
const {
  relativePathFromAbsolute,
  resolveStoredLibraryPath,
  movieFilePath,
  movieMetadataPath,
  moviePosterPath,
  seriesDirectoryPath,
  seriesPosterPath,
} = require('../services/video-library-path-service');
const {
  readingFilePath,
  readingMetadataPath,
  readingCoverPath,
  relativeReadingPathFromAbsolute,
} = require('../services/reading-library-path-service');

const router = express.Router();

const listMovieItems = db.prepare(`
  SELECT id, title, year, file_name AS fileName, relative_path AS relativePath,
         media_type AS mediaType, director, available,
         CASE WHEN COALESCE(poster_path, '') = '' THEN 0 ELSE 1 END AS hasPoster
  FROM movies
  WHERE media_type = 'movie' AND available = 1
    AND (? = '' OR title LIKE ? COLLATE NOCASE OR file_name LIKE ? COLLATE NOCASE)
  ORDER BY title COLLATE NOCASE
  LIMIT ?
`);
const listSeriesRoots = db.prepare(`
  SELECT series_uuid AS seriesUuid, title, year, relative_path AS relativePath,
         CASE WHEN COALESCE(poster_path, '') = '' THEN 0 ELSE 1 END AS hasPoster
  FROM series
  WHERE available = 1
    AND (? = '' OR title LIKE ? COLLATE NOCASE)
  ORDER BY title COLLATE NOCASE
  LIMIT ?
`);
const listSeriesEpisodes = db.prepare(`
  SELECT id, title, file_name AS fileName, relative_path AS relativePath,
         series_uuid AS seriesUuid, series_title AS seriesTitle,
         season_number AS seasonNumber, episode_number AS episodeNumber
  FROM movies
  WHERE media_type = 'series' AND available = 1 AND series_uuid = ?
  ORDER BY COALESCE(season_number, 0), COALESCE(episode_number, 0), id
`);
const getItem = db.prepare(`
  SELECT m.*, o.title AS override_title, o.year AS override_year,
         o.genres_json AS override_genres_json, o.director AS override_director,
         o.poster_path AS override_poster_path, o.updated_at AS override_updated_at
  FROM movies m
  LEFT JOIN media_metadata_overrides o ON o.movie_id = m.id
  WHERE m.id = ? AND m.available = 1
`);
const getSeries = db.prepare(`
  SELECT series_uuid AS seriesUuid, relative_path AS relativePath,
         title, year, genres_json AS genresJson, poster_path AS posterPath,
         metadata_path AS metadataPath, added_at AS addedAt, updated_at AS updatedAt
  FROM series WHERE series_uuid = ? AND available = 1
`);

const listReadingItems = db.prepare(`
  SELECT id, category, title, year, author, file_name AS fileName, relative_path AS relativePath,
         CASE WHEN COALESCE(cover_path, '') = '' THEN 0 ELSE 1 END AS hasPoster
  FROM reading_items
  WHERE category = ? AND available = 1
    AND (? = '' OR title LIKE ? COLLATE NOCASE OR author LIKE ? COLLATE NOCASE OR file_name LIKE ? COLLATE NOCASE)
  ORDER BY title COLLATE NOCASE
  LIMIT ?
`);
const getReadingItem = db.prepare(`
  SELECT * FROM reading_items WHERE id = ? AND available = 1
`);
const updateReadingItem = db.prepare(`
  UPDATE reading_items SET
    title = ?, year = ?, author = ?, genres_json = ?, cover_path = ?, metadata_path = ?,
    storage_version = ?, available = 1,
    last_seen_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'), missing_since = NULL,
    updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = ?
`);
const findEpisodeConflict = db.prepare(`
  SELECT id FROM movies
  WHERE series_uuid = ? AND media_type = 'series' AND available = 1
    AND season_number = ? AND episode_number = ? AND id <> ?
  LIMIT 1
`);
const upsertOverride = db.prepare(`
  INSERT INTO media_metadata_overrides (
    movie_id, title, year, genres_json, director, poster_path, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(movie_id) DO UPDATE SET
    title = excluded.title, year = excluded.year, genres_json = excluded.genres_json,
    director = excluded.director, poster_path = excluded.poster_path,
    updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
`);
const updateEffectiveMetadata = db.prepare(`
  UPDATE movies SET
    content_uuid = ?, metadata_path = ?, storage_version = ?,
    title = ?, year = ?, genres_json = ?, director = ?, poster_path = ?,
    available = 1, last_seen_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'), missing_since = NULL,
    updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = ?
`);
const updateSeriesRow = db.prepare(`
  UPDATE series SET title = ?, year = ?, genres_json = ?, director = NULL, poster_path = ?,
    metadata_path = ?, storage_version = ${SERIES_STORAGE_VERSION}, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE series_uuid = ?
`);
const updateSeriesEpisodesCommon = db.prepare(`
  UPDATE movies SET series_title = ?, year = ?, genres_json = ?, director = NULL,
    updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE series_uuid = ? AND media_type = 'series'
`);
const updateEpisodeRow = db.prepare(`
  UPDATE movies SET title = ?, season_number = ?, episode_number = ?,
    file_path = ?, relative_path = ?, file_name = ?, metadata_path = ?,
    size_bytes = ?, modified_at = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = ?
`);

function parseJson(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function cleanText(value, { required = false, maximum = 300 } = {}) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (required && !text) throw new Error('Il titolo è obbligatorio.');
  return text ? text.slice(0, maximum) : null;
}
function cleanYear(value) {
  if (value === '' || value === null || value === undefined) return null;
  const year = Number.parseInt(value, 10);
  const maximum = new Date().getFullYear() + 2;
  if (!Number.isInteger(year) || year < 1888 || year > maximum) throw new Error(`L'anno deve essere compreso tra 1888 e ${maximum}.`);
  return year;
}
function cleanReadingYear(value) {
  if (value === '' || value === null || value === undefined) return null;
  const year = Number.parseInt(value, 10);
  const maximum = new Date().getFullYear() + 2;
  if (!Number.isInteger(year) || year < 1000 || year > maximum) throw new Error(`L'anno deve essere compreso tra 1000 e ${maximum}.`);
  return year;
}
function positiveInteger(value, label) {
  const number = Number.parseInt(value, 10);
  if (!Number.isInteger(number) || number < 1 || number > 999) throw new Error(`${label} deve essere compreso tra 1 e 999.`);
  return number;
}
function automaticFor(row) {
  const parsed = parseJson(row.metadata_auto_json, {});
  return parsed?.automatic && typeof parsed.automatic === 'object' ? parsed.automatic : {
    title: row.title, year: row.year, genres: parseJson(row.genres_json, []), director: row.director, posterPath: row.poster_path,
  };
}
function serializeMovieDetail(row) {
  const automatic = automaticFor(row);
  return {
    id: String(row.id), kind: 'movie', category: 'movie', contentId: row.content_uuid,
    fileName: row.file_name, relativePath: row.relative_path, available: Boolean(row.available),
    current: {
      title: row.title, year: row.year, genres: parseJson(row.genres_json, []), director: row.director || '',
      posterUrl: row.poster_path ? `/api/movies/${row.id}/poster?v=${encodeURIComponent(row.updated_at || '')}` : null,
    },
    automatic: {
      title: automatic.title || '', year: automatic.year ?? null,
      genres: Array.isArray(automatic.genres) ? automatic.genres : [], director: automatic.director || '',
      posterUrl: automatic.posterPath ? `/api/metadata/items/${row.id}/automatic-poster` : null,
    },
  };
}
function serializeSeriesDetail(row) {
  return {
    id: `series:${row.seriesUuid}`, kind: 'series', category: 'series', seriesUuid: row.seriesUuid,
    fileName: 'Informazioni serie', relativePath: row.relativePath,
    current: {
      title: row.title, year: row.year, genres: parseJson(row.genresJson, []),
      posterUrl: row.posterPath ? `/api/series/${encodeURIComponent(row.seriesUuid)}/poster?v=${encodeURIComponent(row.updatedAt || '')}` : null,
    },
  };
}
function serializeEpisodeDetail(row) {
  return {
    id: `episode:${row.id}`, kind: 'episode', category: 'series', contentId: row.content_uuid,
    seriesUuid: row.series_uuid, seriesTitle: row.series_title,
    fileName: row.file_name, relativePath: row.relative_path,
    seasonNumber: row.season_number, episodeNumber: row.episode_number,
    current: { title: row.title, year: null, genres: [], posterUrl: null },
  };
}
function serializeReadingDetail(row) {
  return {
    id: `reading:${row.id}`, kind: 'reading', category: row.category, contentId: row.content_uuid,
    fileName: row.file_name, relativePath: row.relative_path, available: Boolean(row.available),
    current: {
      title: row.title, year: row.year, author: row.author || '', genres: parseJson(row.genres_json, []),
      posterUrl: row.cover_path ? `/api/reading/${row.id}/cover?v=${encodeURIComponent(row.updated_at || '')}` : null,
    },
  };
}
function parseEntityId(value) {
  const text = String(value || '');
  if (text.startsWith('series:')) return { kind: 'series', id: text.slice(7) };
  if (text.startsWith('episode:')) return { kind: 'episode', id: Number.parseInt(text.slice(8), 10) };
  if (text.startsWith('reading:')) return { kind: 'reading', id: Number.parseInt(text.slice(8), 10) };
  const number = Number.parseInt(text, 10);
  return { kind: 'movie', id: number };
}

router.get('/status', (req, res) => {
  res.json({ categories: [
    { id: 'movie', label: 'Film', enabled: true }, { id: 'series', label: 'Serie', enabled: true },
    { id: 'music', label: 'Musica', enabled: true }, { id: 'books', label: 'Libri', enabled: true },
    { id: 'comics', label: 'Fumetti', enabled: true }, { id: 'manga', label: 'Manga', enabled: true },
  ], metadataSource: 'local-json' });
});

router.get('/items', (req, res) => {
  const requestedCategory = String(req.query.category || 'movie');
  const category = requestedCategory === 'series' || requestedCategory === 'music' || READING_CATEGORIES.has(requestedCategory)
    ? requestedCategory
    : 'movie';
  const search = String(req.query.search || '').trim().slice(0, 200);
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit || '100', 10) || 100, 1), 250);
  const wildcard = `%${search}%`;
  if (category === 'movie') {
    const items = listMovieItems.all(search, wildcard, wildcard, limit).map((row) => ({
      ...row, id: String(row.id), kind: 'movie', hasPoster: Boolean(row.hasPoster), available: Boolean(row.available),
    }));
    return res.json({ items, count: items.length });
  }
  if (READING_CATEGORIES.has(category)) {
    const items = listReadingItems.all(category, search, wildcard, wildcard, wildcard, limit).map((row) => ({
      ...row, id: `reading:${row.id}`, kind: 'reading', mediaType: 'reading', hasPoster: Boolean(row.hasPoster), depth: 0,
    }));
    return res.json({ items, count: items.length });
  }
  if (category === 'music') {
    const musicScope = String(req.query.musicScope || 'track').toLowerCase() === 'album' ? 'album' : 'track';
    if (musicScope === 'album') {
      const result = listMusicAlbums(getProfileKey(req), { search, limit, sort: 'title' });
      const items = result.albums.map((album) => ({
        id: `music-album:${album.albumId}`,
        albumId: album.albumId,
        kind: 'music-album',
        category: 'music',
        mediaType: 'music',
        title: album.title,
        artists: album.artists,
        year: album.year,
        trackCount: album.trackCount,
        hasPoster: Boolean(album.hasCoverArt),
        depth: 0,
      }));
      return res.json({ items, count: result.count, musicScope });
    }

    const result = listMusicTracks(getProfileKey(req), { search, limit, sort: 'album' });
    const items = result.tracks.map((track) => {
      const trackPrefix = track.trackNumber == null ? '' : `${String(track.trackNumber).padStart(2, '0')} `;
      const extension = String(track.extension || '').startsWith('.') ? track.extension : `.${track.extension || ''}`;
      return {
        id: `music:${track.trackId}`,
        trackId: track.trackId,
        kind: 'music-track',
        category: 'music',
        mediaType: 'music',
        title: track.title,
        fileName: `${trackPrefix}${track.title}${extension === '.' ? '' : extension}`,
        albumTitle: track.albumTitle,
        artists: track.artists,
        albumArtists: track.albumArtists,
        trackNumber: track.trackNumber,
        discNumber: track.discNumber,
        hasPoster: Boolean(track.hasCoverArt),
        depth: 0,
      };
    });
    return res.json({ items, count: result.count, musicScope });
  }

  const roots = listSeriesRoots.all(search, wildcard, limit);
  const items = [];
  for (const root of roots) {
    items.push({
      id: `series:${root.seriesUuid}`, kind: 'series', mediaType: 'series', title: root.title,
      fileName: 'Generale', relativePath: root.relativePath, year: root.year,
      seriesTitle: root.title, hasPoster: Boolean(root.hasPoster), depth: 0,
    });
    for (const episode of listSeriesEpisodes.all(root.seriesUuid)) {
      items.push({ ...episode, id: `episode:${episode.id}`, kind: 'episode', mediaType: 'series', depth: 1 });
    }
  }
  return res.json({ items, count: items.length });
});

router.get('/items/:entityId', (req, res) => {
  const entity = parseEntityId(req.params.entityId);
  if (entity.kind === 'series') {
    const row = getSeries.get(entity.id);
    if (!row) return res.status(404).json({ error: 'Serie non trovata.' });
    return res.json({ item: serializeSeriesDetail(row) });
  }
  if (entity.kind === 'reading') {
    const row = getReadingItem.get(entity.id);
    if (!row) return res.status(404).json({ error: 'Contenuto di lettura non trovato.' });
    return res.json({ item: serializeReadingDetail(row) });
  }
  const row = getItem.get(entity.id);
  if (!row) return res.status(404).json({ error: 'Contenuto non trovato.' });
  return res.json({ item: entity.kind === 'episode' ? serializeEpisodeDetail(row) : serializeMovieDetail(row) });
});


router.delete('/items/:entityId', async (req, res, next) => {
  const entity = parseEntityId(req.params.entityId);
  try {
    let deleted;
    if (entity.kind === 'movie') deleted = await deleteMovie(entity.id);
    else if (entity.kind === 'series') deleted = await deleteSeries(entity.id);
    else if (entity.kind === 'reading') deleted = await deleteReading(entity.id);
    else return res.status(400).json({ error: 'Gli episodi non possono essere eliminati singolarmente dall’editor metadati.' });
    return res.json({ deleted });
  } catch (error) {
    if (error instanceof ContentDeleteError) {
      return res.status(error.statusCode || 409).json({ error: error.message, code: error.code });
    }
    return next(error);
  }
});

router.get('/items/:id/automatic-poster', async (req, res, next) => {
  const row = getItem.get(req.params.id);
  if (!row || row.media_type !== 'movie') return res.status(404).end();
  const automatic = automaticFor(row);
  if (!automatic.posterPath) return res.status(404).end();
  const posterPath = resolveStoredLibraryPath(automatic.posterPath, {
    anchorRelativePath: row.relative_path,
  });
  try {
    const stats = await fs.stat(posterPath);
    if (!stats.isFile()) return res.status(404).end();
    res.set('Cache-Control', 'private, max-age=3600');
    return res.sendFile(posterPath, (error) => { if (error && !res.headersSent) next(error); });
  } catch (error) {
    if (error.code === 'ENOENT') return res.status(404).end();
    return next(error);
  }
});

async function updateMovie(row, body) {
  const title = cleanText(body?.title, { required: true });
  const year = cleanYear(body?.year);
  const genres = normalizeGenres(body?.genres || []).slice(0, 30);
  const director = cleanText(body?.director, { maximum: 500 });
  const posterData = parsePosterDataUrl(body?.posterDataUrl);
  const staged = await stageContentMetadataChange({
    filePath: movieFilePath(row), mediaType: 'movie', knownMetadataPath: movieMetadataPath(row),
    contentId: row.content_uuid, title, year, genres, director,
    seriesTitle: null, seasonNumber: null, episodeNumber: null,
    posterData, legacyPosterPath: moviePosterPath(row), createdAt: row.added_at,
  });
  await staged.apply();
  try {
    db.exec('BEGIN IMMEDIATE');
    const metadataRelativePath = relativePathFromAbsolute(staged.metadataPath);
    const posterRelativePath = staged.posterPath ? relativePathFromAbsolute(staged.posterPath) : null;
    upsertOverride.run(row.id, title, year, JSON.stringify(genres), director, posterRelativePath);
    updateEffectiveMetadata.run(staged.document.contentId, metadataRelativePath, STORAGE_VERSION, title, year, JSON.stringify(genres), director, posterRelativePath, row.id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    await staged.rollback();
    throw error;
  }
  await staged.commit();
  return serializeMovieDetail(getItem.get(row.id));
}

async function updateSeriesMetadata(row, body) {
  const title = cleanText(body?.title, { required: true });
  const year = cleanYear(body?.year);
  const genres = normalizeGenres(body?.genres || []).slice(0, 30);
  const posterData = parsePosterDataUrl(body?.posterDataUrl);
  const staged = await stageSeriesMetadataChange({
    seriesDirectory: seriesDirectoryPath(row), seriesId: row.seriesUuid, title, year, genres,
    posterData, legacyPosterPath: seriesPosterPath(row), createdAt: row.addedAt,
  });
  await staged.apply();
  try {
    db.exec('BEGIN IMMEDIATE');
    updateSeriesRow.run(
      title,
      year,
      JSON.stringify(genres),
      staged.posterPath ? relativePathFromAbsolute(staged.posterPath) : null,
      relativePathFromAbsolute(staged.metadataPath),
      row.seriesUuid,
    );
    updateSeriesEpisodesCommon.run(title, year, JSON.stringify(genres), row.seriesUuid);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    await staged.rollback();
    throw error;
  }
  await staged.commit();
  return serializeSeriesDetail(getSeries.get(row.seriesUuid));
}

async function updateReadingMetadata(row, body) {
  const title = cleanText(body?.title, { required: true });
  const year = cleanReadingYear(body?.year);
  const author = cleanText(body?.author, { maximum: 500 }) || '';
  const genres = normalizeGenres(body?.genres || []).slice(0, 30);
  const posterData = parsePosterDataUrl(body?.posterDataUrl);
  const filePath = readingFilePath(row);
  const staged = await stageReadingMetadataChange({
    itemDirectory: path.dirname(filePath), metadataPath: readingMetadataPath(row),
    contentId: row.content_uuid, category: row.category, documentFile: row.file_name,
    title, year, author, genres, currentCoverPath: readingCoverPath(row),
    posterData, createdAt: row.added_at,
  });
  await staged.apply();
  try {
    const result = updateReadingItem.run(
      title, year, author, JSON.stringify(genres),
      staged.coverPath ? relativeReadingPathFromAbsolute(staged.coverPath, row.category) : null,
      relativeReadingPathFromAbsolute(staged.metadataPath, row.category),
      READING_STORAGE_VERSION, row.id,
    );
    if (Number(result.changes) !== 1) throw new Error('Il contenuto non è più disponibile.');
  } catch (error) {
    await staged.rollback();
    throw error;
  }
  await staged.commit();
  return serializeReadingDetail(getReadingItem.get(row.id));
}

async function updateEpisode(row, body) {
  const series = getSeries.get(row.series_uuid);
  if (!series) throw new Error('La serie dell’episodio non è disponibile.');
  const title = cleanText(body?.title, { required: true });
  const seasonNumber = positiveInteger(body?.seasonNumber, 'La stagione');
  const episodeNumber = positiveInteger(body?.episodeNumber, "L'episodio");
  if (findEpisodeConflict.get(row.series_uuid, seasonNumber, episodeNumber, row.id)) {
    const error = new Error(`S${seasonNumber}E${episodeNumber} esiste già in questa serie.`);
    error.statusCode = 409;
    throw error;
  }

  const oldVideoPath = movieFilePath(row);
  const oldMetadataPath = movieMetadataPath(row);
  const extension = path.extname(row.file_name).toLowerCase();
  const stem = `${sanitizeFileStem(series.title, 'serie')} x ${seasonNumber} x ${episodeNumber}`;
  const targetDirectory = path.join(seriesDirectoryPath(series), `Stagione ${seasonNumber}`);
  const newVideoPath = path.join(targetDirectory, `${stem}${extension}`);
  const newMetadataPath = path.join(targetDirectory, `${stem}.metadata.json`);
  const pathChanged = newVideoPath !== oldVideoPath;
  const metadataPathChanged = newMetadataPath !== oldMetadataPath;

  if (pathChanged) {
    for (const candidate of [newVideoPath, newMetadataPath]) {
      try {
        await fs.access(candidate);
        const error = new Error(`La destinazione ${path.basename(candidate)} esiste già.`);
        error.statusCode = 409;
        throw error;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }

  const current = await readContentMetadata({ filePath: oldVideoPath, mediaType: 'series', knownPath: oldMetadataPath });
  const createdAt = current?.document?.createdAt || row.added_at;
  const document = normalizeDocument({
    contentId: row.content_uuid, type: 'series', title,
    year: null, genres: [], seriesTitle: series.title,
    seasonNumber, episodeNumber, videoFile: path.basename(newVideoPath), posterFile: null,
    createdAt, updatedAt: new Date().toISOString(),
  }, { filePath: newVideoPath, mediaType: 'series', fallbackUuid: row.content_uuid });

  await fs.mkdir(targetDirectory, { recursive: true });
  let movedVideo = false;
  let wroteMetadata = false;
  try {
    if (pathChanged) {
      await fs.rename(oldVideoPath, newVideoPath);
      movedVideo = true;
    }
    await writeJsonAtomically(newMetadataPath, document);
    wroteMetadata = true;
    const stats = await fs.stat(newVideoPath);
    const relativePath = relativePathFromAbsolute(newVideoPath);
    updateEpisodeRow.run(
      title,
      seasonNumber,
      episodeNumber,
      relativePath,
      relativePath,
      path.basename(newVideoPath),
      relativePathFromAbsolute(newMetadataPath),
      stats.size,
      Math.trunc(stats.mtimeMs),
      row.id,
    );
    if (metadataPathChanged) {
      await fs.rm(oldMetadataPath, { force: true }).catch(() => {});
      await fs.rm(previousMetadataPath(oldMetadataPath), { force: true }).catch(() => {});
    }
  } catch (error) {
    if (wroteMetadata && metadataPathChanged) await fs.rm(newMetadataPath, { force: true }).catch(() => {});
    if (movedVideo) await fs.rename(newVideoPath, oldVideoPath).catch(() => {});
    throw error;
  }
  return serializeEpisodeDetail(getItem.get(row.id));
}

router.put('/items/:entityId', async (req, res, next) => {
  const entity = parseEntityId(req.params.entityId);
  try {
    let item;
    if (entity.kind === 'series') {
      const row = getSeries.get(entity.id);
      if (!row) return res.status(404).json({ error: 'Serie non trovata.' });
      item = await updateSeriesMetadata(row, req.body);
    } else if (entity.kind === 'reading') {
      const row = getReadingItem.get(entity.id);
      if (!row) return res.status(404).json({ error: 'Contenuto di lettura non trovato.' });
      item = await updateReadingMetadata(row, req.body);
    } else {
      const row = getItem.get(entity.id);
      if (!row) return res.status(404).json({ error: 'Contenuto non trovato.' });
      item = entity.kind === 'episode' || row.media_type === 'series'
        ? await updateEpisode(row, req.body)
        : await updateMovie(row, req.body);
    }
    return res.json({ item });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    if (/obbligatorio|anno|copertina|Formato|vuota|stagione|episodio/i.test(error.message)) return res.status(400).json({ error: error.message });
    return next(error);
  }
});

module.exports = router;
