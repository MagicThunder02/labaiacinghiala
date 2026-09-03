const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('../config');
const { normalizeGenres } = require('../utils/movie-metadata');
const { normalizeExtension, validatePosterBuffer } = require('./managed-poster-service');

const STORAGE_VERSION = 1;
const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.m4v', '.webm', '.mov', '.mkv', '.avi', '.mpeg', '.mpg', '.ogv',
]);
const CACHE_POSTER_EXTENSIONS = ['.jpg', '.png', '.webp', '.avif'];

function cleanText(value, maximum = 500) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, maximum) : null;
}

function cleanYear(value) {
  if (value === null || value === undefined || value === '') return null;
  const year = Number.parseInt(value, 10);
  const maximum = new Date().getFullYear() + 2;
  return Number.isInteger(year) && year >= 1888 && year <= maximum ? year : null;
}

function cleanNonNegativeInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number.parseInt(value, 10);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function safeBasename(value) {
  const name = path.basename(String(value || '').trim());
  return name && name !== '.' && name !== '..' ? name : null;
}

function previousMetadataPath(metadataPath) {
  return metadataPath.endsWith('.metadata.json')
    ? metadataPath.replace(/\.metadata\.json$/i, '.metadata.previous.json')
    : metadataPath.replace(/\.json$/i, '.previous.json');
}

function metadataCandidates(filePath, mediaType) {
  const directory = path.dirname(filePath);
  const baseName = path.basename(filePath, path.extname(filePath));
  const specific = path.join(directory, `${baseName}.metadata.json`);
  const generic = path.join(directory, 'metadata.json');
  return mediaType === 'movie' ? [generic, specific] : [specific, generic];
}

async function countVideoFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => (
    entry.isFile() && VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
  )).length;
}

async function metadataPathMatchesFile(candidate, filePath) {
  try {
    const stats = await fs.stat(candidate);
    if (!stats.isFile()) return false;
    const parsed = await readJsonFile(candidate);
    return safeBasename(parsed?.videoFile) === path.basename(filePath);
  } catch {
    return false;
  }
}

async function selectMetadataPath(filePath, mediaType, knownPath = null) {
  if (knownPath) {
    const resolvedKnown = path.resolve(knownPath);
    if (path.dirname(resolvedKnown) === path.dirname(path.resolve(filePath))
      && await metadataPathMatchesFile(resolvedKnown, filePath)) return resolvedKnown;
  }

  for (const candidate of metadataCandidates(filePath, mediaType)) {
    if (await metadataPathMatchesFile(candidate, filePath)) return candidate;
  }

  const [generic, specific] = metadataCandidates(filePath, 'movie');
  if (mediaType === 'movie' && await countVideoFiles(path.dirname(filePath)) === 1) return generic;
  return specific;
}

function normalizeDocument(document, { filePath, mediaType, fallbackUuid = null } = {}) {
  if (!document || typeof document !== 'object') throw new Error('Il file metadata.json non contiene un oggetto valido.');
  const contentId = isUuid(document.contentId || document.id)
    ? String(document.contentId || document.id).toLowerCase()
    : (isUuid(fallbackUuid) ? String(fallbackUuid).toLowerCase() : crypto.randomUUID());
  const videoFile = safeBasename(document.videoFile) || (filePath ? path.basename(filePath) : null);
  if (!videoFile) throw new Error('Il nome del file video non è valido.');
  const type = ['movie', 'series'].includes(document.type) ? document.type : mediaType;
  const title = cleanText(document.title, 300);
  if (!title) throw new Error('Il titolo nei metadati è obbligatorio.');
  const posterFile = safeBasename(document.posterFile);
  const createdAt = cleanText(document.createdAt, 50) || new Date().toISOString();
  const normalized = {
    schemaVersion: STORAGE_VERSION,
    contentId,
    type: type === 'series' ? 'series' : 'movie',
    title,
    year: cleanYear(document.year),
    genres: normalizeGenres(document.genres || document.genre || []).slice(0, 30),
    seriesTitle: cleanText(document.seriesTitle, 300),
    seasonNumber: cleanNonNegativeInteger(document.seasonNumber),
    episodeNumber: cleanNonNegativeInteger(document.episodeNumber),
    videoFile,
    posterFile,
    createdAt,
    updatedAt: cleanText(document.updatedAt, 50) || new Date().toISOString(),
  };
  if (normalized.type === 'movie') normalized.director = cleanText(document.director, 500);
  return normalized;
}

async function readJsonFile(candidate) {
  const raw = await fs.readFile(candidate, 'utf8');
  return JSON.parse(raw);
}

