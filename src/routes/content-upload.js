const express = require('express');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const { allowLongUpload } = require('../http-timeouts');
const config = require('../config');
const db = require('../database');
const { SUPPORTED_EXTENSIONS } = require('../media-formats');
const { isReadingExtensionAllowed, supportedReadingExtensions } = require('../reading-formats');
const { isMusicExtensionAllowed, supportedMusicExtensions } = require('../music-formats');
const {
  MAX_POSTER_BYTES,
  extensionFromMime,
  normalizeExtension,
} = require('../services/managed-poster-service');
const { createMovieFromUpload } = require('../services/movie-upload-service');
const { createSeriesFromUpload } = require('../services/series-upload-service');
const { createReadingItemFromUpload } = require('../services/reading-upload-service');
const {
  MusicUploadSessionError,
  createMusicUploadSession,
  getMusicUploadSession,
  updateMusicUploadTrackTags,
  commitMusicUploadTrack,
  cancelMusicUploadSession,
  cleanupStaleMusicUploadSessions,
} = require('../services/music-upload-session-service');
const {
  MusicLibraryScanError,
  scanMusicLibrary,
} = require('../services/music-library-scan-service');

const router = express.Router();

const storage = multer.diskStorage({
  destination(req, file, callback) {
    callback(null, config.uploadTempPath);
  },
  filename(req, file, callback) {
    const extension = path.extname(file.originalname || '').toLowerCase().slice(0, 12);
    callback(null, `${Date.now()}-${crypto.randomUUID()}${extension}`);
  },
});

const multipartUpload = multer({
  storage,
  limits: {
    files: 101,
    fields: 20,
    fieldNameSize: 100,
    fieldSize: 64 * 1024,
    fileSize: config.uploadMaxVideoBytes,
  },
  fileFilter(req, file, callback) {
    const extension = path.extname(file.originalname || '').toLowerCase();
    if (file.fieldname === 'video' || file.fieldname === 'videos') {
      if (!SUPPORTED_EXTENSIONS.has(extension)) {
        return callback(new Error('Formato video non supportato.'));
      }
      return callback(null, true);
    }
    if (file.fieldname === 'audio') {
      if (!isMusicExtensionAllowed(extension)) {
        return callback(new Error('Formato musicale non supportato.'));
      }
      return callback(null, true);
    }
    if (file.fieldname === 'document') {
      if (!isReadingExtensionAllowed(req.params?.category, extension)) {
        return callback(new Error('Formato di lettura non supportato per questa categoria.'));
      }
      return callback(null, true);
    }
    if (file.fieldname === 'poster') {
      const posterExtension = extensionFromMime(file.mimetype) || normalizeExtension(extension);
      if (!posterExtension) return callback(new Error('Formato copertina non supportato.'));
      return callback(null, true);
    }
    return callback(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
  },
}).fields([
  { name: 'video', maxCount: 1 },
  { name: 'videos', maxCount: 100 },
  { name: 'document', maxCount: 1 },
  { name: 'audio', maxCount: 100 },
  { name: 'poster', maxCount: 1 },
]);

function requestFiles(req) {
  return Object.values(req.files || {}).flat().filter(Boolean);
}

async function cleanupRequestFiles(req) {
  await Promise.all(requestFiles(req).map((file) => fs.rm(file.path, { force: true }).catch(() => {})));
}

function receiveMultipart(req, res, next) {
  allowLongUpload(req);
  multipartUpload(req, res, async (error) => {
    if (!error) return next();
    await cleanupRequestFiles(req);
    // A receipt timeout may already have sent 408 and closed the connection.
    if (req.destroyed || res.headersSent || res.destroyed) return;
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'Il file supera il limite configurato sul server.' });
    }
    const status = error instanceof multer.MulterError ? 400 : 422;
    return res.status(status).json({ error: error.message || 'Caricamento non valido.' });
  });
}

function singleFile(req, fieldName) {
  return req.files?.[fieldName]?.[0] || null;
}

function requireStorage(req, res, next) {
  if (!config.storageInitializationError) return next();
  return res.status(503).json({
    error: 'Archivio non raggiungibile. Riavvia il server dopo aver reso disponibile il volume della libreria.',
  });
}

