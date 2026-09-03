'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('../config');
const db = require('../database');
const { getMusicFormat } = require('../music-formats');
const {
  MusicImportError,
  buildMusicStoragePlan,
  saveMusicTrackIndex,
} = require('./music-import-service');
const { readMusicFileMetadata } = require('./music-tag-service');
const { withMusicMetadataEditLock } = require('./music-metadata-edit-lock');
const { assertMusicRelativePath, musicTrackPath } = require('./music-library-path-service');

const MAX_REPORTED_ISSUES = 100;

class MusicLibraryScanError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'MusicLibraryScanError';
    this.code = code;
    this.statusCode = options.statusCode || 422;
  }
}

const findTrackByPath = db.prepare(`
  SELECT id, track_uuid AS trackUuid, relative_path AS relativePath,
         size_bytes AS sizeBytes, modified_at AS modifiedAt, available
  FROM music_tracks
  WHERE relative_path = ? COLLATE NOCASE
  LIMIT 1
`);

const touchTrack = db.prepare(`
  UPDATE music_tracks SET
    available = 1,
    last_seen_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'),
    missing_since = NULL
  WHERE id = ?
`);

const listIndexedTracks = db.prepare(`
  SELECT id, relative_path AS relativePath, available
  FROM music_tracks
`);

const markTrackMissing = db.prepare(`
  UPDATE music_tracks SET
    available = 0,
    missing_since = COALESCE(missing_since, STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = ? AND available = 1
`);

function isInsideDirectory(parentDirectory, candidatePath) {
  const parent = path.resolve(parentDirectory);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(parent, candidate);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function comparablePath(value) {
  const resolved = path.resolve(value).normalize('NFC');
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('it') : resolved;
}

function pathsMatch(left, right) {
  return comparablePath(left) === comparablePath(right);
}

function publicRelativePath(filePath, libraryRoot) {
  const relative = path.relative(libraryRoot, filePath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return path.basename(filePath);
  }
  return relative.split(path.sep).join('/');
}

function addIssue(report, issue) {
  if (report.issues.length >= MAX_REPORTED_ISSUES) {
    report.issuesTruncated = true;
    return;
  }
  report.issues.push(issue);
}

async function collectFiles(directory, report, libraryRoot, output = []) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new MusicLibraryScanError(
      'MUSIC_LIBRARY_SCAN_UNAVAILABLE',
      `Impossibile leggere la cartella Musica: ${error.message}`,
      { statusCode: error.code === 'ENOENT' ? 404 : 500, cause: error },
    );
  }

  entries.sort((left, right) => left.name.localeCompare(right.name, 'it', { numeric: true }));
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      report.counts.ignored += 1;
      addIssue(report, {
        relativePath: publicRelativePath(candidate, libraryRoot),
        code: 'MUSIC_LIBRARY_SCAN_SYMLINK',
        message: 'Collegamento simbolico ignorato: la scansione non segue percorsi esterni.',
      });
      continue;
    }
    if (entry.isDirectory()) {
      await collectFiles(candidate, report, libraryRoot, output);
      continue;
    }
    if (!entry.isFile()) continue;
    report.counts.visited += 1;
    output.push(candidate);
  }
  return output;
}

function createReport(now = new Date()) {
  return {
    startedAt: now.toISOString(),
    completedAt: null,
    durationMs: 0,
    counts: {
      visited: 0,
      supported: 0,
      created: 0,
      updated: 0,
      reactivated: 0,
      unchanged: 0,
      missing: 0,
      ignored: 0,
      errors: 0,
    },
    issues: [],
    issuesTruncated: false,
  };
}

