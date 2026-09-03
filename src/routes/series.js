const express = require('express');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const mime = require('mime-types');
const db = require('../database');
const { getProfileKey } = require('../utils/profile-key');
const { findCachedPoster } = require('../services/content-metadata-service');
const { seriesPosterPath } = require('../services/video-library-path-service');
const { buildSeriesFilters, filterSeriesRows, parseGenres, parseYear } = require('../services/series-filter-service');
const { buildSeriesHome } = require('../services/series-home-service');
const { matchesCatalogSearch } = require('../services/catalog-search-service');
const { buildSimilarSeriesRows } = require('../services/series-similar-service');

const router = express.Router();

const listSeries = db.prepare(`
  SELECT s.series_uuid AS seriesUuid, s.title, s.year, s.genres_json AS genresJson,
         s.poster_path AS posterPath, s.added_at AS addedAt, s.updated_at AS updatedAt,
         s.relative_path AS relativePath,
         COUNT(m.id) AS episodeCount,
         COUNT(DISTINCT m.season_number) AS seasonCount,
         GROUP_CONCAT(DISTINCT NULLIF(TRIM(m.director), '')) AS directorsText
  FROM series s
  LEFT JOIN movies m ON m.series_uuid = s.series_uuid AND m.available = 1 AND m.media_type = 'series'
  WHERE s.available = 1
  GROUP BY s.id
  ORDER BY s.title COLLATE NOCASE ASC
`);

const listFilterMetadata = db.prepare(`
  SELECT year, genres_json AS genresJson
  FROM series
  WHERE available = 1
`);

const getSeries = db.prepare(`
  SELECT series_uuid AS seriesUuid, title, year, genres_json AS genresJson,
         poster_path AS posterPath, updated_at AS updatedAt, relative_path AS relativePath,
         directory_path AS directoryPath, added_at AS addedAt
  FROM series
  WHERE series_uuid = ? AND available = 1
`);

const getEpisodes = db.prepare(`
  SELECT m.id, m.title, m.year, m.file_name AS fileName, m.relative_path AS relativePath,
         m.extension, m.mime_type AS mimeType, m.size_bytes AS sizeBytes,
         m.series_uuid AS seriesUuid, m.series_title AS seriesTitle,
         m.season_number AS seasonNumber, m.episode_number AS episodeNumber,
         m.updated_at AS updatedAt,
         COALESCE(p.seconds, 0) AS progressSeconds,
         COALESCE(p.duration_seconds, 0) AS durationSeconds,
         COALESCE(p.completed, 0) AS completed,
         p.updated_at AS lastWatchedAt
  FROM movies m
  LEFT JOIN watch_progress p ON p.movie_id = m.id AND p.profile_key = ?
  WHERE m.series_uuid = ? AND m.media_type = 'series' AND m.available = 1
  ORDER BY COALESCE(m.season_number, 0), COALESCE(m.episode_number, 0), m.id
`);

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

function serializeEpisode(row) {
  return {
    id: Number(row.id),
    title: row.title,
    fileName: row.fileName,
    relativePath: row.relativePath,
    extension: row.extension,
    mimeType: row.mimeType,
    sizeBytes: Number(row.sizeBytes || 0),
    seriesUuid: row.seriesUuid,
    seriesTitle: row.seriesTitle,
    seasonNumber: row.seasonNumber == null ? null : Number(row.seasonNumber),
    episodeNumber: row.episodeNumber == null ? null : Number(row.episodeNumber),
    progressSeconds: Number(row.progressSeconds || 0),
    durationSeconds: Number(row.durationSeconds || 0),
    completed: Boolean(row.completed),
    lastWatchedAt: row.lastWatchedAt || null,
    streamUrl: `/api/movies/${row.id}/stream`,
  };
}

function chooseResumeEpisode(episodes) {
  const inProgress = episodes
    .filter((episode) => episode.progressSeconds > 10 && !episode.completed)
    .sort((a, b) => Date.parse(b.lastWatchedAt || 0) - Date.parse(a.lastWatchedAt || 0));
  if (inProgress.length) return inProgress[0];
  const firstUncompleted = episodes.find((episode) => !episode.completed);
  return firstUncompleted || episodes[0] || null;
}

