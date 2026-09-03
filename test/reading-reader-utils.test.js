const test = require('node:test');
const assert = require('node:assert/strict');
const utils = require('../public/js/reading-reader-utils');

test('resolver EPUB resta dentro lo spazio logico dell archivio e rifiuta URL esterni', () => {
  assert.equal(utils.resolveArchivePath('OPS/Text/chapter1.xhtml', '../Images/cover.jpg'), 'OPS/Images/cover.jpg');
  assert.equal(utils.resolveArchivePath('OPS/Text/chapter1.xhtml', '../../../secret.txt'), '');
  assert.equal(utils.resolveArchivePath('OPS/Text/chapter1.xhtml', 'https://example.com/a.jpg'), '');
  assert.equal(utils.resolveArchivePath('OPS/Text/chapter1.xhtml', 'javascript:alert(1)'), '');
});

test('locator EPUB Baia conserva spine e posizione interna senza dipendere dalla dimensione schermo', () => {
  const locator = utils.makeBaiaEpubLocator(4, 0.375, 0.6);
  assert.deepEqual(locator, { kind: 'epub', cfi: 'baia-spine:4:0.375000', progression: 0.6 });
  assert.deepEqual(utils.parseBaiaEpubLocator(locator), {
    spineIndex: 4,
    progressionWithinSpine: 0.375,
    overallProgression: 0.6,
  });
});

test('locator pagina normalizza la pagina e include il totale solo se coerente', () => {
  assert.deepEqual(utils.pageLocator(7, 120), { kind: 'page', page: 7, totalPages: 120 });
  assert.deepEqual(utils.pageLocator(7, 3), { kind: 'page', page: 7 });
});


test('paginazione EPUB ignora colonne fisiche senza contenuto', () => {
  const offsets = utils.contentPageOffsets([
    { left: 50, right: 450, width: 400, height: 40 },
    { left: 2050, right: 2460, width: 410, height: 40 },
    { left: 4050, right: 4480, width: 430, height: 220 },
  ], 1000);
  assert.deepEqual(offsets, [0, 2, 4]);
  assert.deepEqual(utils.contentPageOffsets([], 1000), [0]);
});


test('paginazione EPUB usa la larghezza reflow reale senza confondere spine e pagine', () => {
  assert.equal(utils.epubPageCount(1000, 1000), 1);
  assert.equal(utils.epubPageCount(7999.8, 1000), 8);
  assert.equal(utils.epubPageCount(8000.2, 1000), 8);
  assert.equal(utils.epubPageCount(8001, 1000), 9);
  // Misure osservate con scaling Windows 125%: scrollWidth è intero,
  // mentre il passo CSS 100vw conserva la frazione reale.
  assert.equal(utils.epubPageCount(24998, 403.20001220703125), 62);
  assert.equal(utils.epubPageCount(22726, 445.6000061035156), 51);
  assert.equal(utils.epubPageCount(0, 1000), 1);
});



test('rileva gli elementi che l EPUB dichiara non visibili prima della pulizia CSS', () => {
  assert.equal(utils.epubStyleHidesElement('display:none'), true);
  assert.equal(utils.epubStyleHidesElement('color:red; display: none !important; speak:none'), true);
  assert.equal(utils.epubStyleHidesElement('visibility: hidden'), true);
  assert.equal(utils.epubStyleHidesElement('display:block; speak:none'), false);
  assert.equal(utils.epubStyleHidesElement('opacity:0'), false);
});
