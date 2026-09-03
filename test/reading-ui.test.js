const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('Libri Fumetti e Manga usano lo stesso catalogo/reader senza URL localhost', () => {
  for (const [page, category] of [['books.html', 'books'], ['comics.html', 'comics'], ['manga.html', 'manga']]) {
    const html = read(`public/pages/${page}`);
    assert.match(html, new RegExp(`data-reading-category="${category}"`));
    assert.match(html, /reading-library\.js/);
    assert.match(html, /reading-reader-utils\.js/);
    assert.match(html, /Riprendi lettura/);
    assert.match(html, /Consigliati/);
    assert.doesNotMatch(html, /127\.0\.0\.1|localhost/i);
  }
});

test('copertine reading sono rettangolari e il bookmark e manuale', () => {
  const css = read('public/css/reading.css');
  const client = read('public/js/reading-library.js');
  assert.match(css, /\.reading-cover[\s\S]*?border:\s*1px solid transparent;[\s\S]*?border-radius:\s*0/);
  assert.match(css, /\.reading-card-button:hover \.reading-cover,[\s\S]*?border-color:\s*rgba\(255,255,255,\.56\)/);
  assert.match(client, /\/bookmark`?,?\s*\{[\s\S]*?method:\s*'PUT'/);
  assert.doesNotMatch(client, /watch_progress|\/progress/i);
  assert.match(client, /shellImmersive\(true\)/);
  assert.match(client, /is-bookmarking/);
});

test('raw fetch del reader resta nel layer API autenticato esistente', () => {
  const bridge = read('public/js/shell-bridge.js');
  assert.match(bridge, /async function apiFetch/);
  assert.match(bridge, /BaiaApi\?\.fetchApi/);
  assert.doesNotMatch(bridge, /X-Profile-Key|baiaCinghialaProfileKey/);
});

test('CBZ ed EPUB risolvono le entry binarie tramite il Media Bridge condiviso', () => {
  const client = read('public/js/reading-library.js');
  assert.match(client, /const path = `\/api\/reading\/\$\{itemId\}\/reader\/entry\/\$\{entryId\}`/);
  assert.match(client, /const target = await window\.BaiaPage\.mediaUrl\(path\)/);
  assert.match(client, /const response = await fetch\(target\)/);
  assert.doesNotMatch(client, /return rawReaderFetch\(`\/api\/reading\/\$\{itemId\}\/reader\/entry/);
});