async function writeBufferAndSync(candidate, buffer) {
  const handle = await fs.open(candidate, 'wx');
  try {
    await handle.writeFile(buffer);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicReplaceFromTemp(temporaryPath, finalPath) {
  const backupPath = `${finalPath}.replace-${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
  let backedUp = false;
  try {
    await fs.rename(finalPath, backupPath);
    backedUp = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  try {
    await fs.rename(temporaryPath, finalPath);
  } catch (error) {
    if (backedUp) await fs.rename(backupPath, finalPath).catch(() => {});
    throw error;
  }
  if (backedUp) await fs.rm(backupPath, { force: true }).catch(() => {});
}

async function writeJsonAtomically(metadataPath, document) {
  await fs.mkdir(path.dirname(metadataPath), { recursive: true });
  const normalized = normalizeDocument(document, {
    filePath: path.join(path.dirname(metadataPath), document.videoFile || ''),
    mediaType: document.type,
    fallbackUuid: document.contentId,
  });
  const buffer = Buffer.from(`${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  JSON.parse(buffer.toString('utf8'));

  const token = `${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
  const temporaryPath = `${metadataPath}.tmp-${token}`;
  await writeBufferAndSync(temporaryPath, buffer);

  try {
    const current = await fs.readFile(metadataPath);
    JSON.parse(current.toString('utf8'));
    const previousPath = previousMetadataPath(metadataPath);
    const previousTemp = `${previousPath}.tmp-${token}`;
    await writeBufferAndSync(previousTemp, current);
    await atomicReplaceFromTemp(previousTemp, previousPath);
  } catch (error) {
    if (!['ENOENT', 'SyntaxError'].includes(error.code) && !(error instanceof SyntaxError)) {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  await atomicReplaceFromTemp(temporaryPath, metadataPath);
  return normalized;
}

async function readContentMetadata({ filePath, mediaType, knownPath = null }) {
  for (const candidate of [
    ...new Set([knownPath, ...metadataCandidates(filePath, mediaType)].filter(Boolean).map((candidate) => path.resolve(candidate))),
  ]) {
    try {
      const rawDocument = await readJsonFile(candidate);
      const document = normalizeDocument(rawDocument, { filePath, mediaType });
      if (path.basename(filePath) !== document.videoFile) continue;
      return {
        document,
        metadataPath: candidate,
        posterPath: document.posterFile
          ? path.join(path.dirname(candidate), document.posterFile)
          : null,
        recoveredFromPrevious: false,
        needsRewrite: document.type === 'series' && Object.prototype.hasOwnProperty.call(rawDocument, 'director'),
      };
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      const previousPath = previousMetadataPath(candidate);
      try {
        const rawDocument = await readJsonFile(previousPath);
        const document = normalizeDocument(rawDocument, { filePath, mediaType });
        if (path.basename(filePath) !== document.videoFile) continue;
        await writeJsonAtomically(candidate, document).catch(() => {});
        return {
          document,
          metadataPath: candidate,
          posterPath: document.posterFile
            ? path.join(path.dirname(candidate), document.posterFile)
            : null,
          recoveredFromPrevious: true,
          needsRewrite: document.type === 'series' && Object.prototype.hasOwnProperty.call(rawDocument, 'director'),
        };
      } catch (previousError) {
        if (previousError.code !== 'ENOENT') {
          console.warn(`Metadati non leggibili: ${candidate} (${error.message})`);
        }
      }
    }
  }
  return null;
}

function posterFileName(metadataPath, extension) {
  const safeExtension = normalizeExtension(extension);
  if (!safeExtension) throw new Error('Formato copertina non supportato.');
  return path.basename(metadataPath).toLowerCase() === 'metadata.json'
    ? `poster${safeExtension}`
    : `${path.basename(metadataPath).replace(/\.metadata\.json$/i, '')}.poster${safeExtension}`;
}

function previousPosterFileName(posterPath) {
  const extension = normalizeExtension(path.extname(posterPath));
  if (!extension) return null;
  const stem = path.basename(posterPath, extension);
  return `${stem}.previous${extension}`;
}

function cachePathFor(contentId, extension) {
  const safeExtension = normalizeExtension(extension);
  if (!isUuid(contentId) || !safeExtension) return null;
  return path.join(config.metadataPosterCachePath, `${contentId}${safeExtension}`);
}

async function refreshPosterCache(contentId, posterPath) {
  if (!posterPath || !isUuid(contentId)) return null;
  const extension = normalizeExtension(path.extname(posterPath));
  if (!extension) return null;
  const buffer = await fs.readFile(posterPath);
  validatePosterBuffer(buffer);
  await fs.mkdir(config.metadataPosterCachePath, { recursive: true });
  const finalPath = cachePathFor(contentId, extension);
  const temporaryPath = `${finalPath}.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
  await writeBufferAndSync(temporaryPath, buffer);
  await atomicReplaceFromTemp(temporaryPath, finalPath);
  await Promise.all(CACHE_POSTER_EXTENSIONS
    .filter((item) => item !== extension)
    .map((item) => fs.rm(cachePathFor(contentId, item), { force: true }).catch(() => {})));
  return finalPath;
}

async function findCachedPoster(contentId) {
  if (!isUuid(contentId)) return null;
  for (const extension of CACHE_POSTER_EXTENSIONS) {
    const candidate = cachePathFor(contentId, extension);
    try {
      const stats = await fs.stat(candidate);
      if (stats.isFile()) return candidate;
    } catch {}
  }
  return null;
}

async function stageFileReplacement(finalPath, buffer) {
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  const token = `${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
  const temporaryPath = `${finalPath}.tmp-${token}`;
  const backupPath = `${finalPath}.backup-${token}`;
  await writeBufferAndSync(temporaryPath, buffer);
  let applied = false;
  let hadBackup = false;
  let settled = false;

  return {
    finalPath,
    async apply() {
      if (settled || applied) return;
      try {
        await fs.rename(finalPath, backupPath);
        hadBackup = true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      try {
        await fs.rename(temporaryPath, finalPath);
        applied = true;
      } catch (error) {
        if (hadBackup) await fs.rename(backupPath, finalPath).catch(() => {});
        throw error;
      }
    },
    async commit() {
      if (settled) return;
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
      if (hadBackup) await fs.rm(backupPath, { force: true }).catch(() => {});
      settled = true;
      applied = false;
      hadBackup = false;
    },
    async rollback() {
      if (settled) return;
      if (applied) await fs.rm(finalPath, { force: true }).catch(() => {});
      if (hadBackup) await fs.rename(backupPath, finalPath).catch(() => {});
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
      settled = true;
      applied = false;
      hadBackup = false;
    },
  };
}

async function stageContentMetadataChange({
  filePath,
  mediaType,
  knownMetadataPath = null,
  contentId = null,
  title,
  year,
  genres,
  director,
  seriesTitle = null,
  seasonNumber = null,
  episodeNumber = null,
  posterData = null,
  legacyPosterPath = null,
  createdAt = null,
}) {
  const current = await readContentMetadata({ filePath, mediaType, knownPath: knownMetadataPath });
  const metadataPath = current?.metadataPath
    || await selectMetadataPath(filePath, mediaType, knownMetadataPath);
  const stableId = current?.document.contentId
    || (isUuid(contentId) ? String(contentId).toLowerCase() : crypto.randomUUID());
  let posterBuffer = null;
  let posterExtension = null;
  let oldPosterPath = current?.posterPath || null;

  if (posterData) {
    validatePosterBuffer(posterData.buffer);
    posterBuffer = posterData.buffer;
    posterExtension = normalizeExtension(posterData.extension);
  } else if (oldPosterPath) {
    try {
      posterBuffer = await fs.readFile(oldPosterPath);
      validatePosterBuffer(posterBuffer);
      posterExtension = normalizeExtension(path.extname(oldPosterPath));
    } catch {
      posterBuffer = null;
      posterExtension = null;
    }
  } else if (legacyPosterPath) {
    try {
      posterBuffer = await fs.readFile(legacyPosterPath);
      validatePosterBuffer(posterBuffer);
      posterExtension = normalizeExtension(path.extname(legacyPosterPath));
    } catch {
      posterBuffer = null;
      posterExtension = null;
    }
  }

  const finalPosterPath = posterBuffer && posterExtension
    ? path.join(path.dirname(metadataPath), posterFileName(metadataPath, posterExtension))
    : null;
  const now = new Date().toISOString();
  const document = normalizeDocument({
    schemaVersion: STORAGE_VERSION,
    contentId: stableId,
    type: mediaType,
    title,
    year,
    genres,
    director,
    seriesTitle,
    seasonNumber,
    episodeNumber,
    videoFile: path.basename(filePath),
    posterFile: finalPosterPath ? path.basename(finalPosterPath) : null,
    createdAt: current?.document.createdAt || createdAt || now,
    updatedAt: now,
  }, { filePath, mediaType, fallbackUuid: stableId });

  const metadataBuffer = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
  JSON.parse(metadataBuffer.toString('utf8'));

  let previousPosterStage = null;
  let previousMetadataStage = null;
  if (current) {
    let previousPosterFile = null;
    if (oldPosterPath) {
      try {
        const oldPosterBuffer = await fs.readFile(oldPosterPath);
        validatePosterBuffer(oldPosterBuffer);
        previousPosterFile = previousPosterFileName(oldPosterPath);
        if (previousPosterFile) {
          previousPosterStage = await stageFileReplacement(
            path.join(path.dirname(metadataPath), previousPosterFile),
            oldPosterBuffer,
          );
        }
      } catch {
        previousPosterFile = null;
        previousPosterStage = null;
      }
    }
    const previousDocument = normalizeDocument({
      ...current.document,
      posterFile: previousPosterFile,
    }, { filePath, mediaType, fallbackUuid: stableId });
    const previousMetadataBuffer = Buffer.from(`${JSON.stringify(previousDocument, null, 2)}\n`, 'utf8');
    previousMetadataStage = await stageFileReplacement(
      previousMetadataPath(metadataPath),
      previousMetadataBuffer,
    );
  }

  const posterStage = finalPosterPath
    ? await stageFileReplacement(finalPosterPath, posterBuffer)
    : null;
  const metadataStage = await stageFileReplacement(metadataPath, metadataBuffer);
  let applied = false;
  let finalized = false;

  return {
    contentId: stableId,
    document,
    metadataPath,
    posterPath: finalPosterPath,
    async apply() {
      if (finalized || applied) return;
      try {
        if (previousPosterStage) await previousPosterStage.apply();
        if (previousMetadataStage) await previousMetadataStage.apply();
        if (posterStage) await posterStage.apply();
        await metadataStage.apply();
        applied = true;
      } catch (error) {
        await metadataStage.rollback().catch(() => {});
        if (posterStage) await posterStage.rollback().catch(() => {});
        if (previousMetadataStage) await previousMetadataStage.rollback().catch(() => {});
        if (previousPosterStage) await previousPosterStage.rollback().catch(() => {});
        finalized = true;
        throw error;
      }
    },
    async commit() {
      if (finalized) return;
      await metadataStage.commit();
      if (posterStage) await posterStage.commit();
      if (previousMetadataStage) await previousMetadataStage.commit();
      if (previousPosterStage) await previousPosterStage.commit();
      if (oldPosterPath && finalPosterPath && path.resolve(oldPosterPath) !== path.resolve(finalPosterPath)) {
        await fs.rm(oldPosterPath, { force: true }).catch(() => {});
      }
      if (finalPosterPath) await refreshPosterCache(stableId, finalPosterPath).catch((error) => {
        console.warn('Cache copertina non aggiornata:', error.message);
      });
      finalized = true;
      applied = false;
    },
    async rollback() {
      if (finalized) return;
      if (!applied) {
        await metadataStage.rollback().catch(() => {});
        if (posterStage) await posterStage.rollback().catch(() => {});
        if (previousMetadataStage) await previousMetadataStage.rollback().catch(() => {});
        if (previousPosterStage) await previousPosterStage.rollback().catch(() => {});
        finalized = true;
        return;
      }
      await metadataStage.rollback().catch(() => {});
      if (posterStage) await posterStage.rollback().catch(() => {});
      if (previousMetadataStage) await previousMetadataStage.rollback().catch(() => {});
      if (previousPosterStage) await previousPosterStage.rollback().catch(() => {});
      finalized = true;
      applied = false;
    },
  };
}

async function ensureContentMetadata(options) {
  const existing = await readContentMetadata({
    filePath: options.filePath,
    mediaType: options.mediaType,
    knownPath: options.knownMetadataPath,
  });
  if (existing) {
    if (existing.posterPath) await refreshPosterCache(existing.document.contentId, existing.posterPath).catch(() => {});
    return existing;
  }

  const staged = await stageContentMetadataChange(options);
  await staged.apply();
  await staged.commit();
  return {
    document: staged.document,
    metadataPath: staged.metadataPath,
    posterPath: staged.posterPath,
    recoveredFromPrevious: false,
  };
}

module.exports = {
  STORAGE_VERSION,
  isUuid,
  previousMetadataPath,
  selectMetadataPath,
  normalizeDocument,
  readContentMetadata,
  writeJsonAtomically,
  refreshPosterCache,
  findCachedPoster,
  stageContentMetadataChange,
  ensureContentMetadata,
};
