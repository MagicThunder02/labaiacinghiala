const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { getReadingCategory } = require('../reading-formats');
const { validatePosterBuffer } = require('./managed-poster-service');

const READING_STORAGE_VERSION = 1;

function normalizeGenres(value) {
  const input = Array.isArray(value) ? value : String(value || '').split(/[,;/|]+/);
  const seen = new Set();
  const result = [];
  for (const item of input) {
    const genre = String(item || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    const key = genre.toLocaleLowerCase('it');
    if (!genre || seen.has(key)) continue;
    seen.add(key);
    result.push(genre);
    if (result.length >= 30) break;
  }
  return result;
}

function normalizeReadingDocument(value, { fallbackUuid, category, fileName, coverFile = null } = {}) {
  const definition = getReadingCategory(value?.category || category);
  if (!definition) throw new Error('Categoria di lettura non valida.');
  const contentId = String(value?.contentId || fallbackUuid || '').trim();
  if (!contentId) throw new Error('Identità contenuto mancante.');
  const title = String(value?.title || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!title) throw new Error('Il titolo è obbligatorio.');
  const author = String(value?.author || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  const year = value?.year == null || value.year === '' ? null : Number(value.year);
  const now = new Date().toISOString();
  return {
    schemaVersion: READING_STORAGE_VERSION,
    contentId,
    type: 'reading',
    category: definition.id,
    title,
    year: Number.isInteger(year) ? year : null,
    author,
    genres: normalizeGenres(value?.genres || []),
    documentFile: path.basename(String(value?.documentFile || fileName || '')),
    coverFile: value?.coverFile === null ? null : path.basename(String(value?.coverFile || coverFile || '')) || null,
    createdAt: String(value?.createdAt || now),
    updatedAt: String(value?.updatedAt || now),
  };
}

async function writeJsonAtomically(destination, document) {
  const directory = path.dirname(destination);
  await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.metadata-${process.pid}-${crypto.randomUUID()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx' });
  try {
    await fs.rename(temporary, destination);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function readReadingMetadata(metadataPath) {
  try {
    const parsed = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    return normalizeReadingDocument(parsed, {
      fallbackUuid: parsed?.contentId,
      category: parsed?.category,
      fileName: parsed?.documentFile,
      coverFile: parsed?.coverFile,
    });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function pathIsFile(candidate) {
  try {
    return (await fs.stat(candidate)).isFile();
  } catch {
    return false;
  }
}

async function stageReadingMetadataChange({
  itemDirectory,
  metadataPath,
  contentId,
  category,
  documentFile,
  title,
  year,
  author,
  genres,
  currentCoverPath = null,
  posterData = null,
  createdAt = null,
}) {
  const directory = path.resolve(itemDirectory);
  const finalMetadataPath = path.resolve(metadataPath || path.join(directory, 'metadata.json'));
  const existing = await readReadingMetadata(finalMetadataPath).catch(() => null);
  const oldCoverPath = currentCoverPath ? path.resolve(currentCoverPath) : null;
  const coverFile = posterData
    ? `cover${posterData.extension}`
    : (oldCoverPath ? path.basename(oldCoverPath) : existing?.coverFile || null);
  const finalCoverPath = coverFile ? path.join(directory, coverFile) : null;
  const document = normalizeReadingDocument({
    contentId,
    category,
    title,
    year,
    author,
    genres,
    documentFile,
    coverFile,
    createdAt: existing?.createdAt || createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }, { fallbackUuid: contentId, category, fileName: documentFile, coverFile });

  const token = `${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
  const stagedMetadataPath = path.join(directory, `.metadata-${token}.tmp`);
  const metadataBackupPath = `${finalMetadataPath}.backup-${token}`;
  const stagedCoverPath = posterData ? path.join(directory, `.cover-${token}.tmp`) : null;
  const coverBackupPath = finalCoverPath ? `${finalCoverPath}.backup-${token}` : null;
  let metadataBackedUp = false;
  let coverBackedUp = false;
  let metadataInstalled = false;
  let coverInstalled = false;
  let applied = false;

  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(stagedMetadataPath, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx' });
  if (posterData) {
    validatePosterBuffer(posterData.buffer);
    await fs.writeFile(stagedCoverPath, posterData.buffer, { flag: 'wx' });
  }

  return {
    document,
    metadataPath: finalMetadataPath,
    coverPath: finalCoverPath,
    async apply() {
      if (applied) return;
      if (await pathIsFile(finalMetadataPath)) {
        await fs.rename(finalMetadataPath, metadataBackupPath);
        metadataBackedUp = true;
      }
      if (posterData && finalCoverPath && await pathIsFile(finalCoverPath)) {
        await fs.rename(finalCoverPath, coverBackupPath);
        coverBackedUp = true;
      }
      try {
        await fs.rename(stagedMetadataPath, finalMetadataPath);
        metadataInstalled = true;
        if (posterData && finalCoverPath) {
          await fs.rename(stagedCoverPath, finalCoverPath);
          coverInstalled = true;
        }
        applied = true;
      } catch (error) {
        await this.rollback();
        throw error;
      }
    },
    async commit() {
      if (metadataBackedUp) await fs.rm(metadataBackupPath, { force: true }).catch(() => {});
      if (coverBackedUp && coverBackupPath) await fs.rm(coverBackupPath, { force: true }).catch(() => {});
      if (posterData && oldCoverPath && finalCoverPath && oldCoverPath !== finalCoverPath) {
        await fs.rm(oldCoverPath, { force: true }).catch(() => {});
      }
      await fs.rm(stagedMetadataPath, { force: true }).catch(() => {});
      if (stagedCoverPath) await fs.rm(stagedCoverPath, { force: true }).catch(() => {});
    },
    async rollback() {
      if (metadataInstalled) await fs.rm(finalMetadataPath, { force: true }).catch(() => {});
      if (coverInstalled && finalCoverPath) await fs.rm(finalCoverPath, { force: true }).catch(() => {});
      if (metadataBackedUp) await fs.rename(metadataBackupPath, finalMetadataPath).catch(() => {});
      if (coverBackedUp && coverBackupPath && finalCoverPath) await fs.rename(coverBackupPath, finalCoverPath).catch(() => {});
      await fs.rm(stagedMetadataPath, { force: true }).catch(() => {});
      if (stagedCoverPath) await fs.rm(stagedCoverPath, { force: true }).catch(() => {});
      metadataInstalled = false;
      coverInstalled = false;
      applied = false;
    },
  };
}

module.exports = {
  READING_STORAGE_VERSION,
  normalizeGenres,
  normalizeReadingDocument,
  readReadingMetadata,
  stageReadingMetadataChange,
  writeJsonAtomically,
};
