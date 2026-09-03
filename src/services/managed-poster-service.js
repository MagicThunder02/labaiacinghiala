const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');
const { sanitizeFileStem } = require('../utils/safe-filename');

const MAX_POSTER_BYTES = 6 * 1024 * 1024;
const POSTER_TYPES = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/avif', '.avif'],
]);
const POSTER_EXTENSIONS = new Set([...POSTER_TYPES.values()]);

function normalizeExtension(value) {
  const extension = String(value || '').trim().toLowerCase();
  return POSTER_EXTENSIONS.has(extension) ? extension : null;
}

function extensionFromMime(mimeType) {
  return POSTER_TYPES.get(String(mimeType || '').toLowerCase()) || null;
}

function validatePosterBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new Error('La copertina selezionata è vuota.');
  }
  if (buffer.length > MAX_POSTER_BYTES) {
    throw new Error('La copertina deve avere dimensione massima di 6 MB.');
  }
}

function parsePosterDataUrl(dataUrl) {
  if (!dataUrl) return null;
  const match = String(dataUrl).match(/^data:(image\/(?:jpeg|png|webp|avif));base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (!match) throw new Error('Formato copertina non supportato.');
  const extension = extensionFromMime(match[1]);
  const buffer = Buffer.from(match[2], 'base64');
  validatePosterBuffer(buffer);
  return { buffer, extension, mimeType: match[1] };
}

function isManagedPoster(candidate) {
  if (!candidate) return false;
  const root = path.resolve(config.metadataPostersPath);
  const resolved = path.resolve(candidate);
  const relative = path.relative(root, resolved);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function buildPosterPath({ movieId, title, year, extension }) {
  const safeExtension = normalizeExtension(extension);
  if (!safeExtension) throw new Error('Formato copertina non supportato.');
  const stem = sanitizeFileStem(title, `contenuto-${movieId}`);
  const yearPart = Number.isInteger(year) ? ` (${year})` : '';
  return path.join(config.metadataPostersPath, `${stem}${yearPart} - ${movieId}${safeExtension}`);
}

async function fileExists(candidate) {
  try {
    const stats = await fs.stat(candidate);
    return stats.isFile();
  } catch {
    return false;
  }
}

async function stageManagedPosterChange({ movieId, title, year, currentPath = null, posterData = null }) {
  await fs.mkdir(config.metadataPostersPath, { recursive: true });

  const managedCurrent = isManagedPoster(currentPath) ? path.resolve(currentPath) : null;
  const extension = posterData?.extension || (managedCurrent ? path.extname(managedCurrent).toLowerCase() : null);

  if (!extension) {
    return {
      path: currentPath || null,
      changed: false,
      commit: async () => {},
      rollback: async () => {},
    };
  }

  const finalPath = buildPosterPath({ movieId, title, year, extension });
  if (!posterData && managedCurrent === finalPath) {
    return {
      path: finalPath,
      changed: false,
      commit: async () => {},
      rollback: async () => {},
    };
  }

  const token = `${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
  const stagingPath = path.join(config.metadataPostersPath, `.poster-${token}.tmp`);
  const backupPath = `${finalPath}.backup-${token}`;
  let finalHadBackup = false;
  let currentWasRenamed = false;
  let installedNewFile = false;

  try {
    if (posterData) {
      validatePosterBuffer(posterData.buffer);
      await fs.writeFile(stagingPath, posterData.buffer, { flag: 'wx' });
    }

    if (await fileExists(finalPath)) {
      await fs.rename(finalPath, backupPath);
      finalHadBackup = true;
    }

    if (posterData) {
      await fs.rename(stagingPath, finalPath);
      installedNewFile = true;
    } else if (managedCurrent) {
      await fs.rename(managedCurrent, finalPath);
      currentWasRenamed = true;
    }
  } catch (error) {
    await fs.rm(stagingPath, { force: true }).catch(() => {});
    if (installedNewFile) await fs.rm(finalPath, { force: true }).catch(() => {});
    if (currentWasRenamed && managedCurrent) {
      await fs.rename(finalPath, managedCurrent).catch(() => {});
    }
    if (finalHadBackup) await fs.rename(backupPath, finalPath).catch(() => {});
    throw error;
  }

  return {
    path: finalPath,
    changed: true,
    async commit() {
      await fs.rm(stagingPath, { force: true }).catch(() => {});
      if (finalHadBackup) await fs.rm(backupPath, { force: true }).catch(() => {});
      if (posterData && managedCurrent && managedCurrent !== finalPath) {
        await fs.rm(managedCurrent, { force: true }).catch(() => {});
      }
    },
    async rollback() {
      if (currentWasRenamed && managedCurrent) {
        await fs.rename(finalPath, managedCurrent).catch(() => {});
      } else if (installedNewFile) {
        await fs.rm(finalPath, { force: true }).catch(() => {});
      }
      if (finalHadBackup) await fs.rename(backupPath, finalPath).catch(() => {});
      await fs.rm(stagingPath, { force: true }).catch(() => {});
    },
  };
}

module.exports = {
  MAX_POSTER_BYTES,
  POSTER_TYPES,
  POSTER_EXTENSIONS,
  extensionFromMime,
  normalizeExtension,
  parsePosterDataUrl,
  validatePosterBuffer,
  isManagedPoster,
  buildPosterPath,
  stageManagedPosterChange,
};