function serializeSeries(row, episodes = []) {
  const resumeEpisode = chooseResumeEpisode(episodes);
  const completedEpisodes = episodes.filter((episode) => episode.completed).length;
  const watchedEpisodes = episodes.filter((episode) => episode.lastWatchedAt && (episode.progressSeconds > 5 || episode.completed));
  const lastWatchedAt = watchedEpisodes
    .map((episode) => episode.lastWatchedAt)
    .filter(Boolean)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null;
  const seasons = [...new Set(episodes.map((episode) => episode.seasonNumber).filter(Number.isInteger))].sort((a, b) => a - b);
  return {
    seriesUuid: row.seriesUuid,
    title: row.title,
    year: row.year == null ? null : Number(row.year),
    addedAt: row.addedAt || null,
    lastWatchedAt,
    watchedEpisodeCount: watchedEpisodes.length,
    genres: parseGenres(row.genresJson),
    relativePath: row.relativePath || null,
    episodeCount: episodes.length || Number(row.episodeCount || 0),
    seasonCount: seasons.length || Number(row.seasonCount || 0),
    seasons,
    completedEpisodes,
    progressPercent: episodes.length ? Math.round(completedEpisodes / episodes.length * 100) : 0,
    resumeEpisodeId: resumeEpisode?.id || null,
    posterUrl: `/api/series/${encodeURIComponent(row.seriesUuid)}/poster?v=${encodeURIComponent(row.updatedAt || '')}`,
  };
}

router.get('/filters', (req, res) => {
  res.json(buildSeriesFilters(listFilterMetadata.all(), {
    genre: req.query.genre,
    year: req.query.year,
  }));
});

router.get('/', (req, res) => {
  const profileKey = getProfileKey(req);
  const search = String(req.query.search || '').trim().slice(0, 200);
  const genre = String(req.query.genre || '').trim();
  const year = parseYear(req.query.year);
  let rows = filterSeriesRows(listSeries.all(), { genre, year });
  if (search) {
    rows = rows.filter((row) => matchesCatalogSearch(search, [
      row.title,
      row.year,
      parseGenres(row.genresJson),
      row.directorsText,
    ]));
  }
  const count = rows.length;
  const limit = parseLimit(req.query.limit);
  const offset = parseOffset(req.query.offset);
  const pageRows = limit === null ? rows : rows.slice(offset, offset + limit);
  const series = pageRows.map((row) => {
    const episodes = getEpisodes.all(profileKey, row.seriesUuid).map(serializeEpisode);
    return serializeSeries(row, episodes);
  });
  res.json({ series, count, offset, limit });
});

router.get('/home', (req, res) => {
  const profileKey = getProfileKey(req);
  const seriesItems = listSeries.all().map((row) => {
    const episodes = getEpisodes.all(profileKey, row.seriesUuid).map(serializeEpisode);
    return serializeSeries(row, episodes);
  });
  res.json(buildSeriesHome(seriesItems, profileKey));
});

router.get('/:seriesUuid/similar', (req, res) => {
  const currentRow = getSeries.get(req.params.seriesUuid);
  if (!currentRow) return res.status(404).json({ error: 'Serie non trovata.' });

  const profileKey = getProfileKey(req);
  const similarRows = buildSimilarSeriesRows(currentRow, listSeries.all(), { limit: 10 });
  const series = similarRows.map((row) => {
    const episodes = getEpisodes.all(profileKey, row.seriesUuid).map(serializeEpisode);
    return serializeSeries(row, episodes);
  });

  res.set('Cache-Control', 'no-store');
  return res.json({ series, count: series.length });
});

router.get('/:seriesUuid', (req, res) => {
  const row = getSeries.get(req.params.seriesUuid);
  if (!row) return res.status(404).json({ error: 'Serie non trovata.' });
  const profileKey = getProfileKey(req);
  const episodes = getEpisodes.all(profileKey, row.seriesUuid).map(serializeEpisode);
  const series = serializeSeries(row, episodes);
  const grouped = new Map();
  for (const episode of episodes) {
    const season = Number.isInteger(episode.seasonNumber) && episode.seasonNumber > 0 ? episode.seasonNumber : 1;
    if (!grouped.has(season)) grouped.set(season, []);
    grouped.get(season).push(episode);
  }
  return res.json({
    series: {
      ...series,
      episodes,
      seasonGroups: [...grouped.entries()].map(([seasonNumber, items]) => ({ seasonNumber, episodes: items })),
    },
  });
});

router.get('/:seriesUuid/poster', async (req, res, next) => {
  const row = getSeries.get(req.params.seriesUuid);
  if (!row) return res.status(404).end();
  let posterPath = seriesPosterPath(row);
  try {
    if (posterPath && !(await fsp.stat(posterPath)).isFile()) posterPath = null;
  } catch {
    posterPath = null;
  }
  if (!posterPath) posterPath = await findCachedPoster(row.seriesUuid);
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

module.exports = router;
