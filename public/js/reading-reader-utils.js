(function attachReadingReaderUtils(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BaiaReadingReaderUtils = Object.freeze(api);
})(typeof window !== 'undefined' ? window : null, () => {
  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function normalizeArchivePath(value) {
    const input = String(value || '').replaceAll('\\', '/').replace(/^\/+/, '');
    const parts = [];
    for (const part of input.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (!parts.length) return '';
        parts.pop();
      } else {
        parts.push(part);
      }
    }
    return parts.join('/');
  }

  function resolveArchivePath(baseFile, reference) {
    let ref = String(reference || '').trim();
    if (!ref || ref.startsWith('#') || /^(?:data|blob|https?|mailto|tel|javascript):/i.test(ref)) return '';
    ref = ref.split('#', 1)[0].split('?', 1)[0];
    try { ref = decodeURIComponent(ref); } catch {}
    const base = normalizeArchivePath(baseFile);
    const slash = base.lastIndexOf('/');
    const baseDirectory = slash >= 0 ? base.slice(0, slash + 1) : '';
    return normalizeArchivePath(ref.startsWith('/') ? ref : `${baseDirectory}${ref}`);
  }

  function epubStyleHidesElement(styleValue) {
    return /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important)?\s*(?:;|$)/i.test(String(styleValue || ''));
  }

  function makeBaiaEpubLocator(spineIndex, progressionWithinSpine, overallProgression = null) {
    const index = Math.max(0, Number.parseInt(spineIndex, 10) || 0);
    const within = clamp(Number(progressionWithinSpine) || 0, 0, 1);
    const locator = {
      kind: 'epub',
      cfi: `baia-spine:${index}:${within.toFixed(6)}`,
    };
    const overall = Number(overallProgression);
    if (Number.isFinite(overall)) locator.progression = clamp(overall, 0, 1);
    return locator;
  }

  function parseBaiaEpubLocator(locator) {
    if (!locator || locator.kind !== 'epub') return null;
    const match = /^baia-spine:(\d+):((?:0(?:\.\d+)?)|1(?:\.0+)?)$/.exec(String(locator.cfi || ''));
    if (!match) return null;
    return {
      spineIndex: Number(match[1]),
      progressionWithinSpine: clamp(Number(match[2]), 0, 1),
      overallProgression: Number.isFinite(Number(locator.progression)) ? clamp(Number(locator.progression), 0, 1) : null,
    };
  }


  function contentPageOffsets(rectangles, viewportWidth) {
    const width = Number(viewportWidth);
    if (!Number.isFinite(width) || width <= 0) return [0];
    const pages = new Set();
    for (const rectangle of rectangles || []) {
      const left = Number(rectangle?.left);
      const right = Number(rectangle?.right);
      const rectWidth = Number(rectangle?.width);
      const rectHeight = Number(rectangle?.height);
      if (![left, right, rectWidth, rectHeight].every(Number.isFinite)) continue;
      if (rectWidth <= 0 || rectHeight <= 0 || right <= 0) continue;
      const start = Math.max(0, Math.floor(Math.max(0, left) / width));
      const end = Math.max(start, Math.floor(Math.max(0, right - 0.5) / width));
      for (let page = start; page <= end; page += 1) pages.add(page);
    }
    return pages.size ? [...pages].sort((a, b) => a - b) : [0];
  }


  function epubPageCount(scrollWidth, viewportWidth) {
    const contentWidth = Number(scrollWidth);
    const pageWidth = Number(viewportWidth);
    if (!Number.isFinite(contentWidth) || !Number.isFinite(pageWidth) || contentWidth <= 0 || pageWidth <= 0) return 1;
    // Piccoli errori sub-pixel non devono creare una pagina fantasma finale.
    return Math.max(1, Math.ceil((contentWidth - 0.5) / pageWidth));
  }


  function pageLocator(page, totalPages = null) {
    const normalizedPage = Math.max(1, Number.parseInt(page, 10) || 1);
    const locator = { kind: 'page', page: normalizedPage };
    const total = Number.parseInt(totalPages, 10);
    if (Number.isInteger(total) && total >= normalizedPage) locator.totalPages = total;
    return locator;
  }

  return {
    clamp,
    contentPageOffsets,
    epubPageCount,
    epubStyleHidesElement,
    makeBaiaEpubLocator,
    normalizeArchivePath,
    pageLocator,
    parseBaiaEpubLocator,
    resolveArchivePath,
  };
});
