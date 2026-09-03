const express = require('express');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const mime = require('mime-types');
const db = require('../database');
const { parseByteRange } = require('../utils/range');
const { getProfileKey } = require('../utils/profile-key');
const { findCachedPoster } = require('../services/content-metadata-service');
const { movieFilePath, moviePosterPath } = require('../services/video-library-path-service');
const { buildLatestArrivals } = require('../services/latest-arrivals-service');
const { buildMovieFilterFacets } = require('../services/movie-filter-facets-service');
const { matchesCatalogSearch } = require('../services/catalog-search-service');

const router = express.Router();

const HOME_RECENT_LIMIT = 20;
const HOME_LATEST_LIMIT = 20;
const HOME_RECOMMENDED_LIMIT = 30;

const selectColumns = `
  SELECT
    m.id,
    m.title,
    m.year,
    m.file_name AS fileName,
    m.relative_path AS relativePath,
    m.extension,
    m.mime_type AS mimeType,
    m.size_bytes AS sizeBytes,
    m.media_type AS mediaType,
    m.series_title AS seriesTitle,
    m.season_number AS seasonNumber,
    m.episode_number AS episodeNumber,
    m.genres_json AS genresJson,
    m.director,
    CASE WHEN COALESCE(m.poster_path, '') = '' THEN 0 ELSE 1 END AS hasPoster,
    m.added_at AS addedAt,
    m.updated_at AS updatedAt,
    m.available,
    COALESCE(p.seconds, 0) AS progressSeconds,
    COALESCE(p.duration_seconds, 0) AS durationSeconds,
    COALESCE(p.completed, 0) AS completed,
    p.updated_at AS lastWatchedAt,
    CASE WHEN f.movie_id IS NULL THEN 0 ELSE 1 END AS favorite
  FROM movies m
  LEFT JOIN watch_progress p
    ON p.movie_id = m.id AND p.profile_key = ?
  LEFT JOIN favorites f
    ON f.movie_id = m.id AND f.profile_key = ?
`;

const listByTitle = db.prepare(`${selectColumns}
  WHERE m.available = 1
    AND (? = 'all' OR m.media_type = ?)
    AND (? = 0 OR f.movie_id IS NOT NULL)
    AND (? = 0 OR (COALESCE(p.seconds, 0) > 10 AND COALESCE(p.completed, 0) = 0))
    AND (? = 0 OR m.year = ?)
    AND (? = '' OR COALESCE(m.director, '') = ? COLLATE NOCASE)
  ORDER BY
    COALESCE(NULLIF(m.series_title, ''), m.title) COLLATE NOCASE ASC,
    COALESCE(m.season_number, 0) ASC,
    COALESCE(m.episode_number, 0) ASC,
    m.title COLLATE NOCASE ASC
`);

const listByAdded = db.prepare(`${selectColumns}
  WHERE m.available = 1
    AND (? = 'all' OR m.media_type = ?)
    AND (? = 0 OR f.movie_id IS NOT NULL)
    AND (? = 0 OR (COALESCE(p.seconds, 0) > 10 AND COALESCE(p.completed, 0) = 0))
    AND (? = 0 OR m.year = ?)
    AND (? = '' OR COALESCE(m.director, '') = ? COLLATE NOCASE)
  ORDER BY m.added_at DESC, m.title COLLATE NOCASE ASC
`);

const listMoviesForHome = db.prepare(`${selectColumns}
  WHERE m.media_type = 'movie' AND m.available = 1
  ORDER BY m.title COLLATE NOCASE ASC
`);

const listFilterMetadata = db.prepare(`
  SELECT year, genres_json AS genresJson, director
  FROM movies
  WHERE media_type = 'movie' AND available = 1
`);

const getMovie = db.prepare(`${selectColumns}
  WHERE m.id = ? AND m.available = 1
`);

const getRawMovie = db.prepare(`SELECT * FROM movies WHERE id = ?`);

function toBoolean(value) {
  return value === 1 || value === true;
}

