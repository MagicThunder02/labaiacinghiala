'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('../config');
const { getMusicFormat } = require('../music-formats');
const { buildMusicStoragePlan, importMusicUpload, MusicImportError } = require('./music-import-service');
const { readMusicFileMetadata, updateMusicFileTags, MusicTagError } = require('./music-tag-service');

const SESSION_VERSION = 1;
const SESSION_PREFIX = 'music-upload-';
const MANIFEST_NAME = 'session.json';
const MAX_SESSION_TRACKS = 100;
const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;
const sessionQueues = new Map();

class MusicUploadSessionError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'MusicUploadSessionError';
    this.code = code;
    this.statusCode = options.statusCode || 422;
    this.contentPreserved = options.contentPreserved === true;
  }
}

function isUuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function cleanOwnerKey(value) {
  const ownerKey = String(value || '').trim();
  if (!ownerKey || ownerKey.length > 200 || /[\r\n\u0000]/.test(ownerKey)) {
    throw new MusicUploadSessionError('MUSIC_UPLOAD_OWNER_INVALID', 'Identità della sessione upload non valida.', {
      statusCode: 400,
    });
  }
  return ownerKey;
}

function cleanOriginalName(value) {
  return path.basename(String(value || 'brano'))
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300) || 'brano';
}

function uploadRoot(options = {}) {
  return path.resolve(options.uploadRoot || config.uploadTempPath);
}

function sessionDirectory(sessionId, options = {}) {
  if (!isUuid(sessionId)) {
    throw new MusicUploadSessionError('MUSIC_UPLOAD_SESSION_INVALID', 'Sessione upload musicale non valida.', {
      statusCode: 400,
    });
  }
  return path.join(uploadRoot(options), `${SESSION_PREFIX}${sessionId}`);
}

function manifestPath(sessionId, options = {}) {
  return path.join(sessionDirectory(sessionId, options), MANIFEST_NAME);
}

