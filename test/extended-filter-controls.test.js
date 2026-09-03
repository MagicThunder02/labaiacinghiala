'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('Serie offre ricerca nei menu e gomma dopo Anno', () => {
  const html = read('public/pages/series.html');
  const js = read('public/js/series.js');
  for (const [menuId, inputId, optionsId] of [
    ['genreMenu', 'genreFilterSearch', 'genreOptions'],
    ['yearMenu', 'yearFilterSearch', 'yearOptions'],
  ]) {
    const menuStart = html.indexOf(`id="${menuId}"`);
    const inputStart = html.indexOf(`id="${inputId}"`);
    const optionsStart = html.indexOf(`id="${optionsId}"`);
    assert.ok(menuStart >= 0);
    assert.ok(inputStart > menuStart);
    assert.ok(optionsStart > inputStart);
    assert.match(html, new RegExp(`class="filter-menu-search" for="${inputId}"`));
  }
  assert.ok(html.indexOf('id="clearFiltersButton"') > html.indexOf('id="yearMenu"'));
  assert.match(js, /async function clearAllFilters\(\)/);
  assert.match(js, /apiRequest\(`\/api\/series\/filters\$\{suffix\}`\)/);
  assert.match(js, /normalize\('NFD'\)/);
});

test('Libri Fumetti e Manga offrono ricerca nei tre menu e gomma finale', () => {
  for (const page of ['books.html', 'comics.html', 'manga.html']) {
    const html = read(`public/pages/${page}`);
    for (const [menuId, inputId, optionsId] of [
      ['genreMenu', 'genreFilterSearch', 'genreOptions'],
      ['yearMenu', 'yearFilterSearch', 'yearOptions'],
      ['authorMenu', 'authorFilterSearch', 'authorOptions'],
    ]) {
      const menuStart = html.indexOf(`id="${menuId}"`);
      const inputStart = html.indexOf(`id="${inputId}"`);
      const optionsStart = html.indexOf(`id="${optionsId}"`);
      assert.ok(menuStart >= 0);
      assert.ok(inputStart > menuStart);
      assert.ok(optionsStart > inputStart);
      assert.match(html, new RegExp(`class="filter-menu-search" for="${inputId}"`));
    }
    assert.ok(html.indexOf('id="clearFiltersButton"') > html.indexOf('id="authorMenu"'));
  }

  const js = read('public/js/reading-library.js');
  assert.match(js, /async function clearAllFilters\(\)/);
  assert.match(js, /params\.set\('genre', state\.genre\)/);
  assert.match(js, /params\.set\('author', state\.author\)/);
  assert.match(js, /params\.set\('year', String\(state\.year\)\)/);
  assert.match(js, /normalize\('NFD'\)/);
});

test('le gomme riusano la stessa icona e lo stile condiviso Film', () => {
  const css = read('public/css/films.css');
  assert.match(css, /\.eraser-icon[\s\S]*eraser\.svg/);
  assert.match(css, /\.clear-filters-button:disabled/);
});
