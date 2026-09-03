const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const filmsHtml = fs.readFileSync(path.join(root, 'public/pages/films.html'), 'utf8');
const seriesHtml = fs.readFileSync(path.join(root, 'public/pages/series.html'), 'utf8');
const filmsCss = fs.readFileSync(path.join(root, 'public/css/films.css'), 'utf8');

const baseTitleRule = filmsCss.match(/\.detail-heading h1\s*\{([^}]*)\}/)?.[1] || '';
const desktopStart = filmsCss.lastIndexOf('/* Scheda film desktop:');
const mobileStart = filmsCss.lastIndexOf('/* Su mobile il titolo');
const desktopCss = filmsCss.slice(desktopStart, mobileStart);

test('Film e Serie condividono il titolo del dettaglio senza ombra e con peso medio reale', () => {
  assert.match(filmsHtml, /<header class="detail-heading">[\s\S]*<h1 id="detailTitle">/);
  assert.match(seriesHtml, /<header class="detail-heading">[\s\S]*<h1 id="detailTitle">/);
  assert.match(seriesHtml, /<link rel="stylesheet" href="\/css\/films\.css">/);

  assert.match(baseTitleRule, /font-family:\s*"Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif/);
  assert.match(baseTitleRule, /font-weight:\s*500/);
  assert.match(baseTitleRule, /font-synthesis:\s*none/);
  assert.match(baseTitleRule, /text-shadow:\s*none/);
});

test('il titolo usa spaziatura e interlinea tipografiche invece dell effetto logo compresso', () => {
  assert.match(baseTitleRule, /line-height:\s*1\.04/);
  assert.match(baseTitleRule, /letter-spacing:\s*-\.025em/);
  assert.match(desktopCss, /\.detail-heading h1\s*\{[\s\S]*line-height:\s*1\.02[\s\S]*letter-spacing:\s*-\.025em/);
  assert.doesNotMatch(desktopCss, /letter-spacing:\s*-\.04em/);
});