function requireLocalAdministration(req, res, next) {
  if (req.baiaLocalAccess === true) return next();
  return res.status(403).json({
    error: 'La scansione della libreria musicale è disponibile soltanto dal browser amministrativo sul PC server.',
    code: 'LOCAL_ADMIN_REQUIRED',
  });
}

async function cleanupStaleUploads() {
  const maximumAge = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const entries = await fs.readdir(config.uploadTempPath, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.map(async (entry) => {
    const candidate = path.join(config.uploadTempPath, entry.name);
    try {
      const stats = await fs.stat(candidate);
      if (now - stats.mtimeMs > maximumAge) await fs.rm(candidate, { recursive: true, force: true });
    } catch {}
  }));
}

cleanupStaleUploads().catch((error) => {
  console.warn('Pulizia upload temporanei non completata:', error.message);
});
cleanupStaleMusicUploadSessions().catch((error) => {
  console.warn('Pulizia sessioni musicali temporanee non completata:', error.message);
});

const listUploadSeries = db.prepare(`
  SELECT series_uuid AS seriesUuid, title, year, genres_json AS genresJson, updated_at AS updatedAt
  FROM series
  WHERE available = 1
  ORDER BY title COLLATE NOCASE
`);

router.get('/status', (req, res) => {
  res.json({
    categories: [
      { id: 'movie', label: 'Film', enabled: true },
      { id: 'series', label: 'Serie', enabled: true },
      { id: 'music', label: 'Musica', enabled: true },
      { id: 'books', label: 'Libri', enabled: true },
      { id: 'comics', label: 'Fumetti', enabled: true },
      { id: 'manga', label: 'Manga', enabled: true },
    ],
    moviePath: config.mediaPaths.movies,
    seriesPath: config.mediaPaths.series,
    musicPath: config.mediaPaths.music,
    readingPaths: {
      books: config.mediaPaths.books,
      comics: config.mediaPaths.comics,
      manga: config.mediaPaths.manga,
    },
    storageAvailable: !config.storageInitializationError,
    series: listUploadSeries.all().map((item) => ({
      seriesUuid: item.seriesUuid,
      title: item.title,
      year: item.year == null ? null : Number(item.year),
      genres: (() => { try { const value = JSON.parse(item.genresJson || '[]'); return Array.isArray(value) ? value : []; } catch { return []; } })(),
      posterUrl: `/api/series/${encodeURIComponent(item.seriesUuid)}/poster?v=${encodeURIComponent(item.updatedAt || '')}`,
    })),
    maxVideoBytes: config.uploadMaxVideoBytes,
    maxMusicBytes: config.uploadMaxVideoBytes,
    maxReadingBytes: config.uploadMaxVideoBytes,
    maxPosterBytes: MAX_POSTER_BYTES,
    supportedVideoExtensions: [...SUPPORTED_EXTENSIONS].sort(),
    supportedMusicExtensions: supportedMusicExtensions(),
    supportedReadingExtensions: supportedReadingExtensions(),
    musicLibraryScanAvailable: req.baiaLocalAccess === true,
  });
});


function musicUploadOwnerKey(req) {
  if (req.baiaDevice?.id) return `device:${req.baiaDevice.id}`;
  if (req.baiaLocalAccess) return 'local-admin';
  throw new MusicUploadSessionError('MUSIC_UPLOAD_OWNER_INVALID', 'Sessione upload non autorizzata.', {
    statusCode: 401,
  });
}

function sendMusicUploadError(error, res, next) {
  if (error instanceof MusicUploadSessionError || error.statusCode) {
    return res.status(error.statusCode || 422).json({
      error: error.message,
      code: error.code || 'MUSIC_UPLOAD_ERROR',
      ...(error.contentPreserved ? { contentPreserved: true } : {}),
    });
  }
  return next(error);
}

router.post('/music/scan-library', requireStorage, requireLocalAdministration, async (req, res, next) => {
  try {
    const report = await scanMusicLibrary();
    return res.json({ report });
  } catch (error) {
    if (error instanceof MusicLibraryScanError || error.statusCode) {
      return res.status(error.statusCode || 422).json({
        error: error.message,
        code: error.code || 'MUSIC_LIBRARY_SCAN_FAILED',
      });
    }
    return next(error);
  }
});

