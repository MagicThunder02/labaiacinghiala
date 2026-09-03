'use strict';

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
  return (item.genres || []).some((itemGenre) => sameFacetText(itemGenre, genre));
}

function itemMatchesDirector(item, director) {
  if (!director) return true;
  return sameFacetText(item.director, director);
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

function buildMovieFilterFacets(items, activeFilters = {}) {
  const genre = String(activeFilters.genre || '').trim();
  const director = String(activeFilters.director || '').trim();
  const year = normalizeYear(activeFilters.year);
  const safeItems = Array.isArray(items) ? items : [];

  const genreSource = safeItems.filter((item) => (
    itemMatchesDirector(item, director)
    && itemMatchesYear(item, year)
  ));
  const directorSource = safeItems.filter((item) => (
    itemMatchesGenre(item, genre)
    && itemMatchesYear(item, year)
  ));
  const yearSource = safeItems.filter((item) => (
    itemMatchesGenre(item, genre)
    && itemMatchesDirector(item, director)
  ));

  const genres = keepSelectedTextValue(
    uniqueTextValues(genreSource.flatMap((item) => item.genres || [])),
    genre,
  ).sort((left, right) => left.localeCompare(right, 'it', { sensitivity: 'base' }));

  const directors = keepSelectedTextValue(
    uniqueTextValues(directorSource.map((item) => item.director)),
    director,
  ).sort((left, right) => left.localeCompare(right, 'it', { sensitivity: 'base' }));

  const years = keepSelectedYear(
    [...new Set(yearSource.map((item) => normalizeYear(item.year)).filter(Boolean))],
    year,
  ).sort((left, right) => right - left);

  return { genres, directors, years };
}

module.exports = {
  buildMovieFilterFacets,
  normalizeFacetText,
};