async function processSupportedFile(filePath, context) {
  const {
    report,
    musicRoot,
    libraryRoot,
    metadataReader,
    seenPaths,
  } = context;
  const relativePath = assertMusicRelativePath(publicRelativePath(filePath, libraryRoot));
  const absolutePath = path.resolve(filePath);
  seenPaths.add(relativePath.normalize('NFC').toLocaleLowerCase('it'));

  let stats;
  try {
    stats = await fs.stat(absolutePath);
  } catch (error) {
    report.counts.errors += 1;
    addIssue(report, {
      relativePath,
      code: 'MUSIC_LIBRARY_SCAN_STAT_FAILED',
      message: `Impossibile leggere il file: ${error.message}`,
    });
    return;
  }

  const existing = findTrackByPath.get(relativePath);
  if (
    existing
    && Number(existing.available) === 1
    && Number(existing.sizeBytes || 0) === Number(stats.size || 0)
    && Number(existing.modifiedAt || 0) === Math.trunc(stats.mtimeMs)
  ) {
    touchTrack.run(existing.id);
    report.counts.unchanged += 1;
    return;
  }

  let metadata;
  let plan;
  try {
    metadata = await metadataReader(absolutePath);
    plan = buildMusicStoragePlan(metadata, { musicRoot, libraryRoot });
  } catch (error) {
    if (error instanceof MusicImportError) {
      report.counts.ignored += 1;
      addIssue(report, {
        relativePath,
        code: error.code,
        message: error.message,
      });
      return;
    }
    report.counts.errors += 1;
    addIssue(report, {
      relativePath,
      code: error.code || 'MUSIC_LIBRARY_SCAN_METADATA_FAILED',
      message: `Impossibile leggere i metadati: ${error.message}`,
    });
    return;
  }

  if (!pathsMatch(absolutePath, plan.destinationPath)) {
    report.counts.ignored += 1;
    addIssue(report, {
      relativePath,
      code: 'MUSIC_LIBRARY_SCAN_NON_CANONICAL_PATH',
      message: `Struttura non valida. Percorso atteso: ${plan.relativePath}`,
    });
    return;
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    saveMusicTrackIndex(plan, metadata, stats);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    report.counts.errors += 1;
    addIssue(report, {
      relativePath,
      code: error.code || 'MUSIC_LIBRARY_SCAN_INDEX_FAILED',
      message: `Impossibile aggiornare il catalogo: ${error.message}`,
    });
    return;
  }

  if (!existing) report.counts.created += 1;
  else if (Number(existing.available) === 0) report.counts.reactivated += 1;
  else report.counts.updated += 1;
}

async function markMissingTracks(context) {
  const { report, musicRoot, seenPaths } = context;
  for (const track of listIndexedTracks.all()) {
    const absolutePath = musicTrackPath(track);
    if (!isInsideDirectory(musicRoot, absolutePath)) continue;
    const relativeKey = assertMusicRelativePath(track.relativePath).normalize('NFC').toLocaleLowerCase('it');
    if (seenPaths.has(relativeKey)) continue;

    let exists = false;
    try {
      const stats = await fs.stat(absolutePath);
      exists = stats.isFile();
    } catch {}
    if (exists) continue;

    const result = markTrackMissing.run(track.id);
    if (Number(result.changes || 0) > 0) report.counts.missing += 1;
  }
}

async function scanMusicLibrary(options = {}) {
  return withMusicMetadataEditLock(async () => {
    const started = Date.now();
    const report = createReport(new Date(started));
    const musicRoot = path.resolve(options.musicRoot || config.mediaPaths.music);
    const libraryRoot = path.resolve(options.libraryRoot || config.libraryPath);
    const metadataReader = options.metadataReader || readMusicFileMetadata;

    if (!isInsideDirectory(libraryRoot, musicRoot)) {
      throw new MusicLibraryScanError(
        'MUSIC_LIBRARY_SCAN_ROOT_INVALID',
        'La cartella Musica configurata non appartiene alla libreria del server.',
        { statusCode: 500 },
      );
    }

    const rootStats = await fs.stat(musicRoot).catch((error) => {
      throw new MusicLibraryScanError(
        'MUSIC_LIBRARY_SCAN_UNAVAILABLE',
        'La cartella Musica non è disponibile.',
        { statusCode: error.code === 'ENOENT' ? 404 : 500, cause: error },
      );
    });
    if (!rootStats.isDirectory()) {
      throw new MusicLibraryScanError(
        'MUSIC_LIBRARY_SCAN_UNAVAILABLE',
        'Il percorso Musica configurato non è una cartella.',
        { statusCode: 500 },
      );
    }

    const files = await collectFiles(musicRoot, report, libraryRoot);
    const seenPaths = new Set();

    for (const filePath of files) {
      const format = getMusicFormat(filePath);
      if (!format) {
        report.counts.ignored += 1;
        continue;
      }
      report.counts.supported += 1;
      await processSupportedFile(filePath, {
        report,
        musicRoot,
        libraryRoot,
        metadataReader,
        seenPaths,
      });
    }

    await markMissingTracks({ report, musicRoot, seenPaths });
    report.completedAt = new Date().toISOString();
    report.durationMs = Math.max(0, Date.now() - started);
    return report;
  });
}

module.exports = {
  MAX_REPORTED_ISSUES,
  MusicLibraryScanError,
  pathsMatch,
  scanMusicLibrary,
};
