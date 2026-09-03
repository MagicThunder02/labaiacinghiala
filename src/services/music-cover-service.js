'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('../config');
const db = require('../database');
const { readMusicCoverArt } = require('./music-tag-service');
const {
  musicTrackPath,
  musicCoverCachePath,
  musicCoverCacheKey,
} = require('./music-library-path-service');

const MAX_MUSIC_COVER_BYTES = 6 * 1024 * 1024;
const coverQueues = new Map();

const findAlbum = db.prepare(`
  SELECT id, album_uuid AS albumId, cover_cache_path AS coverCachePath
  FROM music_albums
  WHERE album_uuid = ?
  LIMIT 1
`);

const listAlbumCoverSources = db.prepare(`
  SELECT relative_path AS relativePath
  FROM music_tracks
  WHERE album_id = ? AND available = 1 AND has_cover_art = 1
  ORDER BY COALESCE(disc_number, 1), COALESCE(track_number, 999999), id
`);

const updateAlbumCoverCache = db.prepare(`
  UPDATE music_albums
  SET cover_cache_path = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = ?
`);

const clearAlbumCoverCache = db.prepare(`
  UPDATE music_albums
  SET cover_cache_path = NULL
  WHERE id = ?
`);

function isInsideDirectory(parentDirectory, candidatePath) {
  const parent = path.resolve(parentDirectory);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(parent, candidate);
  return Boolean(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function detectImageType(buffer, declaredMimeType = '') {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: '.jpg' };
  }
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mimeType: 'image/png', extension: '.png' };
  }
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF'
      && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mimeType: 'image/webp', extension: '.webp' };
  }
  if (buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('ascii').toLowerCase();
    if (brand === 'avif' || brand === 'avis') return { mimeType: 'image/avif', extension: '.avif' };
  }

  return null;
}

async function statCachedCover(candidateKey) {
  const candidatePath = musicCoverCachePath(candidateKey);
  if (!candidatePath || !isInsideDirectory(config.musicCoverCachePath, candidatePath)) return null;
  try {
    const stats = await fs.stat(candidatePath);
    if (!stats.isFile() || stats.size <= 0) return null;
    const extension = path.extname(candidatePath).toLowerCase();
    const mimeTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.avif': 'image/avif',
    };
    const mimeType = mimeTypes[extension];
    if (!mimeType) return null;
    return {
      filePath: path.resolve(candidatePath),
      mimeType,
      size: stats.size,
      modifiedAtMs: Math.trunc(stats.mtimeMs),
    };
  } catch {
    return null;
  }
}

async function writeCoverCache(album, artwork) {
  const data = Buffer.from(artwork?.data || []);
  if (!data.length || data.length > MAX_MUSIC_COVER_BYTES) return null;
  const imageType = detectImageType(data, artwork?.mimeType);
  if (!imageType) return null;

  await fs.mkdir(config.musicCoverCachePath, { recursive: true });
  const finalKey = musicCoverCacheKey(album.albumId, imageType.extension);
  const finalPath = musicCoverCachePath(finalKey);
  const token = `${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
  const stagingPath = path.join(config.musicCoverCachePath, `.${album.albumId}.${token}.tmp`);

  try {
    await fs.writeFile(stagingPath, data, { flag: 'wx' });
    await fs.rm(finalPath, { force: true });
    await fs.rename(stagingPath, finalPath);
    const previousPath = musicCoverCachePath(album.coverCachePath);
    if (previousPath && previousPath !== path.resolve(finalPath)
        && isInsideDirectory(config.musicCoverCachePath, previousPath)) {
      await fs.rm(previousPath, { force: true }).catch(() => {});
    }
    updateAlbumCoverCache.run(finalKey, album.id);
    return statCachedCover(finalKey);
  } finally {
    await fs.rm(stagingPath, { force: true }).catch(() => {});
  }
}

function withAlbumCoverLock(albumId, operation) {
  const key = String(albumId || '');
  const previous = coverQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  coverQueues.set(key, current);
  return current.finally(() => {
    if (coverQueues.get(key) === current) coverQueues.delete(key);
  });
}

async function getMusicAlbumCover(albumId, options = {}) {
  const album = findAlbum.get(String(albumId || '').trim());
  if (!album) return null;

  return withAlbumCoverLock(album.albumId, async () => {
    const cached = await statCachedCover(album.coverCachePath);
    if (cached) return cached;
    if (album.coverCachePath) clearAlbumCoverCache.run(album.id);

    const coverReader = options.coverReader || readMusicCoverArt;
    const sources = listAlbumCoverSources.all(album.id);
    for (const source of sources) {
      try {
        const artwork = await coverReader(musicTrackPath(source));
        if (!artwork) continue;
        const stored = await writeCoverCache(album, artwork);
        if (stored) return stored;
      } catch (error) {
        if (options.strict === true) throw error;
      }
    }
    return null;
  });
}

module.exports = {
  MAX_MUSIC_COVER_BYTES,
  detectImageType,
  getMusicAlbumCover,
  isInsideDirectory,
};
