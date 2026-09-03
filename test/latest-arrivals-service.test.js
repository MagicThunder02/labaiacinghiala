'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLatestArrivals } = require('../src/services/latest-arrivals-service');

test('Ultimi arrivi ordina per addedAt decrescente e limita a venti elementi', () => {
  const items = Array.from({ length: 25 }, (_, index) => ({
    id: index + 1,
    title: `Titolo ${String(index + 1).padStart(2, '0')}`,
    addedAt: `2026-07-${String(index + 1).padStart(2, '0')}T12:00:00.000Z`,
  }));
  const latest = buildLatestArrivals(items, 20);
  assert.equal(latest.length, 20);
  assert.equal(latest[0].id, 25);
  assert.equal(latest.at(-1).id, 6);
});

test('Ultimi arrivi usa il titolo come ordinamento stabile a parità di data', () => {
  const latest = buildLatestArrivals([
    { id: 1, title: 'Zulu', addedAt: '2026-08-01T12:00:00.000Z' },
    { id: 2, title: 'Alpha', addedAt: '2026-08-01T12:00:00.000Z' },
    { id: 3, title: 'Senza data', addedAt: null },
  ], 20);
  assert.deepEqual(latest.map((item) => item.id), [2, 1, 3]);
});
