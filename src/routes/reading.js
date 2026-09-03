const express = require('express');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const mime = require('mime-types');
const db = require('../database');
const { getReadingCategory } = require('../reading-formats');
const { getProfileKey } = require('../utils/profile-key');
const { parseByteRange } = require('../utils/range');
const { buildReadingHome } = require('../services/reading-home-service');
const { buildReadingFilterFacets } = require('../services/reading-filter-facets-service');
const { serializeReadingLocator } = require('../services/reading-bookmark-service');
const {
  cbzPages,
  epubEntries,
  estimatePdfPageCount,
  parseZipArchive,
  readZipEntry,
} = require('../services/reading-archive-service');
const {
  readingFilePath,
  readingCoverPath,
} = require('../services/reading-library-path-service');

const router = express.Router();
const HOME_RECENT_LIMIT = 10;
const HOME_LATEST_LIMIT = 20;
const HOME_RECOMMENDED_LIMIT = 30;

const selectColumns = `
  SELECT
    r.id,
    r.content_uuid AS contentId,
    r.category,
    r.file_name AS fileName,
    r.relative_path AS relativePath,
    r.title,
    r.year,
    r.author,
    r.genres_json AS genresJson,
    r.extension,
    r.mime_type AS mimeType,
    r.size_bytes AS sizeBytes,
    CASE WHEN COALESCE(r.cover_path, '') = '' THEN 0 ELSE 1 END AS hasCover,
    r.added_at AS addedAt,
    r.updated_at AS updatedAt,
    r.available,
    b.locator_json AS locatorJson,
    b.updated_at AS bookmarkedAt
  FROM reading_items r
  LEFT JOIN reading_bookmarks b
    ON b.reading_item_id = r.id AND b.profile_key = ?
`;

const listItems = db.prepare(`${selectColumns}
  WHERE r.category = ? AND r.available = 1
    AND (? = '' OR r.title LIKE ? COLLATE NOCASE OR r.author LIKE ? COLLATE NOCASE OR r.file_name LIKE ? COLLATE NOCASE)
    AND (? = '' OR COALESCE(r.author, '') = ? COLLATE NOCASE)
    AND (? = 0 OR r.year = ?)
  ORDER BY r.title COLLATE NOCASE ASC
`);
const listFilterMetadata = db.prepare(`
  SELECT year, genres_json AS genresJson, author
  FROM reading_items
  WHERE category = ? AND available = 1
`);
const listHomeItems = db.prepare(`${selectColumns}
  WHERE r.category = ? AND r.available = 1
  ORDER BY r.title COLLATE NOCASE ASC
`);
const getItem = db.prepare(`${selectColumns}
  WHERE r.id = ? AND r.available = 1
`);
const getRawItem = db.prepare('SELECT * FROM reading_items WHERE id = ?');
const getBookmark = db.prepare(`
  SELECT locator_json AS locatorJson, updated_at AS updatedAt
  FROM reading_bookmarks
  WHERE reading_item_id = ? AND profile_key = ?
`);
const saveBookmark = db.prepare(`
  INSERT INTO reading_bookmarks (reading_item_id, profile_key, locator_json, updated_at)
  VALUES (?, ?, ?, STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(reading_item_id, profile_key) DO UPDATE SET
    locator_json = excluded.locator_json,
    updated_at = excluded.updated_at
`);

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function toBoolean(value) {
  return value === 1 || value === true;
}

function serializeItem(row) {
  const genres = parseJson(row.genresJson ?? row.genres_json, []);
  const locator = row.locatorJson == null ? null : parseJson(row.locatorJson, null);
  const updatedAt = row.updatedAt ?? row.updated_at ?? '';
  return {
    id: Number(row.id),
    contentId: row.contentId ?? row.content_uuid,
    category: row.category,
    title: row.title,
    year: row.year == null ? null : Number(row.year),
    author: row.author || '',
    genres: Array.isArray(genres) ? genres : [],
    fileName: row.fileName ?? row.file_name,
    relativePath: row.relativePath ?? row.relative_path,
    extension: row.extension,
    mimeType: row.mimeType ?? row.mime_type,
    sizeBytes: Number(row.sizeBytes ?? row.size_bytes ?? 0),
    addedAt: row.addedAt ?? row.added_at,
    updatedAt,
    bookmarkedAt: row.bookmarkedAt ?? row.bookmarked_at ?? null,
    bookmark: locator,
    available: row.available === undefined ? true : toBoolean(row.available),
    fileUrl: `/api/reading/${row.id}/file`,
    coverUrl: toBoolean(row.hasCover) || Boolean(row.cover_path)
      ? `/api/reading/${row.id}/cover?v=${encodeURIComponent(updatedAt)}`
      : null,
  };
}

