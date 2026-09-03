const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getReadingCategory,
  isReadingExtensionAllowed,
  supportedReadingExtensions,
} = require('../src/reading-formats');
const {
  buildReadingHome,
  buildReadingRecommendations,
  stableNoise,
} = require('../src/services/reading-home-service');
const { validateReadingLocator } = require('../src/services/reading-bookmark-service');
const { normalizeReadingDocument } = require('../src/services/reading-metadata-service');

test('formati di lettura sono separati per categoria', () => {
  assert.equal(getReadingCategory('books').label, 'Libri');
  assert.equal(isReadingExtensionAllowed('books', '.epub'), true);
  assert.equal(isReadingExtensionAllowed('books', '.cbz'), false);
  assert.equal(isReadingExtensionAllowed('comics', '.cbz'), true);
  assert.equal(isReadingExtensionAllowed('manga', '.pdf'), true);
  assert.deepEqual(supportedReadingExtensions().books, ['.pdf', '.epub']);
});

test('Riprendi lettura contiene al massimo gli ultimi dieci segnalibri', () => {
  const items = Array.from({ length: 14 }, (_, index) => ({
    id: index + 1,
    title: `Titolo ${index + 1}`,
    genres: ['Narrativa'],
    author: 'Autore',
    year: 2020,
    addedAt: '2026-01-01T00:00:00.000Z',
    bookmarkedAt: `2026-07-${String(index + 1).padStart(2, '0')}T12:00:00.000Z`,
  }));
  const home = buildReadingHome(items, 'default');
  assert.equal(home.recent.length, 10);
  assert.equal(home.recent[0].id, 14);
  assert.equal(home.recent.at(-1).id, 5);
});


test('Ultimi arrivi Reading mostra al massimo venti titoli ordinati per aggiunta', () => {
  const items = Array.from({ length: 24 }, (_, index) => ({
    id: index + 1,
    title: `Titolo ${index + 1}`,
    addedAt: `2026-07-${String(index + 1).padStart(2, '0')}T12:00:00.000Z`,
    bookmarkedAt: null,
  }));
  const home = buildReadingHome(items, 'default');
  assert.equal(home.latest.length, 20);
  assert.equal(home.latest[0].id, 24);
  assert.equal(home.latest.at(-1).id, 5);
});

test('Consigliati esclude gli elementi della rail Riprendi lettura', () => {
  const items = [
    { id: 1, title: 'Letto', genres: ['Sci-Fi'], author: 'A', year: 2024, bookmarkedAt: '2026-07-30T00:00:00Z' },
    { id: 2, title: 'Affine', genres: ['Sci-Fi'], author: 'A', year: 2024, bookmarkedAt: null },
    { id: 3, title: 'Altro', genres: ['Storia'], author: 'B', year: 1980, bookmarkedAt: null },
  ];
  const recommendations = buildReadingRecommendations(items, 'default', new Set([1]), 10);
  assert.equal(recommendations.some((item) => item.id === 1), false);
  assert.equal(recommendations[0].id, 2);
  assert.equal(stableNoise('default', 2), stableNoise('default', 2));
});

test('segnalibri accettano pagine o locator EPUB, non path arbitrari', () => {
  assert.deepEqual(validateReadingLocator({ kind: 'page', page: 37, totalPages: 120 }), {
    kind: 'page', page: 37, totalPages: 120,
  });
  assert.deepEqual(validateReadingLocator({ kind: 'epub', cfi: 'epubcfi(/6/4!/4/2)', progression: 0.42 }), {
    kind: 'epub', cfi: 'epubcfi(/6/4!/4/2)', progression: 0.42,
  });
  assert.throws(() => validateReadingLocator({ kind: 'page', page: 0 }), /Pagina/);
  assert.throws(() => validateReadingLocator({ kind: 'path', path: 'R:\\Libri\\segreto.pdf' }), /supportato/);
});

test('sidecar reading conserva solo metadati logici e nomi file relativi', () => {
  const document = normalizeReadingDocument({
    contentId: 'uuid-test',
    category: 'books',
    title: 'Il libro',
    year: 2026,
    author: 'Autore',
    genres: ['Narrativa'],
    documentFile: 'Il libro.epub',
    coverFile: 'cover.jpg',
  });
  assert.equal(document.type, 'reading');
  assert.equal(document.documentFile, 'Il libro.epub');
  assert.equal(document.coverFile, 'cover.jpg');
  assert.equal(Object.hasOwn(document, 'filePath'), false);
});
