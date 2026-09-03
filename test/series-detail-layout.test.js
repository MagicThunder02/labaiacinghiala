const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/pages/series.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/css/series.css'), 'utf8');
const js = fs.readFileSync(path.join(root, 'public/js/series.js'), 'utf8');

const alignmentStart = css.lastIndexOf('/* Scheda Serie:');
const alignmentCss = css.slice(alignmentStart);

test('la scheda Serie mette titolo e azioni nella colonna destra come Film', () => {
  const sideStart = html.indexOf('<div class="detail-side series-detail-side">');
  const headingStart = html.indexOf('<header class="detail-heading">', sideStart);
  const actionsStart = html.indexOf('<div class="detail-actions"', sideStart);
  const episodesStart = html.indexOf('<section class="season-browser"', sideStart);

  assert.ok(sideStart >= 0);
  assert.ok(headingStart > sideStart);
  assert.ok(actionsStart > headingStart);
  assert.ok(episodesStart > actionsStart);
  assert.match(alignmentCss, /\.series-detail-side\s*\{[\s\S]*grid-template-rows:\s*auto auto minmax\(0, 1fr\)/);
});

test('Riprendi precede Ricomincia e gli episodi usano la stessa larghezza del dettaglio Film', () => {
  assert.ok(html.indexOf('id="resumeButton"') < html.indexOf('id="restartButton"'));
  assert.match(alignmentCss, /\.season-browser\s*\{[\s\S]*width:\s*var\(--detail-five-card-width\)/);
  assert.match(alignmentCss, /\.episode-list\s*\{[\s\S]*max-height:\s*none[\s\S]*flex:\s*1 1 auto/);
});

test('i metadati Serie sono su righe separate e includono la consistenza della libreria', () => {
  assert.match(js, /function detailMeta\(series\)/);
  assert.match(js, /libraryCounts\.join\(' · '\)/);
  assert.match(js, /return lines\.join\('\\n'\)/);
});

test('su mobile gli episodi seguono titolo poster e azioni', () => {
  assert.match(alignmentCss, /@media \(max-width: 760px\)[\s\S]*\.season-browser\s*\{[\s\S]*grid-row:\s*4/);
});

test('le dimensioni responsive della scheda Serie restano allineate a Film', () => {
  assert.match(alignmentCss, /@media \(min-width: 761px\) and \(max-width: 1050px\)[\s\S]*grid-template-columns:\s*minmax\(230px, 310px\) minmax\(0, 1fr\)/);
  assert.match(alignmentCss, /@media \(max-width: 760px\)[\s\S]*\.series-detail-content \.detail-poster-shell\s*\{[\s\S]*width:\s*min\(62vw, 270px\)/);
});


test('Serie simili compare sotto il blocco principale senza sottrarre spazio agli episodi', () => {
  const detailContentStart = html.indexOf('<div class="detail-content series-detail-content">');
  const similarStart = html.indexOf('<section id="similarSection"');
  const playerStart = html.indexOf('<section id="playerView"');

  assert.ok(detailContentStart >= 0);
  assert.ok(similarStart > detailContentStart);
  assert.ok(playerStart > similarStart);
  assert.match(html, /<h2 id="similarTitle">Serie simili<\/h2>/);
  assert.match(css, /\.series-page \.film-detail-view\s*\{[\s\S]*overflow-y:\s*auto/);
  assert.match(css, /\.series-similar-section\s*\{[\s\S]*width:\s*min\(1710px, calc\(100% - 64px\)\)/);
});

test('il frontend carica e annulla la rail Serie simili tramite il layer API esistente', () => {
  assert.match(js, /BaiaPage\.apiRequest\(`\/api\/series\/\$\{encodeURIComponent\(seriesUuid\)\}\/similar`\)/);
  assert.match(js, /request !== state\.similarRequest \|\| state\.activeSeries\?\.seriesUuid !== seriesUuid/);
  assert.match(js, /state\.similarRequest \+= 1;[\s\S]*elements\.similarSection\.hidden = true;[\s\S]*elements\.similarRail\.replaceChildren\(\)/);
});