function isInsideDirectory(parentDirectory, candidatePath) {
  const parent = path.resolve(parentDirectory);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(parent, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function trackPath(manifest, track, options = {}) {
  const directory = sessionDirectory(manifest.sessionId, options);
  const candidate = path.join(directory, String(track.storedName || ''));
  if (!isInsideDirectory(directory, candidate) || path.basename(candidate) !== track.storedName) {
    throw new MusicUploadSessionError('MUSIC_UPLOAD_SESSION_CORRUPT', 'La sessione upload musicale è danneggiata.', {
      statusCode: 500,
    });
  }
  return candidate;
}

function withSessionLock(sessionId, operation) {
  const key = String(sessionId).toLowerCase();
  const previous = sessionQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  sessionQueues.set(key, current);
  return current.finally(() => {
    if (sessionQueues.get(key) === current) sessionQueues.delete(key);
  });
}

async function writeManifest(manifest, options = {}) {
  const destination = manifestPath(manifest.sessionId, options);
  const token = `${process.pid}.${crypto.randomUUID()}`;
  const temporary = `${destination}.${token}.tmp`;
  const backup = `${destination}.${token}.bak`;
  const payload = `${JSON.stringify(manifest, null, 2)}\n`;
  await fs.writeFile(temporary, payload, { encoding: 'utf8', flag: 'wx' });
  let previousMoved = false;
  let replacementInstalled = false;
  try {
    try {
      await fs.rename(destination, backup);
      previousMoved = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await fs.rename(temporary, destination);
    replacementInstalled = true;
    if (previousMoved) await fs.rm(backup, { force: true });
  } catch (error) {
    if (replacementInstalled) await fs.rm(destination, { force: true }).catch(() => {});
    if (previousMoved) await fs.rename(backup, destination).catch(() => {});
    throw error;
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
    if (!previousMoved || replacementInstalled) await fs.rm(backup, { force: true }).catch(() => {});
  }
}

async function readManifest(sessionId, options = {}) {
  let raw;
  try {
    raw = await fs.readFile(manifestPath(sessionId, options), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new MusicUploadSessionError('MUSIC_UPLOAD_SESSION_NOT_FOUND', 'Sessione upload musicale non trovata.', {
        statusCode: 404,
      });
    }
    throw error;
  }

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    throw new MusicUploadSessionError('MUSIC_UPLOAD_SESSION_CORRUPT', 'La sessione upload musicale è danneggiata.', {
      statusCode: 500,
      cause: error,
    });
  }

  if (
    manifest?.version !== SESSION_VERSION
    || manifest.sessionId !== sessionId
    || !Array.isArray(manifest.tracks)
  ) {
    throw new MusicUploadSessionError('MUSIC_UPLOAD_SESSION_CORRUPT', 'La sessione upload musicale è danneggiata.', {
      statusCode: 500,
    });
  }
  return manifest;
}

async function readOwnedManifest(sessionId, ownerKey, options = {}) {
  const manifest = await readManifest(sessionId, options);
  if (manifest.ownerKey !== cleanOwnerKey(ownerKey)) {
    throw new MusicUploadSessionError('MUSIC_UPLOAD_SESSION_NOT_FOUND', 'Sessione upload musicale non trovata.', {
      statusCode: 404,
    });
  }
  return manifest;
}

function findTrack(manifest, trackId, { pendingOnly = false } = {}) {
  if (!isUuid(trackId)) {
    throw new MusicUploadSessionError('MUSIC_UPLOAD_TRACK_INVALID', 'Brano temporaneo non valido.', {
      statusCode: 400,
    });
  }
  const track = manifest.tracks.find((item) => item.trackId === trackId);
  if (!track) {
    throw new MusicUploadSessionError('MUSIC_UPLOAD_TRACK_NOT_FOUND', 'Brano temporaneo non trovato.', {
      statusCode: 404,
    });
  }
  if (pendingOnly && track.status !== 'pending') {
    throw new MusicUploadSessionError('MUSIC_UPLOAD_TRACK_FINALIZED', 'Il brano temporaneo è già stato finalizzato.', {
      statusCode: 409,
    });
  }
  return track;
}

function publicMetadata(metadata, plan = null, validation = null) {
  return {
    tags: {
      title: metadata.tags.title,
      artists: [...metadata.tags.artists],
      album: metadata.tags.album,
      albumArtists: [...metadata.tags.albumArtists],
      genres: [...metadata.tags.genres],
      composers: [...metadata.tags.composers],
      comment: metadata.tags.comment,
      date: metadata.tags.date,
      year: metadata.tags.year,
      trackNumber: metadata.tags.trackNumber,
      trackTotal: metadata.tags.trackTotal,
      discNumber: metadata.tags.discNumber,
      discTotal: metadata.tags.discTotal,
      compilation: metadata.tags.compilation === true,
    },
    properties: { ...metadata.properties },
    pictures: (metadata.pictures || []).map((picture) => ({ ...picture })),
    format: metadata.format,
    extension: metadata.extension,
    sizeBytes: metadata.sizeBytes,
    hasCoverArt: metadata.hasCoverArt === true,
    readyToImport: Boolean(plan),
    proposedRelativePath: plan?.relativePath || null,
    validation,
  };
}

async function inspectPendingTrack(manifest, track, options = {}) {
  const metadataReader = options.metadataReader || readMusicFileMetadata;
  let metadata;
  try {
    metadata = await metadataReader(trackPath(manifest, track, options));
  } catch (error) {
    if (error instanceof MusicTagError) {
      throw new MusicUploadSessionError(error.code, error.message, { statusCode: 422, cause: error });
    }
    throw error;
  }
  let plan = null;
  let validation = null;
  try {
    plan = buildMusicStoragePlan(metadata, options);
  } catch (error) {
    if (!(error instanceof MusicImportError) || error.statusCode >= 500) throw error;
    validation = { code: error.code, message: error.message };
  }
  return {
    trackId: track.trackId,
    originalName: track.originalName,
    status: track.status,
    ...publicMetadata(metadata, plan, validation),
  };
}

async function serializeSession(manifest, options = {}) {
  const tracks = [];
  for (const track of manifest.tracks) {
    if (track.status === 'pending') {
      tracks.push(await inspectPendingTrack(manifest, track, options));
    } else {
      tracks.push({
        trackId: track.trackId,
        originalName: track.originalName,
        status: track.status,
        imported: track.imported || null,
      });
    }
  }
  return {
    sessionId: manifest.sessionId,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    tracks,
  };
}

async function validateIncomingFile(file, options = {}) {
  const sourcePath = path.resolve(String(file?.path || ''));
  if (!isInsideDirectory(uploadRoot(options), sourcePath)) {
    throw new MusicUploadSessionError(
      'MUSIC_UPLOAD_SOURCE_OUTSIDE_UPLOADS',
      'Il file musicale deve provenire dalla cartella temporanea degli upload.',
      { statusCode: 400 },
    );
  }
  const format = getMusicFormat(file?.originalname || sourcePath);
  if (!format) {
    throw new MusicUploadSessionError(
      'UNSUPPORTED_MUSIC_FORMAT',
      'Formato musicale non supportato. Sono ammessi soltanto MP3, FLAC e WAV.',
    );
  }
  const stats = await fs.stat(sourcePath).catch((error) => {
    if (error.code === 'ENOENT') {
      throw new MusicUploadSessionError('MUSIC_UPLOAD_SOURCE_MISSING', 'Il file caricato non esiste più.', {
        statusCode: 404,
        cause: error,
      });
    }
    throw error;
  });
  if (!stats.isFile() || stats.size < 1) {
    throw new MusicUploadSessionError('MUSIC_UPLOAD_SOURCE_INVALID', 'Il file musicale caricato è vuoto o non valido.');
  }
  return { sourcePath, format, originalName: cleanOriginalName(file.originalname) };
}

async function createMusicUploadSession(files, ownerKey, options = {}) {
  const selected = Array.isArray(files) ? files.filter(Boolean) : [];
  if (!selected.length) {
    throw new MusicUploadSessionError('MUSIC_UPLOAD_FILES_REQUIRED', 'Seleziona almeno un file musicale.');
  }
  if (selected.length > MAX_SESSION_TRACKS) {
    throw new MusicUploadSessionError(
      'MUSIC_UPLOAD_TOO_MANY_FILES',
      `È possibile caricare al massimo ${MAX_SESSION_TRACKS} brani per sessione.`,
      { statusCode: 400 },
    );
  }

  const owner = cleanOwnerKey(ownerKey);
  const validated = [];
  for (const file of selected) validated.push(await validateIncomingFile(file, options));

  const sessionId = crypto.randomUUID();
  const directory = sessionDirectory(sessionId, options);
  await fs.mkdir(directory, { recursive: false });
  const now = new Date().toISOString();
  const manifest = {
    version: SESSION_VERSION,
    sessionId,
    ownerKey: owner,
    createdAt: now,
    updatedAt: now,
    tracks: [],
  };

  try {
    for (const item of validated) {
      const trackId = crypto.randomUUID();
      const storedName = `${trackId}${item.format.extension}`;
      await fs.rename(item.sourcePath, path.join(directory, storedName));
      manifest.tracks.push({
        trackId,
        originalName: item.originalName,
        storedName,
        status: 'pending',
      });
    }
    await writeManifest(manifest, options);
    return await serializeSession(manifest, options);
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    if (error instanceof MusicUploadSessionError || error instanceof MusicImportError || error instanceof MusicTagError) {
      throw error;
    }
    throw new MusicUploadSessionError(
      'MUSIC_UPLOAD_SESSION_CREATE_FAILED',
      `Impossibile preparare la sessione musicale: ${error.message}`,
      { statusCode: 500, cause: error },
    );
  }
}

async function getMusicUploadSession(sessionId, ownerKey, options = {}) {
  return withSessionLock(sessionId, async () => {
    const manifest = await readOwnedManifest(sessionId, ownerKey, options);
    return serializeSession(manifest, options);
  });
}

async function updateMusicUploadTrackTags(sessionId, trackId, ownerKey, changes, options = {}) {
  return withSessionLock(sessionId, async () => {
    const manifest = await readOwnedManifest(sessionId, ownerKey, options);
    const track = findTrack(manifest, trackId, { pendingOnly: true });
    const tagWriter = options.tagWriter || updateMusicFileTags;
    try {
      await tagWriter(trackPath(manifest, track, options), changes);
    } catch (error) {
      if (error instanceof MusicTagError) {
        throw new MusicUploadSessionError(error.code, error.message, { statusCode: 422, cause: error });
      }
      throw error;
    }
    manifest.updatedAt = new Date().toISOString();
    await writeManifest(manifest, options);
    return inspectPendingTrack(manifest, track, options);
  });
}

async function commitMusicUploadTrack(sessionId, trackId, ownerKey, options = {}) {
  return withSessionLock(sessionId, async () => {
    const manifest = await readOwnedManifest(sessionId, ownerKey, options);
    const track = findTrack(manifest, trackId, { pendingOnly: true });
    const importer = options.importer || importMusicUpload;
    let imported;
    try {
      imported = await importer(trackPath(manifest, track, options));
    } catch (error) {
      if (error instanceof MusicImportError) throw error;
      throw new MusicUploadSessionError(
        'MUSIC_UPLOAD_COMMIT_FAILED',
        `Impossibile finalizzare il brano musicale: ${error.message}`,
        { statusCode: 500, contentPreserved: error.contentPreserved === true, cause: error },
      );
    }

    track.status = 'imported';
    track.imported = imported;
    delete track.storedName;
    manifest.updatedAt = new Date().toISOString();
    const remainingTracks = manifest.tracks.filter((item) => item.status === 'pending').length;
    if (remainingTracks === 0) {
      await fs.rm(sessionDirectory(sessionId, options), { recursive: true, force: true });
    } else {
      await writeManifest(manifest, options);
    }
    return {
      imported,
      remainingTracks,
      sessionComplete: remainingTracks === 0,
    };
  });
}

async function cancelMusicUploadSession(sessionId, ownerKey, options = {}) {
  return withSessionLock(sessionId, async () => {
    await readOwnedManifest(sessionId, ownerKey, options);
    await fs.rm(sessionDirectory(sessionId, options), { recursive: true, force: true });
    return { cancelled: true };
  });
}

async function cleanupStaleMusicUploadSessions(options = {}) {
  const root = uploadRoot(options);
  const maximumAge = Number(options.maximumAgeMs || MAX_SESSION_AGE_MS);
  const now = Number(options.now || Date.now());
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(SESSION_PREFIX)) continue;
    const candidate = path.join(root, entry.name);
    try {
      const stats = await fs.stat(candidate);
      if (now - stats.mtimeMs <= maximumAge) continue;
      await fs.rm(candidate, { recursive: true, force: true });
      removed += 1;
    } catch {}
  }
  return { removed };
}

module.exports = {
  SESSION_PREFIX,
  MAX_SESSION_TRACKS,
  MAX_SESSION_AGE_MS,
  MusicUploadSessionError,
  createMusicUploadSession,
  getMusicUploadSession,
  updateMusicUploadTrackTags,
  commitMusicUploadTrack,
  cancelMusicUploadSession,
  cleanupStaleMusicUploadSessions,
};
