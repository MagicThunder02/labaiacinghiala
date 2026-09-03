const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const mime = require('mime-types');
const config = require('../config');
const { resolveLibraryPathForWrite } = require('./library-path-service');
const {
  buildReadingRelativePath,
} = require('./reading-library-path-service');
const db = require('../database');
const { getReadingCategory, isReadingExtensionAllowed } = require('../reading-formats');
const { sanitizeFileStem } = require('../utils/safe-filename');
const {
  MAX_POSTER_BYTES,
  extensionFromMime,
  normalizeExtension,
  validatePosterBuffer,
} = require('./managed-poster-service');
const {
  READING_STORAGE_VERSION,
  normalizeGenres,
  normalizeReadingDocument,
  readReadingMetadata,
  writeJsonAtomically,
} = require('./reading-metadata-service');

const insertReadingItem = db.prepare(`
  INSERT INTO reading_items (
    content_uuid, category, file_path, relative_path, file_name,
    title, year, author, genres_json, extension, mime_type,
    size_bytes, modified_at, cover_path, metadata_path, storage_version,
    available, last_seen_at, added_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1,
    STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'),
    STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'),
    STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'))
`);

const findDuplicate = db.prepare(`
  SELECT id FROM reading_items
  WHERE category = ? AND available = 1
    AND title = ? COLLATE NOCASE AND COALESCE(year, 0) = ?
  LIMIT 1
`);

function requiredText(value, label, maximum = 500) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error(`${label} è obbligatorio.`);
  return text.slice(0, maximum);
}

function validYear(value) {
  const year = Number.parseInt(value, 10);
  const maximum = new Date().getFullYear() + 2;
  if (!Number.isInteger(year) || year < 1000 || year > maximum) {
    throw new Error(`L'anno deve essere compreso tra 1000 e ${maximum}.`);
  }
  return year;
}

function validateFields(fields) {
  const title = requiredText(fields?.title, 'Il titolo', 300);
  const author = requiredText(fields?.author, "L'autore", 500);
  const year = validYear(fields?.year);
  const genres = normalizeGenres(fields?.genre || fields?.genres || []);
  if (!genres.length) throw new Error('Il genere è obbligatorio.');
  return { title, author, year, genres };
}

function validateFiles(category, document, poster) {
  if (!document) throw new Error('Il file da leggere è obbligatorio.');
  if (!poster) throw new Error('La copertina è obbligatoria.');
  const extension = path.extname(document.originalname || '').toLowerCase();
  if (!isReadingExtensionAllowed(category, extension)) {
    throw new Error('Formato di lettura non supportato per questa categoria.');
  }
  const posterExtension = extensionFromMime(poster.mimetype)
    || normalizeExtension(path.extname(poster.originalname || '').toLowerCase());
  if (!posterExtension) throw new Error('Formato copertina non supportato.');
  if (Number(poster.size || 0) > MAX_POSTER_BYTES) {
    throw new Error('La copertina deve avere dimensione massima di 6 MB.');
  }
  return { extension, posterExtension };
}

async function pathExists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function moveSameVolume(source, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.rename(source, destination);
  } catch (error) {
    if (error.code === 'EXDEV') {
      throw new Error('La cartella temporanea degli upload deve trovarsi sullo stesso volume della libreria.');
    }
    throw error;
  }
}

