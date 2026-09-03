const { buildLatestArrivals } = require('./latest-arrivals-service');

function parseGenres(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.map((item) => String(item).trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function normalize(value) {
  return String(value || '').trim().toLocaleLowerCase('it');
}

function stableNoise(profileKey, itemId) {
  const source = `${profileKey}:${itemId}`;
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function buildReadingRecommendations(items, profileKey, recentIds, limit = 30) {
  const history = items.filter((item) => item.bookmarkedAt);
  const genreWeights = new Map();
  const authorWeights = new Map();
  const decadeWeights = new Map();

  for (const item of history) {
    for (const genre of parseGenres(item.genres)) {
      const key = normalize(genre);
      if (key) genreWeights.set(key, (genreWeights.get(key) || 0) + 2);
    }
    const author = normalize(item.author);
    if (author) authorWeights.set(author, (authorWeights.get(author) || 0) + 2.4);
    const year = Number(item.year);
    if (Number.isInteger(year) && year > 0) {
      const decade = Math.floor(year / 10) * 10;
      decadeWeights.set(decade, (decadeWeights.get(decade) || 0) + 0.8);
    }
  }

  const now = Date.now();
  return items
    .filter((item) => !recentIds.has(Number(item.id)))
    .map((item) => {
      let score = stableNoise(profileKey, item.id) * 0.3;
      for (const genre of parseGenres(item.genres)) score += genreWeights.get(normalize(genre)) || 0;
      score += authorWeights.get(normalize(item.author)) || 0;
      const year = Number(item.year);
      if (Number.isInteger(year) && year > 0) score += decadeWeights.get(Math.floor(year / 10) * 10) || 0;

      if (!history.length) {
        const addedAt = Date.parse(item.addedAt || '') || 0;
        const ageDays = Math.max(0, (now - addedAt) / 86400000);
        score += Math.max(0, 2 - ageDays / 180);
        if (item.hasCover || item.coverUrl) score += 0.5;
      }

      const alreadyBookmarked = Boolean(item.bookmarkedAt);
      if (alreadyBookmarked) score *= 0.35;
      return { item, score, alreadyBookmarked };
    })
    .sort((a, b) => (
      Number(a.alreadyBookmarked) - Number(b.alreadyBookmarked)
      || b.score - a.score
      || String(a.item.title || '').localeCompare(String(b.item.title || ''), 'it', { sensitivity: 'base' })
    ))
    .slice(0, Math.max(0, Number(limit) || 0))
    .map((entry) => entry.item);
}

function buildReadingHome(items, profileKey, { recentLimit = 10, latestLimit = 20, recommendedLimit = 30 } = {}) {
  const recent = items
    .filter((item) => item.bookmarkedAt)
    .sort((a, b) => Date.parse(b.bookmarkedAt || '') - Date.parse(a.bookmarkedAt || ''))
    .slice(0, recentLimit);
  const recentIds = new Set(recent.map((item) => Number(item.id)));
  return {
    recent,
    latest: buildLatestArrivals(items, latestLimit),
    recommended: buildReadingRecommendations(items, profileKey, recentIds, recommendedLimit),
  };
}

module.exports = {
  buildReadingHome,
  buildReadingRecommendations,
  parseGenres,
  stableNoise,
};
