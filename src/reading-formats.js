const READING_CATEGORY_DEFINITIONS = Object.freeze({
  books: Object.freeze({
    id: 'books',
    label: 'Libri',
    pathKey: 'books',
    extensions: Object.freeze(['.pdf', '.epub']),
  }),
  comics: Object.freeze({
    id: 'comics',
    label: 'Fumetti',
    pathKey: 'comics',
    extensions: Object.freeze(['.pdf', '.cbz']),
  }),
  manga: Object.freeze({
    id: 'manga',
    label: 'Manga',
    pathKey: 'manga',
    extensions: Object.freeze(['.pdf', '.cbz']),
  }),
});

const READING_CATEGORIES = new Set(Object.keys(READING_CATEGORY_DEFINITIONS));
const ALL_READING_EXTENSIONS = new Set(
  Object.values(READING_CATEGORY_DEFINITIONS).flatMap((item) => item.extensions),
);

function getReadingCategory(value) {
  return READING_CATEGORY_DEFINITIONS[String(value || '').trim().toLowerCase()] || null;
}

function isReadingExtensionAllowed(category, extension) {
  const definition = getReadingCategory(category);
  return Boolean(definition && definition.extensions.includes(String(extension || '').toLowerCase()));
}

function supportedReadingExtensions() {
  return Object.fromEntries(
    Object.values(READING_CATEGORY_DEFINITIONS).map((item) => [item.id, [...item.extensions]]),
  );
}

module.exports = {
  READING_CATEGORY_DEFINITIONS,
  READING_CATEGORIES,
  ALL_READING_EXTENSIONS,
  getReadingCategory,
  isReadingExtensionAllowed,
  supportedReadingExtensions,
};
