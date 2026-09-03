const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { normalizeGenres } = require('../utils/movie-metadata');
const {
  normalizeExtension,
  validatePosterBuffer,
} = require('./managed-poster-service');
const { refreshPosterCache, isUuid } = require('./content-metadata-service');

const SERIES_STORAGE_VERSION = 2;
const POSTER_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.avif'];

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

function safeBasename(value) {
  const name = path.basename(String(value || '').trim());
  return name && name !== '.' && name !== '..' ? name : null;
}

function normalizeSeriesDocument(document, { fallbackUuid = null, fallbackTitle = null } = {}) {
  if (!document || typeof document !== 'object') {
    throw new Error('Il metadata.json della serie non contiene un oggetto valido.');
  }
  const seriesId = isUuid(document.seriesId || document.contentId || document.id)
    ? String(document.seriesId || document.contentId || document.id).toLowerCase()
    : (isUuid(fallbackUuid) ? String(fallbackUuid).toLowerCase() : crypto.randomUUID());
  const title = cleanText(document.title || fallbackTitle, 300);
  if (!title) throw new Error('Il titolo della serie è obbligatorio.');
  return {
    schemaVersion: SERIES_STORAGE_VERSION,
    type: 'series',
    seriesId,
    title,
    year: cleanYear(document.year),
    genres: normalizeGenres(document.genres || document.genre || []).slice(0, 30),
    posterFile: safeBasename(document.posterFile),
    createdAt: cleanText(document.createdAt, 50) || new Date().toISOString(),
    updatedAt: cleanText(document.updatedAt, 50) || new Date().toISOString(),
  };
}

function metadataPathFor(seriesDirectory) {
  return path.join(path.resolve(seriesDirectory), 'metadata.json');
}

function previousMetadataPath(seriesDirectory) {
  return path.join(path.resolve(seriesDirectory), 'metadata.previous.json');
}

async function fileExists(candidate) {
  try {
    const stats = await fs.stat(candidate);
    return stats.isFile();
  } catch {
    return false;
  }
}

