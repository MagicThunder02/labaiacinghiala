const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/pages/films.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/css/films.css'), 'utf8');
const js = fs.readFileSync(path.join(root, 'public/js/films.js'), 'utf8');

const desktopStart = css.lastIndexOf('/* Scheda film desktop:');
const mobileStart = css.lastIndexOf('/* Su mobile il titolo');
const desktopCss = css.slice(desktopStart, mobileStart);
const mobileCss = css.slice(mobileStart);

test('il titolo della scheda film vive nella colonna destra e si allinea al poster', () => {
  const sideStart = html.indexOf('<div class="detail-side">');
  const headingStart = html.indexOf('<header class="detail-heading">');
  const actionsStart = html.indexOf('<div class="detail-actions"');
  assert.ok(sideStart >= 0 && headingStart > sideStart && actionsStart > headingStart);
  assert.match(desktopCss, /\.detail-side\s*\{[\s\S]*grid-template-rows:\s*auto auto minmax\(18px, 1fr\) auto[\s\S]*gap:\s*clamp\(18px, 2\.2vh, 30px\)/);
  assert.match(css, /\.detail-heading\s*\{[\s\S]*text-align:\s*left/);
});

test('Riprendi precede Ricomincia e i due pulsanti condividono la larghezza della rail a cinque card', () => {
  assert.ok(html.indexOf('id="resumeButton"') < html.indexOf('id="restartButton"'));
  assert.match(css, /--detail-five-card-width:\s*min\(100%, 930px\)/);
  assert.match(css, /\.detail-actions\s*\{[\s\S]*width:\s*var\(--detail-five-card-width\)[\s\S]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.detail-similar-section\s*\{[\s\S]*width:\s*var\(--detail-five-card-width\)/);
  assert.match(css, /\.detail-similar-rail\s*\{[\s\S]*grid-auto-columns:\s*calc\(20% - 13px\)/);
});

test('i metadati del dettaglio sono separati su righe, mentre il player mantiene il formato compatto', () => {
  assert.match(js, /function movieDetailMeta\(movie\)/);
  assert.match(js, /return lines\.join\('\\n'\)/);
  assert.match(js, /elements\.detailMeta\.textContent = movieDetailMeta\(movie\)/);
  assert.match(js, /elements\.playerMeta\.textContent = movieMeta\(movie\)/);
  assert.match(css, /\.detail-heading p\s*\{[\s\S]*white-space:\s*pre-line/);
});

test('il bordo inferiore dei film simili risale alla quota del poster principale ridotto', () => {
  assert.match(desktopCss, /--detail-poster-width-trim:\s*clamp\(/);
  assert.doesNotMatch(desktopCss, /--detail-poster-bottom-reserve/);
  assert.match(desktopCss, /\.detail-poster-shell\s*\{[\s\S]*width:\s*calc\(clamp\([\s\S]*- var\(--detail-poster-width-trim\)\)[\s\S]*align-self:\s*start/);
  assert.doesNotMatch(desktopCss, /margin-bottom:\s*var\(--detail-poster-bottom-reserve\)/);
  assert.match(desktopCss, /\.detail-content\s*\{[\s\S]*align-items:\s*stretch/);
  assert.match(desktopCss, /\.detail-similar-section\s*\{[\s\S]*grid-row:\s*4[\s\S]*align-self:\s*end/);
});

test('i pulsanti tornano sotto i metadati, prima dello spazio flessibile', () => {
  assert.match(desktopCss, /\.detail-actions\s*\{[\s\S]*grid-row:\s*2/);
  assert.doesNotMatch(desktopCss, /--detail-actions-to-similar-gap/);
  assert.doesNotMatch(desktopCss, /margin-bottom:\s*var\(--detail-actions-to-similar-gap\)/);
  assert.match(desktopCss, /@media \(min-width: 761px\) and \(max-height: 780px\)[\s\S]*\.detail-side\s*\{[\s\S]*gap:\s*13px/);
  assert.match(mobileCss, /\.detail-actions\s*\{[\s\S]*grid-row:\s*3/);
});
