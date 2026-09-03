const { parseGenres } = require('./series-filter-service');

function normalizeGenre(value) {
  return String(value || '').trim().toLocaleLowerCase('it');
}

function randomSample(items, limit, random = Math.random) {
  const sample = [...items];
  for (let index = sample.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [sample[index], sample[swapIndex]] = [sample[swapIndex], sample[index]];
  }
  return sample.slice(0, Math.max(0, Number(limit) || 0));
}

function buildSimilarSeriesRows(currentRow, candidateRows, {
  limit = 10,
  random = Math.random,
} = {}) {
  if (!currentRow) return [];

  const currentGenres = new Set(
    parseGenres(currentRow.genresJson).map(normalizeGenre).filter(Boolean),
  );
  if (!currentGenres.size) return [];

  const currentUuid = String(currentRow.seriesUuid || '');
  const matches = (Array.isArray(candidateRows) ? candidateRows : []).filter((row) => (
    String(row.seriesUuid || '') !== currentUuid
    && parseGenres(row.genresJson).some((genre) => currentGenres.has(normalizeGenre(genre)))
  ));

  return randomSample(matches, limit, random);
}

module.exports = {
  buildSimilarSeriesRows,
  normalizeGenre,
  randomSample,
};