async function createReadingItemFromUpload({ category, document, poster, fields }) {
  const definition = getReadingCategory(category);
  if (!definition) {
    const error = new Error('Categoria di lettura non valida.');
    error.statusCode = 404;
    throw error;
  }
  const metadata = validateFields(fields);
  const { extension, posterExtension } = validateFiles(definition.id, document, poster);
  if (findDuplicate.get(definition.id, metadata.title, metadata.year)) {
    const error = new Error(`Esiste già “${metadata.title}” (${metadata.year}) in ${definition.label}.`);
    error.statusCode = 409;
    throw error;
  }

  const contentId = crypto.randomUUID();
  const titleStem = sanitizeFileStem(metadata.title, 'lettura');
  const folderStem = sanitizeFileStem(`${metadata.title} (${metadata.year})`, `lettura-${metadata.year}`);
  const finalDirectoryRelative = buildReadingRelativePath(definition.id, folderStem);
  const finalDirectory = await resolveLibraryPathForWrite(finalDirectoryRelative);
  const libraryDirectory = path.dirname(finalDirectory);
  if (await pathExists(finalDirectory)) {
    const error = new Error(`Esiste già una cartella chiamata “${path.basename(finalDirectory)}”.`);
    error.statusCode = 409;
    throw error;
  }

  const stagingDirectory = path.join(config.uploadTempPath, `reading-${contentId}-${Date.now()}`);
  const fileName = `${titleStem}${extension}`;
  const coverFileName = `cover${posterExtension}`;
  const stagedDocumentPath = path.join(stagingDirectory, fileName);
  const stagedCoverPath = path.join(stagingDirectory, coverFileName);
  const stagedMetadataPath = path.join(stagingDirectory, 'metadata.json');
  const finalDocumentPath = path.join(finalDirectory, fileName);
  const finalCoverPath = path.join(finalDirectory, coverFileName);
  const finalMetadataPath = path.join(finalDirectory, 'metadata.json');
  let installed = false;

  try {
    await fs.mkdir(stagingDirectory, { recursive: false });
    await moveSameVolume(document.path, stagedDocumentPath);
    const coverBuffer = await fs.readFile(poster.path);
    validatePosterBuffer(coverBuffer);
    await fs.writeFile(stagedCoverPath, coverBuffer, { flag: 'wx' });
    await fs.rm(poster.path, { force: true }).catch(() => {});

    const now = new Date().toISOString();
    const metadataDocument = normalizeReadingDocument({
      schemaVersion: READING_STORAGE_VERSION,
      contentId,
      category: definition.id,
      title: metadata.title,
      year: metadata.year,
      author: metadata.author,
      genres: metadata.genres,
      documentFile: fileName,
      coverFile: coverFileName,
      createdAt: now,
      updatedAt: now,
    }, { fallbackUuid: contentId, category: definition.id, fileName, coverFile: coverFileName });
    await writeJsonAtomically(stagedMetadataPath, metadataDocument);
    const verified = await readReadingMetadata(stagedMetadataPath);
    if (!verified || verified.contentId !== contentId || verified.category !== definition.id) {
      throw new Error('Verifica dei metadati del contenuto non riuscita.');
    }

    await fs.mkdir(libraryDirectory, { recursive: true });
    await fs.rename(stagingDirectory, finalDirectory);
    installed = true;

    const stats = await fs.stat(finalDocumentPath);
    const relativePath = buildReadingRelativePath(definition.id, folderStem, fileName);
    const coverRelativePath = buildReadingRelativePath(definition.id, folderStem, coverFileName);
    const metadataRelativePath = buildReadingRelativePath(definition.id, folderStem, 'metadata.json');
    let id;
    try {
      id = Number(insertReadingItem.run(
        contentId,
        definition.id,
        relativePath,
        relativePath,
        fileName,
        metadata.title,
        metadata.year,
        metadata.author,
        JSON.stringify(metadata.genres),
        extension,
        mime.lookup(extension) || document.mimetype || 'application/octet-stream',
        Number(stats.size || 0),
        Math.trunc(stats.mtimeMs),
        coverRelativePath,
        metadataRelativePath,
        READING_STORAGE_VERSION,
      ).lastInsertRowid);
    } catch (error) {
      error.contentPreserved = true;
      error.message = `Il contenuto è stato salvato sul RAID, ma SQLite non è stato aggiornato: ${error.message}`;
      throw error;
    }

    return {
      id,
      contentId,
      category: definition.id,
      title: metadata.title,
      year: metadata.year,
      author: metadata.author,
      genres: metadata.genres,
      fileName,
      relativePath,
      metadataPath: metadataRelativePath,
      fileUrl: `/api/reading/${id}/file`,
      coverUrl: `/api/reading/${id}/cover?v=${Date.now()}`,
    };
  } catch (error) {
    if (!installed) await fs.rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

module.exports = {
  createReadingItemFromUpload,
  validateFields,
  validateFiles,
};