function requireCategory(req, res) {
  const category = getReadingCategory(req.query.category);
  if (!category) {
    res.status(400).json({ error: 'Categoria di lettura non valida.' });
    return null;
  }
  return category;
}

function parseLimit(value, fallback = 100, maximum = 250) {
  const number = Number.parseInt(value, 10);
  return Number.isInteger(number) && number > 0 ? Math.min(number, maximum) : fallback;
}

function parseOffset(value) {
  const number = Number.parseInt(value, 10);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function parseYear(value) {
  const year = Number.parseInt(value, 10);
  return Number.isInteger(year) && year > 0 ? year : 0;
}

function sameText(left, right) {
  return String(left || '').localeCompare(String(right || ''), 'it', { sensitivity: 'base' }) === 0;
}

router.get('/filters', (req, res) => {
  const category = requireCategory(req, res);
  if (!category) return;
  return res.json(buildReadingFilterFacets(listFilterMetadata.all(category.id), {
    genre: req.query.genre,
    author: req.query.author,
    year: req.query.year,
  }));
});

router.get('/home', (req, res) => {
  const category = requireCategory(req, res);
  if (!category) return;
  const profileKey = getProfileKey(req);
  const items = listHomeItems.all(profileKey, category.id).map(serializeItem);
  const home = buildReadingHome(items, profileKey, {
    recentLimit: HOME_RECENT_LIMIT,
    latestLimit: HOME_LATEST_LIMIT,
    recommendedLimit: HOME_RECOMMENDED_LIMIT,
  });
  return res.json(home);
});

router.get('/', (req, res) => {
  const category = requireCategory(req, res);
  if (!category) return;
  const profileKey = getProfileKey(req);
  const search = String(req.query.search || '').trim().slice(0, 200);
  const wildcard = `%${search}%`;
  const genre = String(req.query.genre || '').trim().slice(0, 100);
  const author = String(req.query.author || '').trim().slice(0, 500);
  const year = parseYear(req.query.year);
  const limit = parseLimit(req.query.limit);
  const offset = parseOffset(req.query.offset);
  let rows = listItems.all(
    profileKey,
    category.id,
    search,
    wildcard,
    wildcard,
    wildcard,
    author,
    author,
    year,
    year,
  );
  if (genre) {
    rows = rows.filter((row) => {
      const genres = parseJson(row.genresJson, []);
      return Array.isArray(genres) && genres.some((item) => sameText(item, genre));
    });
  }
  const count = rows.length;
  const items = rows.slice(offset, offset + limit).map(serializeItem);
  return res.json({ items, count, limit, offset });
});



function parseEntryId(value) {
  const number = Number.parseInt(value, 10);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function readerFormat(item) {
  const extension = String(item?.extension || '').toLowerCase();
  if (extension === '.pdf') return 'pdf';
  if (extension === '.cbz') return 'cbz';
  if (extension === '.epub') return 'epub';
  return null;
}

router.get('/:id/reader/manifest', async (req, res, next) => {
  const item = getRawItem.get(req.params.id);
  if (!item || Number(item.available) !== 1) return res.status(404).json({ error: 'Contenuto non trovato.' });
  const format = readerFormat(item);
  if (!format) return res.status(415).json({ error: 'Formato non supportato dal reader.' });
  try {
    const bookmarkRow = getBookmark.get(req.params.id, getProfileKey(req));
    const bookmark = bookmarkRow ? parseJson(bookmarkRow.locatorJson, null) : null;
    if (format === 'pdf') {
      const filePath = readingFilePath(item);
      const pageCount = await estimatePdfPageCount(filePath, Number(item.size_bytes || 0));
      return res.json({
        format,
        pageCount,
        fileUrl: `/api/reading/${item.id}/file`,
        bookmark,
      });
    }

    const filePath = readingFilePath(item);
    const archive = await parseZipArchive(filePath);
    if (format === 'cbz') {
      const pages = cbzPages(archive.entries);
      if (!pages.length) return res.status(422).json({ error: 'Il CBZ non contiene pagine immagine leggibili.' });
      return res.json({ format, pageCount: pages.length, pages, bookmark });
    }

    return res.json({
      format,
      entries: epubEntries(archive.entries),
      bookmark,
    });
  } catch (error) {
    if (error.code === 'ENOENT') return res.status(404).json({ error: 'File non disponibile.' });
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    return next(error);
  }
});

router.get('/:id/reader/entry/:entryId', async (req, res, next) => {
  const item = getRawItem.get(req.params.id);
  if (!item || Number(item.available) !== 1) return res.status(404).json({ error: 'Contenuto non trovato.' });
  const format = readerFormat(item);
  if (!['cbz', 'epub'].includes(format)) return res.status(404).json({ error: 'Risorsa reader non disponibile.' });
  const entryId = parseEntryId(req.params.entryId);
  if (entryId === null) return res.status(400).json({ error: 'Risorsa reader non valida.' });
  try {
    const filePath = readingFilePath(item);
    const archive = await parseZipArchive(filePath);
    const entry = archive.entries.find((candidate) => candidate.id === entryId);
    if (!entry) return res.status(404).json({ error: 'Risorsa reader non trovata.' });
    if (format === 'cbz' && !cbzPages(archive.entries).some((page) => page.entryId === entry.id)) {
      return res.status(404).json({ error: 'Risorsa reader non trovata.' });
    }
    const payload = await readZipEntry(filePath, entry);
    res.set({
      'Content-Type': entry.mimeType || 'application/octet-stream',
      'Content-Length': payload.length,
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.end(payload);
  } catch (error) {
    if (error.code === 'ENOENT') return res.status(404).json({ error: 'File non disponibile.' });
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    return next(error);
  }
});

router.get('/:id/bookmark', (req, res) => {
  const item = getRawItem.get(req.params.id);
  if (!item || Number(item.available) !== 1) return res.status(404).json({ error: 'Contenuto non trovato.' });
  const row = getBookmark.get(req.params.id, getProfileKey(req));
  return res.json({
    bookmark: row ? parseJson(row.locatorJson, null) : null,
    updatedAt: row?.updatedAt || null,
  });
});

router.put('/:id/bookmark', (req, res) => {
  const item = getRawItem.get(req.params.id);
  if (!item || Number(item.available) !== 1) return res.status(404).json({ error: 'Contenuto non trovato.' });
  try {
    const { locator, serialized } = serializeReadingLocator(req.body?.locator);
    const profileKey = getProfileKey(req);
    saveBookmark.run(req.params.id, profileKey, serialized);
    const row = getBookmark.get(req.params.id, profileKey);
    return res.json({ bookmark: locator, updatedAt: row?.updatedAt || null });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

router.get('/:id/cover', async (req, res, next) => {
  const item = getRawItem.get(req.params.id);
  if (!item || Number(item.available) !== 1 || !item.cover_path) return res.status(404).end();
  try {
    const coverPath = readingCoverPath(item);
    if (!coverPath) return res.status(404).end();
    const stats = await fsp.stat(coverPath);
    if (!stats.isFile()) return res.status(404).end();
    res.set({
      'Content-Type': mime.lookup(coverPath) || 'application/octet-stream',
      'Content-Length': stats.size,
      'Cache-Control': 'private, max-age=86400',
    });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(coverPath).on('error', next).pipe(res);
  } catch (error) {
    if (error.code === 'ENOENT') return res.status(404).end();
    return next(error);
  }
});

router.get('/:id/file', async (req, res, next) => {
  const item = getRawItem.get(req.params.id);
  if (!item || Number(item.available) !== 1) return res.status(404).json({ error: 'Contenuto non disponibile.' });
  try {
    const filePath = readingFilePath(item);
    const stats = await fsp.stat(filePath);
    if (!stats.isFile()) return res.status(404).json({ error: 'File non disponibile.' });
    const range = parseByteRange(req.headers.range, stats.size);
    const commonHeaders = {
      'Accept-Ranges': 'bytes',
      'Content-Type': item.mime_type || mime.lookup(filePath) || 'application/octet-stream',
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(item.file_name)}`,
      'Cache-Control': 'private, max-age=0, must-revalidate',
    };
    if (range?.invalid) {
      res.set('Content-Range', `bytes */${stats.size}`);
      return res.status(416).end();
    }
    if (range) {
      res.writeHead(206, {
        ...commonHeaders,
        'Content-Range': `bytes ${range.start}-${range.end}/${stats.size}`,
        'Content-Length': range.length,
      });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(filePath, { start: range.start, end: range.end }).on('error', next).pipe(res);
    }
    res.writeHead(200, { ...commonHeaders, 'Content-Length': stats.size });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(filePath).on('error', next).pipe(res);
  } catch (error) {
    if (error.code === 'ENOENT') return res.status(404).json({ error: 'File non disponibile.' });
    return next(error);
  }
});

router.get('/:id', (req, res) => {
  const profileKey = getProfileKey(req);
  const item = getItem.get(profileKey, req.params.id);
  if (!item) return res.status(404).json({ error: 'Contenuto non trovato.' });
  return res.json({ item: serializeItem(item) });
});

module.exports = router;
module.exports.serializeItem = serializeItem;
