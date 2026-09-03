const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSeriesFilters, filterSeriesRows, parseGenres, parseYear } = require('../src/services/series-filter-service');

const rows = [
  { title: 'Alpha', year: 2024, genresJson: JSON.stringify(['Drama', 'Sci-Fi']) },
  { title: 'Beta', year: 2022, genresJson: JSON.stringify(['Commedia']) },
  { title: 'Gamma', year: 2024, genresJson: JSON.stringify(['drama']) },
];

test('series filters collect sorted genres and years', () => {
  assert.deepEqual(buildSeriesFilters(rows), {
    genres: ['Commedia', 'Drama', 'Sci-Fi'],
    years: [2024, 2022],
  });
});

test('series row filtering matches genre case-insensitively', () => {
  assert.deepEqual(filterSeriesRows(rows, { genre: 'DRAMA' }).map((row) => row.title), ['Alpha', 'Gamma']);
});

test('series row filtering combines genre and year', () => {
  assert.deepEqual(filterSeriesRows(rows, { genre: 'Commedia', year: 2022 }).map((row) => row.title), ['Beta']);
  assert.deepEqual(filterSeriesRows(rows, { genre: 'Commedia', year: 2024 }), []);
});

test('series filter parsing is defensive', () => {
  assert.deepEqual(parseGenres('not json'), []);
  assert.equal(parseYear('2025'), 2025);
  assert.equal(parseYear('nope'), 0);
});


test('series facets applicano l altro filtro ma ignorano il proprio', () => {
  assert.deepEqual(buildSeriesFilters(rows, { year: 2024 }), {
    genres: ['Drama', 'Sci-Fi'],
    years: [2024, 2022],
  });
  assert.deepEqual(buildSeriesFilters(rows, { genre: 'drama' }), {
    genres: ['Commedia', 'Drama', 'Sci-Fi'],
    years: [2024],
  });
});

test('series facets mantengono visibile il valore selezionato senza risultati', () => {
  const filters = buildSeriesFilters(rows, { genre: 'Commedia', year: 2024 });
  assert.ok(filters.genres.includes('Commedia'));
  assert.ok(filters.years.includes(2024));
});
