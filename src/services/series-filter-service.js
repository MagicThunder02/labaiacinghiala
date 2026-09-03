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

function parseYear(value) {
  const year = Number.parseInt(value, 10);
  return Number.isInteger(year) && year > 0 ? year : 0;
}

function normalizeGenre(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLocaleLowerCase('it');
}

function sameGenre(left, right) {
  return normalizeGenre(left) === normalizeGenre(right);
}

function filterSeriesRows(rows, { genre = '', year = 0 } = {}) {
  const normalizedGenre = normalizeGenre(genre);
  const selectedYear = parseYear(year);

  return rows.filter((row) => {
    if (selectedYear && Number(row.year) !== selectedYear) return false;
    if (!normalizedGenre) return true;
    return parseGenres(row.genresJson ?? row.genres_json).some((item) => normalizeGenre(item) === normalizedGenre);
  });
}

function uniqueGenres(rows) {
  const byNormalizedGenre = new Map();
  for (const row of rows) {
    for (const genre of parseGenres(row.genresJson ?? row.genres_json)) {
      const normalized = normalizeGenre(genre);
      if (normalized && !byNormalizedGenre.has(normalized)) byNormalizedGenre.set(normalized, genre);
    }
  }
  return [...byNormalizedGenre.values()];
}

function keepSelectedGenre(genres, selectedGenre) {
  const selected = String(selectedGenre || '').trim();
  if (!selected || genres.some((genre) => sameGenre(genre, selected))) return genres;
  return [...genres, selected];
}

function keepSelectedYear(years, selectedYear) {
  const year = parseYear(selectedYear);
  if (!year || years.includes(year)) return years;
  return [...years, year];
}

function buildSeriesFilters(rows, activeFilters = {}) {
  const genre = String(activeFilters.genre || '').trim();
  const year = parseYear(activeFilters.year);
  const safeRows = Array.isArray(rows) ? rows : [];

  const genreRows = filterSeriesRows(safeRows, { year });
  const yearRows = filterSeriesRows(safeRows, { genre });

  const genres = keepSelectedGenre(uniqueGenres(genreRows), genre)
    .sort((a, b) => a.localeCompare(b, 'it', { sensitivity: 'base' }));
  const years = keepSelectedYear(
    [...new Set(yearRows.map((row) => parseYear(row.year)).filter(Boolean))],
    year,
  ).sort((a, b) => b - a);

  return { genres, years };
}

module.exports = {
  buildSeriesFilters,
  filterSeriesRows,
  normalizeGenre,
  parseGenres,
  parseYear,
};
