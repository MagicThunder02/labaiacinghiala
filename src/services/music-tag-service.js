'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const fsConstants = require('node:fs').constants;
const path = require('node:path');
const { getMusicFormat } = require('../music-formats');

const MUSIC_TAGLIB_PACKAGE = 'taglib-wasm/simple';
const MAX_TEXT_LENGTH = 500;
const MAX_MULTI_VALUE_ITEMS = 50;

class MusicTagError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'MusicTagError';
    this.code = code;
  }
}

let tagLibAdapterPromise = null;
const fileMutationQueues = new Map();

function cleanText(value, maxLength = MAX_TEXT_LENGTH) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizeTextList(value, options = {}) {
  const maxItems = options.maxItems || MAX_MULTI_VALUE_ITEMS;
  const maxLength = options.maxLength || MAX_TEXT_LENGTH;
  const input = Array.isArray(value) ? value : (value == null ? [] : [value]);
  const result = [];
  const seen = new Set();

  for (const item of input) {
    const normalized = cleanText(item, maxLength);
    const key = normalized.toLocaleLowerCase('it');
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
    if (result.length >= maxItems) break;
  }

  return result;
}

function firstText(value) {
  return normalizeTextList(value, { maxItems: 1 })[0] || '';
}

function positiveInteger(value, { allowZero = false, max = 100000 } = {}) {
  if (value === '' || value == null) return null;
  const parsed = Number(value);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > max) return null;
  return parsed;
}

