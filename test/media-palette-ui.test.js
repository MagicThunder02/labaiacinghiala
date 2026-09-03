'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const index = read('public/index.html');
const filmsHtml = read('public/pages/films.html');
const seriesHtml = read('public/pages/series.html');
const shell = read('public/js/app-shell.js');
const films = read('public/js/films.js');
const series = read('public/js/series.js');
const shellCss = read('public/css/app-shell.css');
const filmsCss = read('public/css/films.css');

for (const [name, html] of [['shell', index], ['film', filmsHtml], ['serie', seriesHtml]]) {
  test(`${name}: carica l estrattore cromatico prima della logica della pagina`, () => {
    assert.match(html, /\/js\/media-palette\.js/);
  });
}

test('Musica usa la palette condivisa a cinque tonalità', () => {
  assert.match(shell, /BaiaMediaPalette\.extractFromUrl\(objectUrl/);
  assert.match(shell, /applyCssVariables\(elements\.musicFullPlayer, palette, 'music-color'\)/);
  assert.match(shellCss, /--music-color-base:/);
  assert.match(shellCss, /--music-color-c:/);
  assert.match(shellCss, /--music-color-d:/);
  assert.match(shellCss, /radial-gradient\(circle at 76% 84%, rgba\(var\(--music-color-c\)/);
});

test('Film e Serie condividono estrazione e variabili della palette', () => {
  assert.match(films, /BaiaMediaPalette\.extractFromUrl\(mediaUrl/);
  assert.match(films, /applyCssVariables\(elements\.detailView, palette, 'detail-color'\)/);
  assert.match(series, /async function applySeriesPosterPalette/);
  assert.match(series, /BaiaMediaPalette\.extractFromUrl\(mediaUrl/);
  assert.match(series, /applyCssVariables\(elements\.detail, palette, 'detail-color'\)/);
  assert.match(series, /void applySeriesPosterPalette\(state\.activeSeries\)/);
  assert.match(filmsCss, /--detail-color-base:/);
  assert.match(filmsCss, /--detail-color-c:/);
  assert.match(filmsCss, /--detail-color-d:/);
  assert.match(filmsCss, /radial-gradient\(circle at 38% 16%, rgba\(var\(--detail-color-d\)/);
});

test('gli sfondi cromatici non dipendono da mix-blend-mode', () => {
  assert.doesNotMatch(shellCss, /mix-blend-mode\s*:/);
  assert.doesNotMatch(filmsCss, /mix-blend-mode\s*:/);
});
