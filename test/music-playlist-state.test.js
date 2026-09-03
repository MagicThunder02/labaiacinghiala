'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  moveTrackIds,
  normalizeTrackIds,
  playlistDraft,
} = require('../public/js/music-playlist-state');

test('riordino playlist sposta un brano di una posizione e rispetta i limiti', () => {
  assert.deepEqual(moveTrackIds(['a', 'b', 'c'], 'b', -1), {
    trackIds: ['b', 'a', 'c'], moved: true, from: 1, to: 0,
  });
  assert.deepEqual(moveTrackIds(['a', 'b', 'c'], 'b', 1), {
    trackIds: ['a', 'c', 'b'], moved: true, from: 1, to: 2,
  });
  assert.equal(moveTrackIds(['a', 'b'], 'a', -1).moved, false);
  assert.equal(moveTrackIds(['a', 'b'], 'b', 1).moved, false);
});

test('stato playlist normalizza identificatori e campi senza inventare percorsi', () => {
  assert.deepEqual(normalizeTrackIds([' a ', 'a', '', 'b']), ['a', 'b']);
  assert.deepEqual(playlistDraft({ name: '  Corsa   sera ', description: '  Ritmo   alto ' }), {
    name: 'Corsa sera',
    description: 'Ritmo alto',
  });
});