router.post('/music/sessions', requireStorage, receiveMultipart, async (req, res, next) => {
  try {
    const session = await createMusicUploadSession(req.files?.audio || [], musicUploadOwnerKey(req));
    return res.status(201).json({ session });
  } catch (error) {
    await cleanupRequestFiles(req);
    return sendMusicUploadError(error, res, next);
  }
});

router.get('/music/sessions/:sessionId', requireStorage, async (req, res, next) => {
  try {
    const session = await getMusicUploadSession(req.params.sessionId, musicUploadOwnerKey(req));
    return res.json({ session });
  } catch (error) {
    return sendMusicUploadError(error, res, next);
  }
});

router.put('/music/sessions/:sessionId/tracks/:trackId/tags', requireStorage, async (req, res, next) => {
  try {
    const track = await updateMusicUploadTrackTags(
      req.params.sessionId,
      req.params.trackId,
      musicUploadOwnerKey(req),
      req.body,
    );
    return res.json({ track });
  } catch (error) {
    return sendMusicUploadError(error, res, next);
  }
});

router.post('/music/sessions/:sessionId/tracks/:trackId/commit', requireStorage, async (req, res, next) => {
  try {
    const result = await commitMusicUploadTrack(
      req.params.sessionId,
      req.params.trackId,
      musicUploadOwnerKey(req),
    );
    return res.status(201).json(result);
  } catch (error) {
    return sendMusicUploadError(error, res, next);
  }
});

router.post('/music/sessions/:sessionId/cancel', requireStorage, async (req, res, next) => {
  try {
    const result = await cancelMusicUploadSession(req.params.sessionId, musicUploadOwnerKey(req));
    return res.json(result);
  } catch (error) {
    return sendMusicUploadError(error, res, next);
  }
});

router.post('/movies', requireStorage, receiveMultipart, async (req, res, next) => {
  try {
    const movie = await createMovieFromUpload({
      video: singleFile(req, 'video'),
      poster: singleFile(req, 'poster'),
      fields: req.body,
    });
    return res.status(201).json({ movie });
  } catch (error) {
    await cleanupRequestFiles(req);
    if (error.code === 'EEXIST') {
      return res.status(409).json({ error: 'Esiste già un file con questo titolo.' });
    }
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    if (error.contentPreserved) return res.status(500).json({ error: error.message, contentPreserved: true });
    if (/obbligatorio|anno|Formato|copertina|vuota|supportato/i.test(error.message)) {
      return res.status(422).json({ error: error.message });
    }
    return next(error);
  }
});


router.post('/series', requireStorage, receiveMultipart, async (req, res, next) => {
  try {
    const result = await createSeriesFromUpload({
      videos: req.files?.videos || [],
      poster: singleFile(req, 'poster'),
      fields: req.body,
    });
    return res.status(201).json(result);
  } catch (error) {
    await cleanupRequestFiles(req);
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    if (error.contentPreserved) return res.status(500).json({ error: error.message, contentPreserved: true });
    if (/obbligatorio|anno|stagione|episodio|numerazione|Formato|copertina|Seleziona|massimo/i.test(error.message)) {
      return res.status(422).json({ error: error.message });
    }
    return next(error);
  }
});


router.post('/reading/:category', requireStorage, receiveMultipart, async (req, res, next) => {
  try {
    const item = await createReadingItemFromUpload({
      category: req.params.category,
      document: singleFile(req, 'document'),
      poster: singleFile(req, 'poster'),
      fields: req.body,
    });
    return res.status(201).json({ item });
  } catch (error) {
    await cleanupRequestFiles(req);
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    if (error.contentPreserved) return res.status(500).json({ error: error.message, contentPreserved: true });
    if (/obbligatorio|anno|Formato|copertina|vuota|supportato|categoria/i.test(error.message)) {
      return res.status(422).json({ error: error.message });
    }
    return next(error);
  }
});

module.exports = router;
