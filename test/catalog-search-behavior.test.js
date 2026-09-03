'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  matchesCatalogSearch,
  normalizeCatalogSearch,
} = require('../src/services/catalog-search-service');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('ricerca catalogo normalizza accenti e può combinare metadati diversi', () => {
  assert.equal(normalizeCatalogSearch('  Fantascienza  '), 'fantascienza');
  assert.equal(normalizeCatalogSearch('Miyazáki'), 'miyazaki');
  assert.equal(matchesCatalogSearch('Brad Bird 2004', [
    'Gli Incredibili',
    2004,
    ['Animazione', 'Famiglia'],
    'Brad Bird',
  ]), true);
  assert.equal(matchesCatalogSearch('bird horror', [
    'Gli Incredibili',
    2004,
    ['Animazione'],
    'Brad Bird',
  ]), false);
});

test('Film cerca anche anno, genere e regista senza cambiare endpoint', () => {
  const route = read('src/routes/movies.js');
  assert.match(route, /matchesCatalogSearch\(search, \[/);
  assert.match(route, /row\.year,/);
  assert.match(route, /row\.director,/);
  assert.match(route, /parseGenres\(row\.genresJson\),/);
  assert.match(route, /router\.get\('\/'/);
});

test('Serie cerca titolo, anno, genere e registi episodio quando disponibili', () => {
  const route = read('src/routes/series.js');
  assert.match(route, /GROUP_CONCAT\(DISTINCT NULLIF\(TRIM\(m\.director\), ''\)\) AS directorsText/);
  assert.match(route, /matchesCatalogSearch\(search, \[/);
  assert.match(route, /row\.year,/);
  assert.match(route, /parseGenres\(row\.genresJson\),/);
  assert.match(route, /row\.directorsText,/);
});

test('un secondo clic sulla lente chiude e pulisce la ricerca Film e Serie', () => {
  for (const relativePath of ['public/js/films.js', 'public/js/series.js']) {
    const script = read(relativePath);
    assert.match(script, /searchModeButton\.addEventListener\('click', \(\) => \{[\s\S]*if \(state\.mode === 'search'\)/);
    assert.match(script, /elements\.searchInput\.value = '';/);
    assert.match(script, /state\.searchResults = \[\];/);
    assert.match(script, /showHome\(\)\.catch\(handleError\)/);
    assert.match(script, /else \{[\s\S]*showSearch\(\)\.catch\(handleError\)/);
  }
});
