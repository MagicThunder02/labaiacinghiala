'use strict';

function parseGenres(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed)
      ? parsed.map((item) => String(item).trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function normalizeFacetText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('it')
    .trim();
}

function sameFacetText(left, right) {
  return normalizeFacetText(left) === normalizeFacetText(right);
}

function normalizeYear(value) {
  const year = Number.parseInt(value, 10);
  return Number.isInteger(year) && year > 0 ? year : 0;
}

function itemMatchesGenre(item, genre) {
  if (!genre) return true;
  return parseGenres(item.genresJson ?? item.genres_json)
    .some((itemGenre) => sameFacetText(itemGenre, genre));
}

function itemMatchesAuthor(item, author) {
  if (!author) return true;
  return sameFacetText(item.author, author);
}

function itemMatchesYear(item, year) {
  if (!year) return true;
  return Number(item.year) === Number(year);
}

function uniqueTextValues(values) {
  const byNormalizedValue = new Map();
  for (const value of values) {
    const displayValue = String(value || '').trim();
    const normalizedValue = normalizeFacetText(displayValue);
    if (!normalizedValue || byNormalizedValue.has(normalizedValue)) continue;
    byNormalizedValue.set(normalizedValue, displayValue);
  }
  return [...byNormalizedValue.values()];
}

function keepSelectedTextValue(values, selectedValue) {
  const selected = String(selectedValue || '').trim();
  if (!selected || values.some((value) => sameFacetText(value, selected))) return values;
  return [...values, selected];
}

function keepSelectedYear(values, selectedYear) {
  const year = normalizeYear(selectedYear);
  if (!year || values.includes(year)) return values;
  return [...values, year];
}

function buildReadingFilterFacets(items, activeFilters = {}) {
  const genre = String(activeFilters.genre || '').trim();
  const author = String(activeFilters.author || '').trim();
  const year = normalizeYear(activeFilters.year);
  const safeItems = Array.isArray(items) ? items : [];

  const genreSource = safeItems.filter((item) => (
    itemMatchesAuthor(item, author)
    && itemMatchesYear(item, year)
  ));
  const authorSource = safeItems.filter((item) => (
    itemMatchesGenre(item, genre)
    && itemMatchesYear(item, year)
  ));
  const yearSource = safeItems.filter((item) => (
    itemMatchesGenre(item, genre)
    && itemMatchesAuthor(item, author)
  ));

  const genres = keepSelectedTextValue(
    uniqueTextValues(genreSource.flatMap((item) => parseGenres(item.genresJson ?? item.genres_json))),
    genre,
  ).sort((left, right) => left.localeCompare(right, 'it', { sensitivity: 'base' }));

  const authors = keepSelectedTextValue(
    uniqueTextValues(authorSource.map((item) => item.author)),
    author,
  ).sort((left, right) => left.localeCompare(right, 'it', { sensitivity: 'base' }));

  const years = keepSelectedYear(
    [...new Set(yearSource.map((item) => normalizeYear(item.year)).filter(Boolean))],
    year,
  ).sort((left, right) => right - left);

  return { genres, years, authors };
}

module.exports = {
  buildReadingFilterFacets,
  normalizeFacetText,
};
