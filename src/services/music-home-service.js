'use strict';

const { buildLatestArrivals } = require('./latest-arrivals-service');

function normalizedText(value) {
  return String(value || '').trim().toLocaleLowerCase('it');
}

function artistNames(item) {
  return Array.isArray(item?.artists)
    ? item.artists.map((artist) => normalizedText(artist?.name ?? artist)).filter(Boolean)
    : [];
}

function stableNoise(profileKey, contentId) {
  const source = `${profileKey}:${contentId}`;
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function buildMusicRecommendations(albums, tracks, profileKey, excludedAlbumIds, limit = 30) {
  const history = tracks.filter((track) => track.lastPlayedAt || track.playCount > 0 || track.favorite);
  const genreWeights = new Map();
  const artistWeights = new Map();

  for (const track of history) {
    const playWeight = Math.min(10, Math.max(0, Number(track.playCount) || 0)) * 0.35;
    const completionWeight = Math.min(10, Math.max(0, Number(track.completedCount) || 0)) * 0.4;
    const weight = 1 + playWeight + completionWeight + (track.favorite ? 1 : 0);

    for (const genre of track.genres || []) {
      const key = normalizedText(genre);
      if (key) genreWeights.set(key, (genreWeights.get(key) || 0) + weight);
    }
    for (const artist of artistNames(track)) {
      artistWeights.set(artist, (artistWeights.get(artist) || 0) + weight);
    }
  }

  const now = Date.now();
  return albums
    .filter((album) => !excludedAlbumIds.has(album.albumId))
    .map((album) => {
      let score = stableNoise(profileKey, album.albumId) * 0.25;
      for (const genre of album.genres || []) score += genreWeights.get(normalizedText(genre)) || 0;
      for (const artist of artistNames(album)) score += (artistWeights.get(artist) || 0) * 1.15;

      if (history.length === 0) {
        const addedAt = Date.parse(album.addedAt || '') || 0;
        const ageDays = Math.max(0, (now - addedAt) / 86400000);
        score += Math.max(0, 3 - ageDays / 120);
        if (album.hasCoverArt) score += 0.5;
      }

      const alreadyPlayed = Boolean(album.lastPlayedAt);
      if (alreadyPlayed) score *= 0.35;
      return { album, score, alreadyPlayed };
    })
    .sort((left, right) => (
      Number(left.alreadyPlayed) - Number(right.alreadyPlayed)
      || right.score - left.score
      || String(left.album.title || '').localeCompare(String(right.album.title || ''), 'it', { sensitivity: 'base' })
    ))
    .slice(0, Math.max(0, Number(limit) || 0))
    .map((entry) => entry.album);
}

function buildMusicHome(albums, tracks, profileKey, { recentLimit = 10, latestLimit = 20, recommendedLimit = 30 } = {}) {
  const recent = tracks
    .filter((track) => track.lastPlayedAt)
    .sort((left, right) => Date.parse(right.lastPlayedAt || '') - Date.parse(left.lastPlayedAt || ''))
    .slice(0, recentLimit);
  const recentAlbumIds = new Set(recent.map((track) => track.albumId).filter(Boolean));

  return {
    recent,
    latest: buildLatestArrivals(albums, latestLimit),
    recommended: buildMusicRecommendations(
      albums,
      tracks,
      profileKey,
      recentAlbumIds,
      recommendedLimit,
    ),
  };
}

module.exports = {
  buildMusicHome,
  buildMusicRecommendations,
  stableNoise,
};
