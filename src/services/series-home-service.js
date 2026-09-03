const { buildLatestArrivals } = require('./latest-arrivals-service');

function normalizeGenre(value) {
  return String(value || '').trim().toLocaleLowerCase('it');
}

function stableNoise(profileKey, seriesUuid) {
  const source = `${profileKey}:${seriesUuid}`;
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function timestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildSeriesRecommendations(seriesItems, profileKey, recentIds, limit = 30) {
  const history = seriesItems.filter((series) => series.lastWatchedAt && Number(series.watchedEpisodeCount || 0) > 0);
  const genreWeights = new Map();
  const yearWeights = new Map();
  const decadeWeights = new Map();

  for (const series of history) {
    const episodeCount = Math.max(1, Number(series.episodeCount || 0));
    const completedRatio = Math.min(1, Number(series.completedEpisodes || 0) / episodeCount);
    const watchedRatio = Math.min(1, Number(series.watchedEpisodeCount || 0) / episodeCount);
    const weight = 1 + completedRatio * 2 + watchedRatio;

    for (const rawGenre of series.genres || []) {
      const genre = normalizeGenre(rawGenre);
      if (genre) genreWeights.set(genre, (genreWeights.get(genre) || 0) + weight);
    }
    if (series.year) {
      const year = Number(series.year);
      yearWeights.set(year, (yearWeights.get(year) || 0) + weight);
      const decade = Math.floor(year / 10) * 10;
      decadeWeights.set(decade, (decadeWeights.get(decade) || 0) + weight);
    }
  }

  const now = Date.now();
  return seriesItems
    .filter((series) => !recentIds.has(series.seriesUuid))
    .map((series) => {
      let score = stableNoise(profileKey, series.seriesUuid) * 0.25;
      for (const rawGenre of series.genres || []) {
        score += genreWeights.get(normalizeGenre(rawGenre)) || 0;
      }
      if (series.year) {
        const year = Number(series.year);
        score += (yearWeights.get(year) || 0) * 0.7;
        score += (decadeWeights.get(Math.floor(year / 10) * 10) || 0) * 0.28;
      }

      if (history.length === 0) {
        const ageDays = Math.max(0, (now - timestamp(series.addedAt)) / 86400000);
        score += Math.max(0, 2 - ageDays / 180);
      }

      const alreadyWatched = Boolean(series.lastWatchedAt && Number(series.watchedEpisodeCount || 0) > 0);
      if (alreadyWatched) score *= 0.35;
      return { series, score, alreadyWatched };
    })
    .sort((a, b) => (
      Number(a.alreadyWatched) - Number(b.alreadyWatched)
      || b.score - a.score
      || a.series.title.localeCompare(b.series.title, 'it', { sensitivity: 'base' })
    ))
    .slice(0, Math.max(0, Number(limit) || 0))
    .map((item) => item.series);
}

function buildSeriesHome(seriesItems, profileKey, { recentLimit = 20, latestLimit = 20, recommendedLimit = 30 } = {}) {
  const items = Array.isArray(seriesItems) ? seriesItems : [];
  const recent = items
    .filter((series) => series.lastWatchedAt && Number(series.watchedEpisodeCount || 0) > 0)
    .sort((a, b) => timestamp(b.lastWatchedAt) - timestamp(a.lastWatchedAt))
    .slice(0, Math.max(0, Number(recentLimit) || 0));
  const recentIds = new Set(recent.map((series) => series.seriesUuid));
  return {
    recent,
    latest: buildLatestArrivals(items, latestLimit),
    recommended: buildSeriesRecommendations(items, profileKey, recentIds, recommendedLimit),
  };
}

module.exports = {
  buildSeriesHome,
  buildSeriesRecommendations,
  stableNoise,
};
