const path = require('node:path');

const SERIES_ROOTS = new Set([
  'serie', 'serie tv', 'series', 'tv', 'tv shows', 'shows', 'telefilm',
]);

function cleanName(value) {
  return String(value || '')
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseEpisodeToken(fileName) {
  const withoutExtension = path.basename(fileName, path.extname(fileName));
  const match = withoutExtension.match(/(?:^|[. _-])S(\d{1,3})E(\d{1,3})(?:[. _-]|$)/i)
    || withoutExtension.match(/(?:^|[. _-])(\d{1,3})x(\d{1,3})(?:[. _-]|$)/i)
    || withoutExtension.match(/(?:^|[. _-])x\s*(\d{1,3})\s*x\s*(\d{1,3})(?:[. _-]|$)/i);

  if (!match) return null;

  return {
    seasonNumber: Number.parseInt(match[1], 10),
    episodeNumber: Number.parseInt(match[2], 10),
    tokenIndex: match.index,
    source: withoutExtension,
  };
}

function classifyMedia(relativePath, fileName) {
  const normalized = String(relativePath || '').replaceAll('\\', '/');
  const parts = normalized.split('/').filter(Boolean);
  const directories = parts.slice(0, -1);
  const normalizedDirectories = directories.map((part) => cleanName(part).toLowerCase());
  const episode = parseEpisodeToken(fileName);
  const rootIndex = normalizedDirectories.findIndex((part) => SERIES_ROOTS.has(part));
  const isSeries = Boolean(episode) || rootIndex >= 0;

  if (!isSeries) {
    return {
      mediaType: 'movie',
      seriesTitle: null,
      seasonNumber: null,
      episodeNumber: null,
    };
  }

  let seriesTitle = '';
  if (rootIndex >= 0 && directories[rootIndex + 1]) {
    seriesTitle = cleanName(directories[rootIndex + 1]);
  }

  if (!seriesTitle) {
    const usefulDirectories = directories.filter((directory) => (
      !/^(stagione|season)\s*\d+$/i.test(cleanName(directory))
      && !SERIES_ROOTS.has(cleanName(directory).toLowerCase())
    ));
    seriesTitle = cleanName(usefulDirectories.at(-1));
  }

  if (!seriesTitle && episode) {
    seriesTitle = cleanName(episode.source.slice(0, episode.tokenIndex));
  }

  return {
    mediaType: 'series',
    seriesTitle: seriesTitle || 'Serie senza titolo',
    seasonNumber: episode?.seasonNumber ?? null,
    episodeNumber: episode?.episodeNumber ?? null,
  };
}

module.exports = { classifyMedia, parseEpisodeToken };
