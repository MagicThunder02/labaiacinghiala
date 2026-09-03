'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildReadingFilterFacets } = require('../src/services/reading-filter-facets-service');

const items = [
  { genresJson: JSON.stringify(['Fantascienza', 'Avventura']), author: 'Ursula Le Guin', year: 1969 },
  { genresJson: JSON.stringify(['Fantascienza', 'Romanzo']), author: 'Ursula Le Guin', year: 1974 },
  { genresJson: JSON.stringify(['Fantasy', 'Avventura']), author: 'J. R. R. Tolkien', year: 1954 },
  { genresJson: JSON.stringify(['Mistero']), author: 'Agatha Christie', year: 1934 },
];

test('ogni facet Reading applica gli altri filtri ma ignora il proprio', () => {
  const facets = buildReadingFilterFacets(items, { author: 'Ursula Le Guin' });
  assert.deepEqual(facets.genres, ['Avventura', 'Fantascienza', 'Romanzo']);
  assert.deepEqual(facets.years, [1974, 1969]);
  assert.deepEqual(facets.authors, ['Agatha Christie', 'J. R. R. Tolkien', 'Ursula Le Guin']);
});

test('genere e anno restringono insieme gli autori Reading', () => {
  const facets = buildReadingFilterFacets(items, { genre: 'Avventura', year: 1954 });
  assert.deepEqual(facets.authors, ['J. R. R. Tolkien']);
  assert.deepEqual(facets.genres, ['Avventura', 'Fantasy']);
  assert.deepEqual(facets.years, [1969, 1954]);
});

test('il valore Reading selezionato resta visibile anche senza risultati', () => {
  const facets = buildReadingFilterFacets(items, {
    genre: 'Mistero',
    author: 'Ursula Le Guin',
    year: 1954,
  });
  assert.ok(facets.genres.includes('Mistero'));
  assert.ok(facets.authors.includes('Ursula Le Guin'));
  assert.ok(facets.years.includes(1954));
});

test('deduplica e confronti Reading ignorano maiuscole e accenti', () => {
  const facets = buildReadingFilterFacets([
    { genresJson: JSON.stringify(['Narrativa']), author: 'Niccolò Ammaniti', year: 2020 },
    { genresJson: JSON.stringify(['narrativa']), author: 'NICCOLO AMMANITI', year: 2021 },
  ], { author: 'niccolo ammaniti' });

  assert.deepEqual(facets.genres, ['Narrativa']);
  assert.deepEqual(facets.years, [2021, 2020]);
});