test('librerie reading riusano testata filtri e ricerca glass di Film/Serie', () => {
  for (const page of ['books.html', 'comics.html', 'manga.html']) {
    const html = read(`public/pages/${page}`);
    assert.match(html, /\/css\/films\.css/);
    assert.match(html, /id="searchModeButton"/);
    assert.match(html, /id="genreButton"/);
    assert.match(html, /id="yearButton"/);
    assert.match(html, /id="authorButton"/);
    assert.match(html, /id="searchView" class="search-view"/);
    assert.doesNotMatch(html, /id="catalogButton"/);
  }

  const client = read('public/js/reading-library.js');
  assert.match(client, /new URLSearchParams\(\{ category \}\)/);
  assert.match(client, /apiRequest\(`\/api\/reading\/filters\?\$\{params\}`\)/);
  assert.match(client, /params\.set\('genre'/);
  assert.match(client, /params\.set\('author'/);
  assert.match(client, /params\.set\('year'/);
});

test('reader sovrappone loading e documento senza dividere la viewport', () => {
  const css = read('public/css/reading.css');
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(css, /\.reader-stage\s*\{[\s\S]*?position:\s*absolute[\s\S]*?overflow:\s*hidden/);
  assert.doesNotMatch(css, /\.reader-stage\s*\{[^}]*display:\s*grid/);
  assert.match(css, /\.reader-frame\s*\{[\s\S]*?position:\s*absolute[\s\S]*?inset:\s*0/);
  assert.match(css, /\.reader-loading\s*\{[\s\S]*?position:\s*absolute[\s\S]*?inset:\s*0/);
});

test('API reading espone filtri categoria e accetta genere autore anno', () => {
  const route = read('src/routes/reading.js');
  assert.match(route, /router\.get\('\/filters'/);
  assert.match(route, /req\.query\.genre/);
  assert.match(route, /req\.query\.author/);
  assert.match(route, /req\.query\.year/);
  assert.match(route, /buildReadingFilterFacets/);
  const facets = read('src/services/reading-filter-facets-service.js');
  assert.match(facets, /return \{ genres, years, authors \}/);
});


test('PDF usa renderer canvas locale e gli overlay di chiusura restano nascosti a riposo', () => {
  const client = read('public/js/reading-library.js');
  const css = read('public/css/reading.css');
  const packageJson = JSON.parse(read('package.json'));
  assert.match(client, /import\('\/vendor\/pdfjs\/pdf\.min\.mjs'\)/);
  assert.match(client, /getDocument\(/);
  assert.match(client, /pdfPage\.render\(/);
  assert.doesNotMatch(client, /view=Fit|zoom=page-fit/);
  assert.match(css, /\.reader-canvas\s*\{/);
  assert.match(css, /\.closing-cover\s*\{[\s\S]*?visibility:\s*hidden/);
  assert.equal(packageJson.dependencies['pdfjs-dist'], '5.4.149');
  for (const page of ['books.html', 'comics.html', 'manga.html']) {
    const html = read(`public/pages/${page}`);
    assert.match(html, /id="readerCanvas"/);
    assert.match(html, /id="closingCover"[^>]*hidden/);
  }
});


test('PDF misura il reader stage reale e EPUB usa il 100vw frazionario senza deriva cumulativa', () => {
  const client = read('public/js/reading-library.js');
  assert.match(client, /readerStage:\s*document\.querySelector\('#readerStage'\)/);
  assert.match(client, /stage\.getBoundingClientRect\(\)/);
  assert.match(client, /utils\.epubPageCount\(scrollWidth, viewportWidth\)/);
  assert.match(client, /documentValue\.querySelectorAll\('style'\)\.forEach/);
  assert.match(client, /contentRoot\.className = 'baia-epub-content'/);
  assert.match(client, /column-width:\s*100vw\s*!important/);
  assert.match(client, /column-gap:\s*0\s*!important/);
  assert.match(client, /box-decoration-break:\s*clone/);
  assert.match(client, /this\.pageStride = viewportWidth/);
  assert.match(client, /const offset = this\.pageIndex \* this\.pageStride/);
  assert.match(client, /scroller\.scrollLeft = offset/);
  assert.doesNotMatch(client, /Number\.MAX_SAFE_INTEGER|epubPageOffsets|pageOffsets\[this\.pageIndex\]/);
  assert.match(client, /viewportWidth\(documentValue = elements\.readerFrame\.contentDocument\)/);
  assert.match(client, /width:100vw/);
  assert.match(client, /probe\.getBoundingClientRect\(\)\.width/);
  assert.match(client, /this\.pageStride = viewportWidth/);
  assert.match(client, /contentWindow\?\.innerWidth/);

  const epubRenderer = client.slice(client.indexOf('class EpubRenderer'), client.indexOf('async function buildRenderer'));
  const scrollMethod = epubRenderer.slice(epubRenderer.indexOf('scrollToPage()'), epubRenderer.indexOf('async prev()'));
  assert.doesNotMatch(scrollMethod, /translate3d|getBoundingClientRect\(\)\.width/);
  assert.match(scrollMethod, /scrollLeft = offset/);
  assert.match(scrollMethod, /removeProperty\('transform'\)/);
});

test('reader espone zoom e mantiene EPUB in una pagina verticale centrata', () => {
  const client = read('public/js/reading-library.js');
  const css = read('public/css/reading.css');
  for (const page of ['books.html', 'comics.html', 'manga.html']) {
    const html = read(`public/pages/${page}`);
    assert.match(html, /id="readerZoomOutButton"/);
    assert.match(html, /id="readerZoomInButton"/);
    assert.match(html, /id="readerZoomValue"/);
    assert.match(html, /class="reader-top-actions"[\s\S]*?class="reader-zoom-controls"[\s\S]*?id="bookmarkButton"/);
    assert.match(html, /id="readerSurfaceViewport"/);
    assert.match(html, /id="readerSurface"/);
  }
  assert.match(client, /pageAspect\s*=\s*\.68/);
  assert.match(client, /elements\.readerFrame\.style\.width/);
  assert.match(client, /--baia-font-size:\s*\$\{/);
  assert.match(client, /async zoomOut\(\)/);
  assert.match(client, /async zoomIn\(\)/);
  assert.match(css, /\.reader-frame\.epub-reader-frame\s*\{[\s\S]*?box-shadow:/);
  assert.match(css, /\.reader-surface-viewport\s*\{[\s\S]*?overflow:\s*auto/);
  assert.match(css, /\.reader-title\s*\{[\s\S]*?display:\s*flex[\s\S]*?align-items:\s*center[\s\S]*?justify-content:\s*center[\s\S]*?line-height:\s*1/);
  assert.match(css, /\.reader-top-actions\s*\{[\s\S]*?display:\s*flex[\s\S]*?align-items:\s*center[\s\S]*?gap:\s*10px/);
});

test('chiusura libro ruota la cover di 180 gradi sul bordo sinistro della pagina corrente', () => {
  const client = read('public/js/reading-library.js');
  const css = read('public/css/reading.css');
  assert.match(client, /syncClosingCoverGeometry/);
  assert.match(client, /pageElement\(\)\s*\{\s*return elements\.readerCanvas/);
  assert.match(client, /pageElement\(\)\s*\{\s*return elements\.readerFrame/);
  assert.match(client, /pageElement\(\)\s*\{\s*return elements\.readerImage/);
  assert.match(client, /pageRect\.width/);
  assert.match(client, /pageRect\.height/);
  assert.match(css, /\.closing-cover\s*\{[\s\S]*?transform-origin:\s*left center/);
  assert.match(css, /@keyframes book-close\s*\{[\s\S]*?rotateY\(-180deg\)[\s\S]*?rotateY\(0deg\)/);
  assert.doesNotMatch(css.match(/@keyframes book-close\s*\{[\s\S]*?\n\}/)?.[0] || '', /drop-shadow|box-shadow/);
  assert.match(css, /\.closing-cover-face\s*\{[\s\S]*?backface-visibility:\s*hidden/);
});


test('rifiniture reader: retro cover bianco, segnalibro ancorato alla pagina e zoom resettabile', () => {
  const client = read('public/js/reading-library.js');
  const css = read('public/css/reading.css');
  assert.match(css, /\.closing-cover\s*\{[\s\S]*?background:\s*#fff/);
  assert.match(css, /\.bookmark-ribbon\s*\{[\s\S]*?--bookmark-start-top/);
  assert.match(client, /function syncBookmarkGeometry\(\)/);
  assert.match(client, /pageRect\.right/);
  assert.match(client, /pageTop\s*-\s*Math\.round\(ribbonHeight \* \.27\)/);
  assert.match(client, /async resetZoom\(\)/);
  assert.match(client, /readerZoomValue\.addEventListener\('click'/);
  for (const page of ['books.html', 'comics.html', 'manga.html']) {
    const html = read(`public/pages/${page}`);
    assert.match(html, /<button id="readerZoomValue"[^>]*Ripristina zoom al 100%/);
  }
});


test('segnalibro resta tra pagina e copertina durante la chiusura', () => {
  const css = read('public/css/reading.css');
  const client = read('public/js/reading-library.js');
  assert.match(css, /\.bookmark-ribbon\s*\{[\s\S]*?z-index:\s*70/);
  assert.match(css, /\.closing-cover\s*\{[\s\S]*?z-index:\s*80/);
  assert.match(client, /const stageRect = elements\.readerStage\.getBoundingClientRect\(\);[\s\S]*?pageRect\.right - stageRect\.left/);
  for (const page of ['books.html', 'comics.html', 'manga.html']) {
    const html = read(`public/pages/${page}`);
    const stageStart = html.indexOf('<div id="readerStage"');
    const bookmark = html.indexOf('id="bookmarkRibbon"');
    const cover = html.indexOf('id="closingCover"');
    const stageEnd = html.indexOf('</div>\n\n      <div', stageStart);
    assert.ok(stageStart >= 0 && bookmark > stageStart && cover > bookmark, `${page}: bookmark deve stare nello stage prima della cover`);
    assert.ok(stageEnd < 0 || bookmark < stageEnd, `${page}: bookmark non deve stare fuori dallo stage`);
  }
});


test('interno copertina e un piano bianco opaco e il fronte cambia in sincronia col punto edge-on', () => {
  const css = read('public/css/reading.css');
  assert.match(css, /\.closing-cover\s*\{[\s\S]*?background:\s*#fff[\s\S]*?overflow:\s*hidden/);
  assert.match(css, /\.closing-cover-front\s*\{[\s\S]*?opacity:\s*0/);
  assert.match(css, /\.closing-cover-back\s*\{[\s\S]*?display:\s*none/);
  assert.match(css, /\.closing-cover\s*\{[\s\S]*?box-shadow:\s*none/);
  assert.match(css, /\.closing-cover-front\s*\{[\s\S]*?box-shadow:\s*none/);
  assert.match(css, /@keyframes cover-front-face[\s\S]*?13%[\s\S]*?opacity:\s*0[\s\S]*?15%[\s\S]*?opacity:\s*1/);
  assert.match(css, /edge-on \(-90deg\)[\s\S]*?13\.8%/);
  assert.match(css, /is-bookmarking \.closing-cover-front[\s\S]*?animation:\s*cover-front-face/);
  assert.doesNotMatch(css, /@keyframes cover-back-face/);
});

test('pulsante Indietro usa una geometria centrata e il reader normalizza XHTML prima di rimuovere elementi nascosti', () => {
  const css = read('public/css/reading.css');
  const client = read('public/js/reading-library.js');

  assert.match(css, /\.reader-back\s*\{[\s\S]*?display:\s*inline-grid[\s\S]*?grid-template-columns:\s*16px auto[\s\S]*?align-items:\s*center[\s\S]*?justify-content:\s*center/);
  assert.match(css, /\.reader-back-icon\s*\{[\s\S]*?width:\s*16px[\s\S]*?height:\s*16px[\s\S]*?stroke-linecap:\s*round/);
  assert.match(css, /\.reader-back-label\s*\{[\s\S]*?line-height:\s*1/);
  for (const page of ['books.html', 'comics.html', 'manga.html']) {
    const html = read(`public/pages/${page}`);
    assert.match(html, /<svg class="reader-back-icon"[\s\S]*?<path d="M12\.5 3\.5 6 10l6\.5 6\.5"\/><\/svg><span class="reader-back-label">Indietro<\/span>/);
  }

  assert.match(client, /parseFromString\(String\(source \|\| ''\), 'application\/xhtml\+xml'\)/);
  assert.match(client, /document\.implementation\.createHTMLDocument\(''\)/);
  assert.match(client, /return \{ documentValue: htmlDocument, xhtmlSafe: true \}/);
  assert.match(client, /if \(xhtmlSafe\) \{[\s\S]*?querySelectorAll\('\[hidden\], \[aria-hidden="true"\], \[style\]'\)/);
  assert.match(client, /utils\.epubStyleHidesElement\(styleValue\)/);
  assert.match(client, /\$\{xhtmlSafe \? '\[id\^="textquality"\], ' : ''\}\.quality-ns0/);
  assert.doesNotMatch(client, /replace(?:All)?\([^)]*Questo testo/i);
  assert.doesNotMatch(client, /replace(?:All)?\([^)]*IncludiIntestazione/i);
});

