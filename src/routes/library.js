const express = require('express');
const config = require('../config');
const db = require('../database');
const { SUPPORTED_EXTENSIONS } = require('../media-formats');
const { supportedReadingExtensions } = require('../reading-formats');

const router = express.Router();

const getStats = db.prepare(`
  SELECT
    COUNT(*) AS totalItems,
    SUM(CASE WHEN media_type = 'movie' THEN 1 ELSE 0 END) AS movies,
    SUM(CASE WHEN media_type = 'series' THEN 1 ELSE 0 END) AS episodes,
    SUM(CASE WHEN available = 0 THEN 1 ELSE 0 END) AS unavailable,
    COALESCE(SUM(size_bytes), 0) AS totalBytes
  FROM movies
`);
const getReadingStats = db.prepare(`
  SELECT
    COUNT(*) AS readingItems,
    SUM(CASE WHEN category = 'books' THEN 1 ELSE 0 END) AS books,
    SUM(CASE WHEN category = 'comics' THEN 1 ELSE 0 END) AS comics,
    SUM(CASE WHEN category = 'manga' THEN 1 ELSE 0 END) AS manga,
    SUM(CASE WHEN available = 0 THEN 1 ELSE 0 END) AS readingUnavailable,
    COALESCE(SUM(size_bytes), 0) AS readingBytes
  FROM reading_items
`);
function serializeStats(row, readingRow) {
  return {
    totalItems: Number(row?.totalItems || 0),
    movies: Number(row?.movies || 0),
    episodes: Number(row?.episodes || 0),
    totalBytes: Number(row?.totalBytes || 0),
    unavailable: Number(row?.unavailable || 0),
    readingItems: Number(readingRow?.readingItems || 0),
    books: Number(readingRow?.books || 0),
    comics: Number(readingRow?.comics || 0),
    manga: Number(readingRow?.manga || 0),
    readingBytes: Number(readingRow?.readingBytes || 0),
    readingUnavailable: Number(readingRow?.readingUnavailable || 0),
  };
}

router.get('/status', (req, res) => {
  res.json({
    libraryPath: config.libraryPath,
    mediaPaths: config.mediaPaths,
    storageAvailable: !config.storageInitializationError,
    storageError: config.storageInitializationError,
    supportedExtensions: Array.from(SUPPORTED_EXTENSIONS).sort(),
    supportedReadingExtensions: supportedReadingExtensions(),
    stats: serializeStats(getStats.get(), getReadingStats.get()),
  });
});



module.exports = router;
