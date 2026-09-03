const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSeriesHome, buildSeriesRecommendations, stableNoise } = require('../src/services/series-home-service');

const series = [
  {
    seriesUuid: 'alpha', title: 'Alpha', year: 2024, genres: ['Drama'],
    episodeCount: 10, completedEpisodes: 2, watchedEpisodeCount: 3,
    lastWatchedAt: '2026-07-30T12:00:00.000Z', addedAt: '2026-06-01T00:00:00.000Z',
  },
  {
    seriesUuid: 'beta', title: 'Beta', year: 2024, genres: ['Drama'],
    episodeCount: 8, completedEpisodes: 0, watchedEpisodeCount: 0,
    lastWatchedAt: null, addedAt: '2026-07-01T00:00:00.000Z',
  },
  {
    seriesUuid: 'gamma', title: 'Gamma', year: 2011, genres: ['Commedia'],
    episodeCount: 12, completedEpisodes: 1, watchedEpisodeCount: 1,
    lastWatchedAt: '2026-07-20T12:00:00.000Z', addedAt: '2025-01-01T00:00:00.000Z',
  },
  {
    seriesUuid: 'delta', title: 'Delta', year: 2014, genres: ['Commedia'],
    episodeCount: 6, completedEpisodes: 0, watchedEpisodeCount: 0,
    lastWatchedAt: null, addedAt: '2026-07-20T00:00:00.000Z',
  },
];

test('series home orders recently watched series by latest episode progress', () => {
  const home = buildSeriesHome(series, 'default', { recentLimit: 10, recommendedLimit: 10 });
  assert.deepEqual(home.recent.map((item) => item.seriesUuid), ['alpha', 'gamma']);
});


test('Ultimi arrivi Serie mostra al massimo venti serie ordinate per aggiunta', () => {
  const home = buildSeriesHome(series, 'default', { recentLimit: 10, latestLimit: 20, recommendedLimit: 10 });
  assert.deepEqual(home.latest.map((item) => item.seriesUuid), ['delta', 'beta', 'alpha', 'gamma']);
});

test('series recommendations exclude items already present in recent rail', () => {
  const home = buildSeriesHome(series, 'default', { recentLimit: 10, recommendedLimit: 10 });
  assert.equal(home.recommended.some((item) => ['alpha', 'gamma'].includes(item.seriesUuid)), false);
});

test('series recommendation scoring favors matching viewing history', () => {
  const recentIds = new Set(['alpha']);
  const recommendations = buildSeriesRecommendations(series, 'default', recentIds, 3);
  assert.equal(recommendations[0].seriesUuid, 'beta');
});

test('series recommendation noise is stable per profile and series', () => {
  assert.equal(stableNoise('default', 'alpha'), stableNoise('default', 'alpha'));
  assert.notEqual(stableNoise('default', 'alpha'), stableNoise('default', 'beta'));
});
