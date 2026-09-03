'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('Film offre una ricerca in cima a ciascun menu filtro', () => {
  const html = read('public/pages/films.html');
  for (const [menuId, inputId] of [
    ['genreMenu', 'genreFilterSearch'],
    ['directorMenu', 'directorFilterSearch'],
    ['yearMenu', 'yearFilterSearch'],
  ]) {
    const menuStart = html.indexOf(`id="${menuId}"`);
    const inputStart = html.indexOf(`id="${inputId}"`);
    const optionsStart = html.indexOf(`id="${inputId.replace('FilterSearch', 'Options')}"`);
    assert.ok(menuStart >= 0);
    assert.ok(inputStart > menuStart);
    assert.ok(optionsStart > inputStart);
    assert.match(html, new RegExp(`class="filter-menu-search" for="${inputId}"`));
  }
});

test('la ricerca testuale dei menu resta locale e accent-insensitive', () => {
  const js = read('public/js/films.js');
  assert.match(js, /function normalizeFilterSearch\(value\)/);
  assert.match(js, /\.normalize\('NFD'\)/);
  assert.match(js, /function filterMenuValues\(values, query\)/);
  assert.match(js, /input\.addEventListener\('input', renderFilterMenus\)/);
  assert.doesNotMatch(js, /api\/movies\/filters\?.*search/);
});


test('i menu inviano agli endpoint facet gli altri filtri attivi', () => {
  const js = read('public/js/films.js');
  assert.match(js, /if \(state\.genre\) params\.set\('genre', state\.genre\)/);
  assert.match(js, /if \(state\.director\) params\.set\('director', state\.director\)/);
  assert.match(js, /if \(state\.year\) params\.set\('year', String\(state\.year\)\)/);
  assert.ok(js.includes("apiRequest(`/api/movies/filters${suffix}`)"));
});

test('la gomma segue Anno e azzera insieme genere, regista e anno', () => {
  const html = read('public/pages/films.html');
  const js = read('public/js/films.js');
  assert.ok(html.indexOf('id="clearFiltersButton"') > html.indexOf('id="yearMenu"'));
  assert.match(html, /class="eraser-icon"/);
  assert.match(html, /aria-label="Rimuovi tutti i filtri"/);
  assert.match(js, /async function clearAllFilters\(\)/);
  assert.match(js, /state\.genre = '';/);
  assert.match(js, /state\.director = '';/);
  assert.match(js, /state\.year = 0;/);
  assert.match(js, /setBrowseMode\('catalog'\)/);
  assert.match(js, /clearFiltersButton\.disabled = !\(state\.genre \|\| state\.director \|\| state\.year\)/);
});

test('i menu filtrabili mantengono ricerca fissa e lista scorrevole', () => {
  const css = read('public/css/films.css');
  assert.match(css, /\.filter-menu-search \{/);
  assert.match(css, /\.filter-menu-options \{/);
  assert.match(css, /\.filter-menu-options[\s\S]*overflow-y: auto/);
  assert.match(css, /\.eraser-icon[\s\S]*eraser\.svg/);
});