async function writeBufferAndSync(candidate, buffer) {
  await fs.mkdir(path.dirname(candidate), { recursive: true });
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

async function findPoster(seriesDirectory, document = null) {
  const directory = path.resolve(seriesDirectory);
  const candidates = [];
  if (document?.posterFile) candidates.push(path.join(directory, path.basename(document.posterFile)));
  for (const stem of ['poster', 'cover', 'folder']) {
    for (const extension of POSTER_EXTENSIONS) candidates.push(path.join(directory, `${stem}${extension}`));
  }
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

async function readSeriesMetadata(seriesDirectory) {
  const directory = path.resolve(seriesDirectory);
  const candidates = [metadataPathFor(directory), previousMetadataPath(directory)];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    try {
      const raw = await fs.readFile(candidate, 'utf8');
      const rawDocument = JSON.parse(raw);
      const document = normalizeSeriesDocument(rawDocument, {
        fallbackTitle: path.basename(directory),
      });
      const posterPath = await findPoster(directory, document);
      if (index === 1) {
        await writeSeriesDocument(directory, document).catch(() => {});
      }
      return {
        document,
        metadataPath: metadataPathFor(directory),
        posterPath,
        recoveredFromPrevious: index === 1,
        needsRewrite: Number(rawDocument.schemaVersion) !== SERIES_STORAGE_VERSION
          || Object.prototype.hasOwnProperty.call(rawDocument, 'director'),
      };
    } catch (error) {
      if (error.code !== 'ENOENT' && index === 0) {
        console.warn(`Metadati serie non leggibili: ${candidate} (${error.message})`);
      }
    }
  }
  return null;
}

async function writeSeriesDocument(seriesDirectory, document) {
  const directory = path.resolve(seriesDirectory);
  const metadataPath = metadataPathFor(directory);
  const normalized = normalizeSeriesDocument(document, {
    fallbackUuid: document?.seriesId,
    fallbackTitle: path.basename(directory),
  });
  const buffer = Buffer.from(`${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  JSON.parse(buffer.toString('utf8'));
  await fs.mkdir(directory, { recursive: true });

  const token = `${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
  const temporaryPath = `${metadataPath}.tmp-${token}`;
  await writeBufferAndSync(temporaryPath, buffer);

  try {
    const current = await fs.readFile(metadataPath);
    JSON.parse(current.toString('utf8'));
    const previousTemp = `${previousMetadataPath(directory)}.tmp-${token}`;
    await writeBufferAndSync(previousTemp, current);
    await atomicReplaceFromTemp(previousTemp, previousMetadataPath(directory));
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }
  await atomicReplaceFromTemp(temporaryPath, metadataPath);
  return normalized;
}

async function ensureSeriesMetadata({
  seriesDirectory,
  seriesId = null,
  title = null,
  year = null,
  genres = [],
  legacyPosterPath = null,
  createdAt = null,
}) {
  const existing = await readSeriesMetadata(seriesDirectory);
  if (existing) {
    if (existing.needsRewrite) {
      await writeSeriesDocument(seriesDirectory, existing.document);
      existing.needsRewrite = false;
    }
    if (existing.posterPath) {
      await refreshPosterCache(existing.document.seriesId, existing.posterPath).catch(() => {});
    }
    return existing;
  }

  let posterPath = await findPoster(seriesDirectory);
  if (!posterPath && legacyPosterPath && await fileExists(legacyPosterPath)) posterPath = path.resolve(legacyPosterPath);
  let posterFile = posterPath && path.dirname(posterPath) === path.resolve(seriesDirectory)
    ? path.basename(posterPath)
    : null;

  if (posterPath && !posterFile) {
    const extension = normalizeExtension(path.extname(posterPath));
    if (extension) {
      const buffer = await fs.readFile(posterPath);
      validatePosterBuffer(buffer);
      const destination = path.join(path.resolve(seriesDirectory), `poster${extension}`);
      await fs.writeFile(destination, buffer, { flag: 'wx' }).catch((error) => {
        if (error.code !== 'EEXIST') throw error;
      });
      posterPath = destination;
      posterFile = path.basename(destination);
    }
  }

  const now = new Date().toISOString();
  const document = await writeSeriesDocument(seriesDirectory, {
    schemaVersion: SERIES_STORAGE_VERSION,
    seriesId: isUuid(seriesId) ? seriesId : crypto.randomUUID(),
    type: 'series',
    title: title || path.basename(seriesDirectory),
    year,
    genres,
    posterFile,
    createdAt: createdAt || now,
    updatedAt: now,
  });
  if (posterPath) await refreshPosterCache(document.seriesId, posterPath).catch(() => {});
  return {
    document,
    metadataPath: metadataPathFor(seriesDirectory),
    posterPath,
    recoveredFromPrevious: false,
  };
}

async function stageSeriesMetadataChange({
  seriesDirectory,
  seriesId = null,
  title,
  year = null,
  genres = [],
  posterData = null,
  legacyPosterPath = null,
  createdAt = null,
}) {
  const directory = path.resolve(seriesDirectory);
  const current = await readSeriesMetadata(directory);
  const stableId = current?.document.seriesId
    || (isUuid(seriesId) ? String(seriesId).toLowerCase() : crypto.randomUUID());
  let posterBuffer = null;
  let posterExtension = null;
  const oldPosterPath = current?.posterPath || null;

  if (posterData) {
    validatePosterBuffer(posterData.buffer);
    posterBuffer = posterData.buffer;
    posterExtension = normalizeExtension(posterData.extension);
  } else {
    const source = oldPosterPath || legacyPosterPath;
    if (source) {
      try {
        posterBuffer = await fs.readFile(source);
        validatePosterBuffer(posterBuffer);
        posterExtension = normalizeExtension(path.extname(source));
      } catch {
        posterBuffer = null;
        posterExtension = null;
      }
    }
  }

  const finalPosterPath = posterBuffer && posterExtension
    ? path.join(directory, `poster${posterExtension}`)
    : null;
  const now = new Date().toISOString();
  const document = normalizeSeriesDocument({
    schemaVersion: SERIES_STORAGE_VERSION,
    seriesId: stableId,
    type: 'series',
    title,
    year,
    genres,
    posterFile: finalPosterPath ? path.basename(finalPosterPath) : null,
    createdAt: current?.document.createdAt || createdAt || now,
    updatedAt: now,
  }, { fallbackUuid: stableId, fallbackTitle: title });

  const token = `${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
  const metadataPath = metadataPathFor(directory);
  const metadataTemp = `${metadataPath}.tmp-${token}`;
  const metadataBackup = `${metadataPath}.backup-${token}`;
  const previousPath = previousMetadataPath(directory);
  const previousTemp = `${previousPath}.tmp-${token}`;
  const posterTemp = finalPosterPath ? `${finalPosterPath}.tmp-${token}` : null;
  const posterBackup = finalPosterPath ? `${finalPosterPath}.backup-${token}` : null;
  const metadataBuffer = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
  await fs.mkdir(directory, { recursive: true });
  await writeBufferAndSync(metadataTemp, metadataBuffer);
  if (current) {
    const previousBuffer = Buffer.from(`${JSON.stringify(current.document, null, 2)}\n`, 'utf8');
    await writeBufferAndSync(previousTemp, previousBuffer);
  }
  if (posterTemp) await writeBufferAndSync(posterTemp, posterBuffer);

  let applied = false;
  let metadataHadBackup = false;
  let posterHadBackup = false;

  return {
    document,
    metadataPath,
    posterPath: finalPosterPath,
    async apply() {
      if (applied) return;
      if (current) await atomicReplaceFromTemp(previousTemp, previousPath);
      try {
        await fs.rename(metadataPath, metadataBackup);
        metadataHadBackup = true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (posterTemp) {
        try {
          await fs.rename(finalPosterPath, posterBackup);
          posterHadBackup = true;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      try {
        if (posterTemp) await fs.rename(posterTemp, finalPosterPath);
        await fs.rename(metadataTemp, metadataPath);
        applied = true;
      } catch (error) {
        if (posterTemp) await fs.rm(finalPosterPath, { force: true }).catch(() => {});
        if (posterHadBackup) await fs.rename(posterBackup, finalPosterPath).catch(() => {});
        if (metadataHadBackup) await fs.rename(metadataBackup, metadataPath).catch(() => {});
        throw error;
      }
    },
    async commit() {
      await fs.rm(metadataTemp, { force: true }).catch(() => {});
      await fs.rm(metadataBackup, { force: true }).catch(() => {});
      if (posterTemp) await fs.rm(posterTemp, { force: true }).catch(() => {});
      if (posterBackup) await fs.rm(posterBackup, { force: true }).catch(() => {});
      if (oldPosterPath && finalPosterPath && path.resolve(oldPosterPath) !== path.resolve(finalPosterPath)) {
        await fs.rm(oldPosterPath, { force: true }).catch(() => {});
      }
      if (finalPosterPath) await refreshPosterCache(stableId, finalPosterPath).catch(() => {});
      applied = false;
    },
    async rollback() {
      if (applied) {
        await fs.rm(metadataPath, { force: true }).catch(() => {});
        if (metadataHadBackup) await fs.rename(metadataBackup, metadataPath).catch(() => {});
        if (finalPosterPath) await fs.rm(finalPosterPath, { force: true }).catch(() => {});
        if (posterHadBackup) await fs.rename(posterBackup, finalPosterPath).catch(() => {});
      }
      await fs.rm(metadataTemp, { force: true }).catch(() => {});
      if (posterTemp) await fs.rm(posterTemp, { force: true }).catch(() => {});
      applied = false;
    },
  };
}

module.exports = {
  SERIES_STORAGE_VERSION,
  normalizeSeriesDocument,
  metadataPathFor,
  readSeriesMetadata,
  writeSeriesDocument,
  ensureSeriesMetadata,
  stageSeriesMetadataChange,
};