function finiteNumber(value, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function normalizeMusicTags(rawTags = {}) {
  const artists = normalizeTextList(rawTags.artist);
  const albumArtists = normalizeTextList(rawTags.albumArtist);
  const genres = normalizeTextList(rawTags.genre, { maxItems: 30, maxLength: 100 });
  const composers = normalizeTextList(rawTags.composer);

  return {
    title: firstText(rawTags.title),
    artists,
    artist: artists[0] || '',
    album: firstText(rawTags.album),
    albumArtists,
    albumArtist: albumArtists[0] || '',
    genres,
    composers,
    comment: firstText(rawTags.comment),
    date: firstText(rawTags.date),
    year: positiveInteger(rawTags.year, { max: 9999 }),
    trackNumber: positiveInteger(rawTags.track),
    trackTotal: positiveInteger(rawTags.totalTracks),
    discNumber: positiveInteger(rawTags.discNumber),
    discTotal: positiveInteger(rawTags.totalDiscs),
    compilation: rawTags.compilation === true,
  };
}

function normalizeAudioProperties(rawProperties = {}) {
  const durationMs = finiteNumber(rawProperties.durationMs);
  const rawDurationSeconds = finiteNumber(rawProperties.duration);
  const durationSeconds = rawDurationSeconds > 0
    ? rawDurationSeconds
    : (durationMs > 0 ? durationMs / 1000 : rawDurationSeconds);

  return {
    durationSeconds,
    durationMs,
    bitrateKbps: finiteNumber(rawProperties.bitrate),
    sampleRateHz: finiteNumber(rawProperties.sampleRate),
    channels: positiveInteger(rawProperties.channels),
    bitsPerSample: positiveInteger(rawProperties.bitsPerSample),
    codec: cleanText(rawProperties.codec, 50) || null,
    containerFormat: cleanText(rawProperties.containerFormat, 50) || null,
    isLossless: rawProperties.isLossless === true,
    bitrateMode: cleanText(rawProperties.bitrateMode, 20) || null,
  };
}

function normalizePictures(rawPictures) {
  if (!Array.isArray(rawPictures)) return [];
  return rawPictures.slice(0, 20).map((picture) => ({
    type: cleanText(picture?.type, 50) || 'Other',
    mimeType: cleanText(picture?.mimeType, 100) || 'application/octet-stream',
    description: cleanText(picture?.description, 300),
    size: finiteNumber(picture?.size, { maximum: Number.MAX_SAFE_INTEGER }) || 0,
  }));
}

async function loadTagLibAdapter() {
  if (!tagLibAdapterPromise) {
    tagLibAdapterPromise = import(MUSIC_TAGLIB_PACKAGE)
      .then((module) => {
        const requiredFunctions = [
          'readTags',
          'readProperties',
          'readPictureMetadata',
          'readPictures',
          'applyTagsToFile',
          'applyCoverArt',
          'clearPictures',
        ];
        for (const name of requiredFunctions) {
          if (typeof module[name] !== 'function') {
            throw new Error(`taglib-wasm non espone ${name}().`);
          }
        }
        return Object.freeze({
          readTags: module.readTags,
          readProperties: module.readProperties,
          readPictureMetadata: module.readPictureMetadata,
          readPictures: module.readPictures,
          applyTagsToFile: module.applyTagsToFile,
          applyCoverArt: module.applyCoverArt,
          clearPictures: module.clearPictures,
        });
      })
      .catch((error) => {
        tagLibAdapterPromise = null;
        throw new MusicTagError(
          'MUSIC_TAG_LIBRARY_UNAVAILABLE',
          'La libreria taglib-wasm non è disponibile o non è compatibile con il runtime Node corrente.',
          { cause: error },
        );
      });
  }
  return tagLibAdapterPromise;
}

async function resolveAdapter(adapter) {
  return adapter || loadTagLibAdapter();
}

async function assertSupportedMusicFile(filePath) {
  const absolutePath = path.resolve(String(filePath || ''));
  const format = getMusicFormat(absolutePath);
  if (!format) {
    throw new MusicTagError(
      'UNSUPPORTED_MUSIC_FORMAT',
      'Formato musicale non supportato. Sono ammessi soltanto MP3, FLAC e WAV.',
    );
  }

  let stats;
  try {
    stats = await fs.stat(absolutePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new MusicTagError('MUSIC_FILE_NOT_FOUND', 'File musicale non trovato.', { cause: error });
    }
    throw error;
  }

  if (!stats.isFile()) {
    throw new MusicTagError('MUSIC_FILE_NOT_REGULAR', 'Il percorso musicale non indica un file regolare.');
  }

  return { absolutePath, format, stats };
}

async function readMusicFileMetadata(filePath, options = {}) {
  const { absolutePath, format, stats } = await assertSupportedMusicFile(filePath);
  const adapter = await resolveAdapter(options.adapter);

  try {
    const [rawTags, rawProperties, rawPictures] = await Promise.all([
      adapter.readTags(absolutePath),
      adapter.readProperties(absolutePath),
      adapter.readPictureMetadata(absolutePath),
    ]);
    const pictures = normalizePictures(rawPictures);
    return {
      filePath: absolutePath,
      fileName: path.basename(absolutePath),
      extension: format.extension,
      format: format.id,
      sizeBytes: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      tags: normalizeMusicTags(rawTags),
      properties: normalizeAudioProperties(rawProperties),
      pictures,
      hasCoverArt: pictures.length > 0,
    };
  } catch (error) {
    if (error instanceof MusicTagError) throw error;
    throw new MusicTagError(
      'MUSIC_TAG_READ_FAILED',
      `Impossibile leggere i metadati incorporati di ${path.basename(absolutePath)}.`,
      { cause: error },
    );
  }
}


function pictureTypePriority(value) {
  const normalized = String(value ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (normalized === 'frontcover' || normalized === 'coverfront' || normalized === '3') return 0;
  if (normalized === 'other' || normalized === '0') return 2;
  return 1;
}

function selectMusicCoverPicture(rawPictures) {
  if (!Array.isArray(rawPictures) || rawPictures.length === 0) return null;
  return rawPictures
    .map((picture, index) => ({ picture, index, priority: pictureTypePriority(picture?.type) }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)[0]?.picture || null;
}

async function readMusicCoverArt(filePath, options = {}) {
  const { absolutePath } = await assertSupportedMusicFile(filePath);
  const adapter = await resolveAdapter(options.adapter);
  if (typeof adapter.readPictures !== 'function') {
    throw new MusicTagError(
      'MUSIC_COVER_READER_UNAVAILABLE',
      'La libreria dei metadati non espone la lettura delle copertine incorporate.',
    );
  }

  try {
    const picture = selectMusicCoverPicture(await adapter.readPictures(absolutePath));
    if (!picture?.data) return null;
    const data = Buffer.from(picture.data);
    if (!data.length) return null;
    return {
      data,
      mimeType: cleanText(picture.mimeType, 100) || 'application/octet-stream',
      description: cleanText(picture.description, 300),
      type: cleanText(picture.type, 50) || 'Other',
    };
  } catch (error) {
    if (error instanceof MusicTagError) throw error;
    throw new MusicTagError(
      'MUSIC_COVER_READ_FAILED',
      `Impossibile leggere la copertina incorporata di ${path.basename(absolutePath)}.`,
      { cause: error },
    );
  }
}

function assignTextPatch(target, key, value, { multiple = false, maxItems, maxLength } = {}) {
  if (value === undefined) return;
  if (multiple) {
    target[key] = normalizeTextList(value, { maxItems, maxLength });
    return;
  }
  target[key] = cleanText(value, maxLength || MAX_TEXT_LENGTH);
}

function assignIntegerPatch(target, key, value, options) {
  if (value === undefined) return;
  if (value === null || value === '') {
    target[key] = 0;
    return;
  }
  const normalized = positiveInteger(value, options);
  if (normalized == null) {
    throw new MusicTagError('INVALID_MUSIC_TAGS', `Valore non valido per ${key}.`);
  }
  target[key] = normalized;
}

function buildTagLibPatch(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new MusicTagError('INVALID_MUSIC_TAGS', 'Le modifiche ai tag devono essere un oggetto.');
  }

  const patch = {};
  assignTextPatch(patch, 'title', input.title);
  assignTextPatch(patch, 'artist', input.artists ?? input.artist, { multiple: true });
  assignTextPatch(patch, 'album', input.album);
  assignTextPatch(patch, 'albumArtist', input.albumArtists ?? input.albumArtist, { multiple: true });
  assignTextPatch(patch, 'genre', input.genres ?? input.genre, {
    multiple: true,
    maxItems: 30,
    maxLength: 100,
  });
  assignTextPatch(patch, 'composer', input.composers ?? input.composer, { multiple: true });
  assignTextPatch(patch, 'comment', input.comment);
  assignTextPatch(patch, 'date', input.date, { maxLength: 50 });
  assignIntegerPatch(patch, 'year', input.year, { max: 9999 });
  assignIntegerPatch(patch, 'track', input.trackNumber ?? input.track);
  assignIntegerPatch(patch, 'totalTracks', input.trackTotal ?? input.totalTracks);
  assignIntegerPatch(patch, 'discNumber', input.discNumber);
  assignIntegerPatch(patch, 'totalDiscs', input.discTotal ?? input.totalDiscs);

  if (input.compilation !== undefined) patch.compilation = input.compilation === true;

  if (Object.keys(patch).length === 0) {
    throw new MusicTagError('EMPTY_MUSIC_TAG_PATCH', 'Nessun tag musicale da modificare.');
  }

  return patch;
}

function temporarySiblingPath(filePath, label, token) {
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, `.${parsed.name}.baia-${label}-${token}${parsed.ext}`);
}

async function replaceFileWithRollback(originalPath, stagedPath, token) {
  const backupPath = temporarySiblingPath(originalPath, 'tag-backup', token);
  let originalMoved = false;
  let stagedInstalled = false;

  try {
    await fs.rename(originalPath, backupPath);
    originalMoved = true;
    await fs.rename(stagedPath, originalPath);
    stagedInstalled = true;
    await fs.rm(backupPath, { force: true });
  } catch (error) {
    if (stagedInstalled) await fs.rm(originalPath, { force: true }).catch(() => {});
    if (originalMoved) await fs.rename(backupPath, originalPath).catch(() => {});
    throw error;
  } finally {
    await fs.rm(stagedPath, { force: true }).catch(() => {});
    if (!originalMoved || stagedInstalled) await fs.rm(backupPath, { force: true }).catch(() => {});
  }
}

function withFileMutationLock(filePath, operation) {
  const key = path.resolve(filePath).toLocaleLowerCase('en-US');
  const previous = fileMutationQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  fileMutationQueues.set(key, current);
  return current.finally(() => {
    if (fileMutationQueues.get(key) === current) fileMutationQueues.delete(key);
  });
}

async function updateMusicFileTags(filePath, changes, options = {}) {
  const { absolutePath } = await assertSupportedMusicFile(filePath);
  const patch = buildTagLibPatch(changes);

  return withFileMutationLock(absolutePath, async () => {
    const adapter = await resolveAdapter(options.adapter);
    const token = `${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
    const stagedPath = temporarySiblingPath(absolutePath, 'tag-edit', token);

    try {
      await fs.copyFile(absolutePath, stagedPath, fsConstants.COPYFILE_EXCL);
      await adapter.applyTagsToFile(stagedPath, patch);
      await readMusicFileMetadata(stagedPath, { adapter });
      await replaceFileWithRollback(absolutePath, stagedPath, token);
      return await readMusicFileMetadata(absolutePath, { adapter });
    } catch (error) {
      await fs.rm(stagedPath, { force: true }).catch(() => {});
      if (error instanceof MusicTagError) throw error;
      throw new MusicTagError(
        'MUSIC_TAG_WRITE_FAILED',
        `Impossibile aggiornare i metadati incorporati di ${path.basename(absolutePath)}.`,
        { cause: error },
      );
    }
  });
}

async function updateMusicFileCoverArt(filePath, coverChange, options = {}) {
  const { absolutePath } = await assertSupportedMusicFile(filePath);
  const action = String(coverChange?.action || 'keep');
  if (action === 'keep') return readMusicFileMetadata(absolutePath, options);
  if (action !== 'replace' && action !== 'remove') {
    throw new MusicTagError('INVALID_MUSIC_COVER_ACTION', 'Azione copertina non valida.');
  }
  if (action === 'replace' && (!Buffer.isBuffer(coverChange?.data) || !coverChange.data.length)) {
    throw new MusicTagError('INVALID_MUSIC_COVER_DATA', 'La nuova copertina è vuota o non valida.');
  }

  return withFileMutationLock(absolutePath, async () => {
    const adapter = await resolveAdapter(options.adapter);
    const token = `${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
    const stagedPath = temporarySiblingPath(absolutePath, 'cover-edit', token);

    try {
      const output = action === 'replace'
        ? await adapter.applyCoverArt(absolutePath, coverChange.data, coverChange.mimeType)
        : await adapter.clearPictures(absolutePath);
      const buffer = Buffer.from(output || []);
      if (!buffer.length) {
        throw new MusicTagError('MUSIC_COVER_WRITE_EMPTY', 'La libreria dei metadati ha prodotto un file musicale vuoto.');
      }
      await fs.writeFile(stagedPath, buffer, { flag: 'wx' });
      const verified = await readMusicFileMetadata(stagedPath, { adapter });
      if (action === 'remove' && verified.hasCoverArt) {
        throw new MusicTagError('MUSIC_COVER_REMOVE_VERIFY_FAILED', 'La copertina incorporata non è stata rimossa correttamente.');
      }
      if (action === 'replace') {
        if (!verified.hasCoverArt || verified.pictures.length !== 1) {
          throw new MusicTagError('MUSIC_COVER_REPLACE_VERIFY_FAILED', 'La nuova copertina non è stata incorporata correttamente.');
        }
        const reread = await readMusicCoverArt(stagedPath, { adapter });
        if (!reread?.data || !Buffer.from(reread.data).equals(Buffer.from(coverChange.data))) {
          throw new MusicTagError('MUSIC_COVER_REPLACE_VERIFY_FAILED', 'La copertina riletta non corrisponde all’immagine selezionata.');
        }
      }
      await replaceFileWithRollback(absolutePath, stagedPath, token);
      return await readMusicFileMetadata(absolutePath, { adapter });
    } catch (error) {
      await fs.rm(stagedPath, { force: true }).catch(() => {});
      if (error instanceof MusicTagError) throw error;
      throw new MusicTagError(
        action === 'remove' ? 'MUSIC_COVER_REMOVE_FAILED' : 'MUSIC_COVER_WRITE_FAILED',
        action === 'remove'
          ? `Impossibile rimuovere la copertina incorporata di ${path.basename(absolutePath)}.`
          : `Impossibile sostituire la copertina incorporata di ${path.basename(absolutePath)}.`,
        { cause: error },
      );
    }
  });
}

module.exports = {
  MUSIC_TAGLIB_PACKAGE,
  MusicTagError,
  normalizeMusicTags,
  normalizeAudioProperties,
  normalizePictures,
  selectMusicCoverPicture,
  buildTagLibPatch,
  readMusicFileMetadata,
  readMusicCoverArt,
  updateMusicFileTags,
  updateMusicFileCoverArt,
};