function parseGenres(value) {
  try {
    const genres = JSON.parse(value || '[]');
    return Array.isArray(genres)
      ? genres.map((genre) => String(genre).trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function serializeMovie(row) {
  const hasPoster = toBoolean(row.hasPoster)
    || Boolean(row.posterPath ?? row.poster_path);

  return {
    id: row.id,
    title: row.title,
    year: row.year,
    fileName: row.fileName ?? row.file_name,
    relativePath: row.relativePath ?? row.relative_path,
    extension: row.extension,
    mimeType: row.mimeType ?? row.mime_type,
    sizeBytes: Number(row.sizeBytes ?? row.size_bytes ?? 0),
    mediaType: row.mediaType ?? row.media_type ?? 'movie',
    seriesTitle: row.seriesTitle ?? row.series_title ?? null,
    seasonNumber: row.seasonNumber ?? row.season_number ?? null,
    episodeNumber: row.episodeNumber ?? row.episode_number ?? null,
    genres: parseGenres(row.genresJson ?? row.genres_json),
    director: row.director || null,
    addedAt: row.addedAt ?? row.added_at,
    updatedAt: row.updatedAt ?? row.updated_at,
    lastWatchedAt: row.lastWatchedAt ?? row.last_watched_at ?? null,
    progressSeconds: Number(row.progressSeconds ?? row.progress_seconds ?? 0),
    durationSeconds: Number(row.durationSeconds ?? row.duration_seconds ?? 0),
    completed: toBoolean(row.completed),
    favorite: toBoolean(row.favorite),
    available: row.available === undefined ? true : toBoolean(row.available),
    streamUrl: `/api/movies/${row.id}/stream`,
    posterUrl: hasPoster
      ? `/api/movies/${row.id}/poster?v=${encodeURIComponent(row.updatedAt ?? row.updated_at ?? '')}`
      : null,
  };
}

function parseMediaType(value) {
  const requested = String(value || 'all').toLowerCase();
  return ['movie', 'series'].includes(requested) ? requested : 'all';
}

function parseFlag(value) {
  return ['1', 'true', 'yes'].includes(String(value || '').toLowerCase()) ? 1 : 0;
}

function parseYear(value) {
  const year = Number.parseInt(value, 10);
  return Number.isInteger(year) && year > 0 ? year : 0;
}

function parseLimit(value) {
  if (value === undefined || value === null || value === '') return null;
  const limit = Number.parseInt(value, 10);
  if (!Number.isInteger(limit) || limit < 1) return 50;
  return Math.min(limit, 50);
}

function parseOffset(value) {
  const offset = Number.parseInt(value, 10);
  return Number.isInteger(offset) && offset > 0 ? offset : 0;
}

function normalizeGenre(value) {
  return String(value || '').trim().toLocaleLowerCase('it');
}

function randomSample(items, limit) {
  const pool = [...items];
  const selectedCount = Math.min(Math.max(Number(limit) || 0, 0), pool.length);

  for (let index = 0; index < selectedCount; index += 1) {
    const swapIndex = index + Math.floor(Math.random() * (pool.length - index));
    [pool[index], pool[swapIndex]] = [pool[swapIndex], pool[index]];
  }

  return pool.slice(0, selectedCount);
}

function stableNoise(profileKey, movieId) {
  const source = `${profileKey}:${movieId}`;
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function buildRecommendations(movies, profileKey, recentIds, limit = HOME_RECOMMENDED_LIMIT) {
  const history = movies.filter((movie) => movie.lastWatchedAt && movie.progressSeconds > 5);
  const genreWeights = new Map();
  const yearWeights = new Map();
  const decadeWeights = new Map();

  for (const movie of history) {
    const completionRatio = movie.durationSeconds > 0
      ? Math.min(1, movie.progressSeconds / movie.durationSeconds)
      : 0.35;
    const weight = 1 + completionRatio * 2 + (movie.completed ? 1.5 : 0) + (movie.favorite ? 1 : 0);

    for (const genre of movie.genres) {
      genreWeights.set(genre, (genreWeights.get(genre) || 0) + weight);
    }
    if (movie.year) {
      yearWeights.set(movie.year, (yearWeights.get(movie.year) || 0) + weight);
      const decade = Math.floor(movie.year / 10) * 10;
      decadeWeights.set(decade, (decadeWeights.get(decade) || 0) + weight);
    }
  }

  const now = Date.now();
  return movies
    .filter((movie) => !recentIds.has(movie.id))
    .map((movie) => {
      let score = stableNoise(profileKey, movie.id) * 0.25;
      for (const genre of movie.genres) score += genreWeights.get(genre) || 0;
      if (movie.year) {
        score += (yearWeights.get(movie.year) || 0) * 0.7;
        score += (decadeWeights.get(Math.floor(movie.year / 10) * 10) || 0) * 0.28;
      }

      if (history.length === 0) {
        const addedAt = Date.parse(movie.addedAt || '') || 0;
        const ageDays = Math.max(0, (now - addedAt) / 86400000);
        score += Math.max(0, 2 - ageDays / 180);
        if (movie.posterUrl) score += 0.5;
      }

      const alreadyWatched = Boolean(movie.lastWatchedAt && movie.progressSeconds > 5);
      if (alreadyWatched) score *= 0.35;
      return { movie, score, alreadyWatched };
    })
    .sort((a, b) => (
      Number(a.alreadyWatched) - Number(b.alreadyWatched)
      || b.score - a.score
      || a.movie.title.localeCompare(b.movie.title, 'it', { sensitivity: 'base' })
    ))
    .slice(0, limit)
    .map((item) => item.movie);
}

router.get('/filters', (req, res) => {
  const items = listFilterMetadata.all().map((row) => ({
    genres: parseGenres(row.genresJson),
    director: String(row.director || '').trim(),
    year: Number.isInteger(row.year) ? row.year : 0,
  }));

  res.json(buildMovieFilterFacets(items, {
    genre: req.query.genre,
    director: req.query.director,
    year: req.query.year,
  }));
});

router.get('/home', (req, res) => {
  const profileKey = getProfileKey(req);
  const movies = listMoviesForHome.all(profileKey, profileKey).map(serializeMovie);
  const recent = movies
    .filter((movie) => movie.lastWatchedAt && movie.progressSeconds > 5)
    .sort((a, b) => Date.parse(b.lastWatchedAt) - Date.parse(a.lastWatchedAt))
    .slice(0, HOME_RECENT_LIMIT);
  const recentIds = new Set(recent.map((movie) => movie.id));
  const latest = buildLatestArrivals(movies, HOME_LATEST_LIMIT);
  const recommended = buildRecommendations(movies, profileKey, recentIds, HOME_RECOMMENDED_LIMIT);

  res.json({ recent, latest, recommended });
});

router.get('/:id/similar', (req, res) => {
  const profileKey = getProfileKey(req);
  const currentRow = getMovie.get(profileKey, profileKey, req.params.id);
  if (!currentRow) return res.status(404).json({ error: 'Contenuto non trovato.' });

  const currentMovie = serializeMovie(currentRow);
  const currentGenres = new Set(currentMovie.genres.map(normalizeGenre).filter(Boolean));
  if (!currentGenres.size) {
    res.set('Cache-Control', 'no-store');
    return res.json({ movies: [], count: 0 });
  }

  const candidates = listMoviesForHome
    .all(profileKey, profileKey)
    .map(serializeMovie)
    .filter((movie) => (
      movie.id !== currentMovie.id
      && movie.genres.some((genre) => currentGenres.has(normalizeGenre(genre)))
    ));

  const movies = randomSample(candidates, 10);
  res.set('Cache-Control', 'no-store');
  return res.json({ movies, count: movies.length });
});

router.get('/', (req, res) => {
  const profileKey = getProfileKey(req);
  const search = String(req.query.search || '').trim();
  const mediaType = parseMediaType(req.query.type);
  const favoritesOnly = parseFlag(req.query.favorite);
  const continueOnly = parseFlag(req.query.continue);
  const year = parseYear(req.query.year);
  const genre = String(req.query.genre || '').trim();
  const director = String(req.query.director || '').trim();
  const statement = req.query.sort === 'added' ? listByAdded : listByTitle;
  let rows = statement.all(
    profileKey,
    profileKey,
    mediaType,
    mediaType,
    favoritesOnly,
    continueOnly,
    year,
    year,
    director,
    director,
  );

  if (search) {
    rows = rows.filter((row) => matchesCatalogSearch(search, [
      row.title,
      row.seriesTitle,
      row.fileName,
      row.year,
      row.director,
      parseGenres(row.genresJson),
    ]));
  }

  if (genre) {
    rows = rows.filter((row) => parseGenres(row.genresJson).some((item) => (
      item.localeCompare(genre, 'it', { sensitivity: 'base' }) === 0
    )));
  }

  const count = rows.length;
  const limit = parseLimit(req.query.limit);
  const offset = parseOffset(req.query.offset);
  const pageRows = limit === null ? rows : rows.slice(offset, offset + limit);

  res.json({ movies: pageRows.map(serializeMovie), count, offset, limit });
});

router.get('/:id', (req, res) => {
  const profileKey = getProfileKey(req);
  const movie = getMovie.get(profileKey, profileKey, req.params.id);
  if (!movie) return res.status(404).json({ error: 'Contenuto non trovato.' });
  return res.json({ movie: serializeMovie(movie) });
});

router.get('/:id/poster', async (req, res, next) => {
  const movie = getRawMovie.get(req.params.id);
  if (!movie) return res.status(404).end();

  let posterPath = moviePosterPath(movie);
  try {
    if (posterPath) {
      const stats = await fsp.stat(posterPath);
      if (!stats.isFile()) posterPath = null;
    }
  } catch {
    posterPath = null;
  }

  if (!posterPath) posterPath = await findCachedPoster(movie.content_uuid);
  if (!posterPath) return res.status(404).end();

  try {
    const stats = await fsp.stat(posterPath);
    res.set({
      'Content-Type': mime.lookup(posterPath) || 'application/octet-stream',
      'Content-Length': stats.size,
      'Cache-Control': 'private, max-age=86400',
    });
    return fs.createReadStream(posterPath).on('error', next).pipe(res);
  } catch (error) {
    if (error.code === 'ENOENT') return res.status(404).end();
    return next(error);
  }
});

router.get('/:id/stream', async (req, res, next) => {
  const movie = getRawMovie.get(req.params.id);
  if (!movie || Number(movie.available) !== 1) {
    return res.status(404).json({ error: 'Contenuto non disponibile.' });
  }

  try {
    const filePath = movieFilePath(movie);
    const stats = await fsp.stat(filePath);
    if (!stats.isFile()) return res.status(404).json({ error: 'File video non disponibile.' });

    const range = parseByteRange(req.headers.range, stats.size);
    const commonHeaders = {
      'Accept-Ranges': 'bytes',
      'Content-Type': movie.mime_type || 'application/octet-stream',
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(movie.file_name)}`,
      'Cache-Control': 'private, max-age=0, must-revalidate',
    };

    if (range?.invalid) {
      res.set('Content-Range', `bytes */${stats.size}`);
      return res.status(416).end();
    }

    if (range) {
      res.writeHead(206, {
        ...commonHeaders,
        'Content-Range': `bytes ${range.start}-${range.end}/${stats.size}`,
        'Content-Length': range.length,
      });
      return fs.createReadStream(filePath, { start: range.start, end: range.end })
        .on('error', next)
        .pipe(res);
    }

    res.writeHead(200, {
      ...commonHeaders,
      'Content-Length': stats.size,
    });
    return fs.createReadStream(filePath)
      .on('error', next)
      .pipe(res);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({ error: 'File video non disponibile.' });
    }
    return next(error);
  }
});

module.exports = router;
