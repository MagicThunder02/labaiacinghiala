'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const db = require('../database');
const { getMusicFormat } = require('../music-formats');
const { parseByteRange } = require('../utils/range');
const { musicTrackPath } = require('./music-library-path-service');

const findTrackForStream = db.prepare(`
  SELECT
    track_uuid AS trackId,
    relative_path AS relativePath,
    file_name AS fileName,
    extension,
    mime_type AS mimeType,
    available
  FROM music_tracks
  WHERE track_uuid = ?
  LIMIT 1
`);

function safeContentType(track) {
  const format = getMusicFormat(track?.extension);
  if (!format) return 'application/octet-stream';
  const stored = String(track?.mimeType || '').trim().toLowerCase();
  return format.mimeTypes.includes(stored) ? stored : format.mimeTypes[0];
}

async function resolveMusicTrackStream(trackId) {
  const track = findTrackForStream.get(String(trackId || ''));
  if (!track || Number(track.available) !== 1) return null;

  try {
    const filePath = musicTrackPath(track);
    const stats = await fsp.stat(filePath);
    if (!stats.isFile()) return null;
    return {
      filePath,
      fileName: track.fileName,
      mimeType: safeContentType(track),
      size: Number(stats.size),
      modifiedAtMs: Math.trunc(stats.mtimeMs),
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function sendMusicTrackStream(req, res, next, trackId) {
  try {
    const stream = await resolveMusicTrackStream(trackId);
    if (!stream) return res.status(404).json({ error: 'Brano non disponibile.' });

    const range = parseByteRange(req.headers.range, stream.size);
    const commonHeaders = {
      'Accept-Ranges': 'bytes',
      'Content-Type': stream.mimeType,
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(stream.fileName)}`,
      'Cache-Control': 'private, max-age=0, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
    };

    if (range?.invalid) {
      res.set('Content-Range', `bytes */${stream.size}`);
      return res.status(416).end();
    }

    if (range) {
      res.writeHead(206, {
        ...commonHeaders,
        'Content-Range': `bytes ${range.start}-${range.end}/${stream.size}`,
        'Content-Length': range.length,
      });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(stream.filePath, { start: range.start, end: range.end })
        .on('error', next)
        .pipe(res);
    }

    res.writeHead(200, { ...commonHeaders, 'Content-Length': stream.size });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(stream.filePath).on('error', next).pipe(res);
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  resolveMusicTrackStream,
  safeContentType,
  sendMusicTrackStream,
};
