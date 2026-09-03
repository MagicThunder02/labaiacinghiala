'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildMusicHome,
  buildMusicRecommendations,
  stableNoise,
} = require('../src/services/music-home-service');

const albums = [
  {
    albumId: 'album-recent', title: 'Già ascoltato', artists: [{ name: 'Artista Uno' }],
    genres: ['Rock'], addedAt: '2026-07-01T00:00:00Z', lastPlayedAt: '2026-08-01T00:00:00Z',
  },
  {
    albumId: 'album-affine', title: 'Affine', artists: [{ name: 'Artista Uno' }],
    genres: ['Rock'], addedAt: '2026-07-20T00:00:00Z', lastPlayedAt: null,
  },
  {
    albumId: 'album-altro', title: 'Altro', artists: [{ name: 'Artista Due' }],
    genres: ['Jazz'], addedAt: '2026-07-25T00:00:00Z', lastPlayedAt: null,
  },
];

const tracks = [
  {
    trackId: 'track-old', albumId: 'album-recent', title: 'Vecchio', artists: [{ name: 'Artista Uno' }],
    genres: ['Rock'], lastPlayedAt: '2026-07-20T00:00:00Z', playCount: 2, completedCount: 1,
  },
  {
    trackId: 'track-new', albumId: 'album-recent', title: 'Nuovo', artists: [{ name: 'Artista Uno' }],
    genres: ['Rock'], lastPlayedAt: '2026-08-01T00:00:00Z', playCount: 4, completedCount: 2,
  },
];

test('home musica limita i recenti a dieci brani distinti e li ordina per ultimo ascolto', () => {
  const manyTracks = Array.from({ length: 12 }, (_, index) => ({
    ...tracks[0],
    trackId: `track-${index}`,
    lastPlayedAt: `2026-07-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
  }));
  const home = buildMusicHome(albums, manyTracks, 'default');
  assert.equal(home.recent.length, 10);
  assert.equal(home.recent[0].trackId, 'track-11');
  assert.equal(home.recent.at(-1).trackId, 'track-2');
});


test('Ultimi arrivi Musica mostra album ordinati per aggiunta', () => {
  const home = buildMusicHome(albums, tracks, 'default');
  assert.deepEqual(home.latest.map((album) => album.albumId), [
    'album-altro',
    'album-affine',
    'album-recent',
  ]);
});

test('Per te esclude gli album già rappresentati nei recenti e favorisce affinità di artista e genere', () => {
  const home = buildMusicHome(albums, tracks, 'default');
  assert.equal(home.recommended.some((album) => album.albumId === 'album-recent'), false);
  assert.equal(home.recommended[0].albumId, 'album-affine');
});

test('rumore raccomandazioni musica resta stabile per profilo e album', () => {
  assert.equal(stableNoise('default', 'album-affine'), stableNoise('default', 'album-affine'));
  assert.notEqual(stableNoise('default', 'album-affine'), stableNoise('default', 'album-altro'));
  assert.equal(buildMusicRecommendations(albums, tracks, 'default', new Set(['album-recent']), 1).length, 1);
});
