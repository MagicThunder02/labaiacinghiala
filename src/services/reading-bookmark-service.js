function validateReadingLocator(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Segnalibro non valido.');
  }
  if (value.kind === 'page') {
    const page = Number(value.page);
    if (!Number.isInteger(page) || page < 1 || page > 10_000_000) {
      throw new Error('Pagina del segnalibro non valida.');
    }
    const locator = { kind: 'page', page };
    if (value.totalPages !== undefined && value.totalPages !== null) {
      const totalPages = Number(value.totalPages);
      if (!Number.isInteger(totalPages) || totalPages < page || totalPages > 10_000_000) {
        throw new Error('Numero totale di pagine non valido.');
      }
      locator.totalPages = totalPages;
    }
    return locator;
  }
  if (value.kind === 'epub') {
    const cfi = String(value.cfi || '').trim();
    if (!cfi || cfi.length > 2048) throw new Error('Posizione EPUB del segnalibro non valida.');
    const locator = { kind: 'epub', cfi };
    if (value.progression !== undefined && value.progression !== null) {
      const progression = Number(value.progression);
      if (!Number.isFinite(progression) || progression < 0 || progression > 1) {
        throw new Error('Progressione EPUB non valida.');
      }
      locator.progression = progression;
    }
    return locator;
  }
  throw new Error('Tipo di segnalibro non supportato.');
}

function serializeReadingLocator(value) {
  const locator = validateReadingLocator(value);
  const serialized = JSON.stringify(locator);
  if (Buffer.byteLength(serialized, 'utf8') > 4096) throw new Error('Segnalibro troppo grande.');
  return { locator, serialized };
}

module.exports = { serializeReadingLocator, validateReadingLocator };
