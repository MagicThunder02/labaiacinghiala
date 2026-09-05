'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const db = require('../database');
const config = require('../config');
const {
  assertRealPathInsideLibrary,
  isInsideDirectory,
  toLibraryRelativePath,
} = require('./library-path-service');
const {
  movieFilePath,
  seriesDirectoryPath,
} = require('./video-library-path-service');
const { readingDirectoryPath } = require('./reading-library-path-service');
const {
  musicAlbumDirectoryPath,
  musicCoverCachePath,
} = require('./music-library-path-service');
const { withMusicMetadataEditLock } = require('./music-metadata-edit-lock');

class ContentDeleteError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'ContentDeleteError';
    this.code = code;
    this.statusCode = options.statusCode || 409;
  }
}

const getMovie = db.prepare(`
  SELECT id, media_type AS mediaType, relative_path AS relativePath,
         file_path AS filePath, title
  FROM movies
  WHERE id = ? AND media_type = 'movie'
  LIMIT 1
`);
const getSeries = db.prepare(`
  SELECT id, series_uuid AS seriesUuid, relative_path AS relativePath,
         directory_path AS directoryPath, title
  FROM series
  WHERE series_uuid = ?
  LIMIT 1
`);
const getReading = db.prepare(`
  SELECT id, content_uuid AS contentUuid, category, relative_path AS relativePath,
         file_path AS filePath, title
  FROM reading_items
  WHERE id = ?
  LIMIT 1
`);
const getAlbum = db.prepare(`
  SELECT id, album_uuid AS albumUuid, title,
         directory_path AS directoryPath, relative_path AS relativePath,
         cover_cache_path AS coverCachePath
  FROM music_albums
  WHERE album_uuid = ?
  LIMIT 1
`);

const deleteMovieRow = db.prepare('DELETE FROM movies WHERE id = ? AND media_type = \'movie\'');
const deleteSeriesEpisodes = db.prepare("DELETE FROM movies WHERE series_uuid = ? AND media_type = 'series'");
const deleteSeriesRow = db.prepare('DELETE FROM series WHERE series_uuid = ?');
const deleteReadingRow = db.prepare('DELETE FROM reading_items WHERE id = ?');
const deleteAlbumTracks = db.prepare('DELETE FROM music_tracks WHERE album_id = ?');
const deleteAlbumRow = db.prepare('DELETE FROM music_albums WHERE id = ?');
const deleteOrphanMusicArtists = db.prepare(`
  DELETE FROM music_artists
  WHERE NOT EXISTS (SELECT 1 FROM music_album_artists aa WHERE aa.artist_id = music_artists.id)
    AND NOT EXISTS (SELECT 1 FROM music_track_artists ta WHERE ta.artist_id = music_artists.id)
`);

function deleteError(code, message, statusCode = 409, cause = null) {
  return new ContentDeleteError(code, message, { statusCode, cause });
}

async function pathState(candidate) {
  try {
    return await fs.lstat(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function assertSectionDirectory(candidatePath, sectionRoot, label) {
  const target = path.resolve(candidatePath);
  const root = path.resolve(sectionRoot);
  if (target === root || !isInsideDirectory(root, target)) {
    throw deleteError(
      'DELETE_PATH_NOT_ALLOWED',
      `La cartella di ${label} non è una sottocartella valida della sezione media prevista.`,
    );
  }
  return target;
}

async function stageDirectory(candidatePath, sectionRoot, label) {
  const target = assertSectionDirectory(candidatePath, sectionRoot, label);
  const stats = await pathState(target);
  if (!stats) {
    return {
      missing: true,
      originalPath: target,
      stagedPath: null,
      async restore() {},
      async purge() {},
    };
  }
  if (!stats.isDirectory()) {
    throw deleteError('DELETE_TARGET_NOT_DIRECTORY', `Il percorso di ${label} non è una cartella.`);
  }

  try {
    await assertRealPathInsideLibrary(target, { allowRoot: false });
  } catch (error) {
    throw deleteError(
      'DELETE_PATH_UNSAFE',
      `La cartella di ${label} non può essere eliminata perché il percorso non è sicuro.`,
      409,
      error,
    );
  }

  const stagingRoot = path.join(config.libraryPath, '.baia-delete-staging');
  await fs.mkdir(stagingRoot, { recursive: true });
  await assertRealPathInsideLibrary(stagingRoot, { allowRoot: false });
  const relative = toLibraryRelativePath(target);
  const stagedPath = path.join(
    stagingRoot,
    `${label.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase()}-${crypto.randomUUID()}`,
  );

  try {
    await fs.rename(target, stagedPath);
  } catch (error) {
    throw deleteError(
      'DELETE_DIRECTORY_STAGE_FAILED',
      `Impossibile preparare l’eliminazione della cartella “${relative}”. Nessuna riga del database è stata modificata.`,
      500,
      error,
    );
  }

  return {
    missing: false,
    originalPath: target,
    stagedPath,
    async restore() {
      if (!await pathState(stagedPath)) return;
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.rename(stagedPath, target);
    },
    async purge() {
      await fs.rm(stagedPath, { recursive: true, force: true });
      await fs.rmdir(stagingRoot).catch((error) => {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error?.code)) throw error;
      });
    },
  };
}

async function withStagedDirectoryDeletion({ directoryPath, sectionRoot, label, deleteDatabaseRows }) {
  const staged = await stageDirectory(directoryPath, sectionRoot, label);
  let committed = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      deleteDatabaseRows();
      db.exec('COMMIT');
      committed = true;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } catch (error) {
    if (!staged.missing) {
      try {
        await staged.restore();
      } catch (restoreError) {
        throw deleteError(
          'DELETE_ROLLBACK_FAILED',
          'La cancellazione nel database è stata annullata, ma non è stato possibile ripristinare la cartella spostata. Controlla .baia-delete-staging.',
          500,
          new AggregateError([error, restoreError]),
        );
      }
    }
    if (error instanceof ContentDeleteError) throw error;
    throw deleteError('DELETE_DATABASE_FAILED', 'Eliminazione dal database non riuscita; la cartella è stata ripristinata.', 500, error);
  }

  let cleanupPending = false;
  if (committed && !staged.missing) {
    try {
      await staged.purge();
    } catch (error) {
      cleanupPending = true;
      console.error(`Pulizia finale non riuscita per ${label}:`, error);
    }
  }

  return { directoryAlreadyMissing: staged.missing, cleanupPending };
}

async function deleteMovie(movieId) {
  const id = Number.parseInt(movieId, 10);
  const row = Number.isInteger(id) ? getMovie.get(id) : null;
  if (!row) throw deleteError('MOVIE_NOT_FOUND', 'Film non trovato.', 404);
  const directoryPath = path.dirname(movieFilePath(row));
  const result = await withStagedDirectoryDeletion({
    directoryPath,
    sectionRoot: config.mediaPaths.movies,
    label: 'film',
    deleteDatabaseRows: () => {
      const deleted = deleteMovieRow.run(row.id);
      if (Number(deleted.changes || 0) !== 1) throw deleteError('MOVIE_DELETE_CONFLICT', 'Il film non è più presente nel database.', 409);
    },
  });
  return { kind: 'movie', id: String(row.id), title: row.title, ...result };
}

async function deleteSeries(seriesUuid) {
  const uuid = String(seriesUuid || '').trim();
  const row = uuid ? getSeries.get(uuid) : null;
  if (!row) throw deleteError('SERIES_NOT_FOUND', 'Serie non trovata.', 404);
  const result = await withStagedDirectoryDeletion({
    directoryPath: seriesDirectoryPath(row),
    sectionRoot: config.mediaPaths.series,
    label: 'serie',
    deleteDatabaseRows: () => {
      deleteSeriesEpisodes.run(row.seriesUuid);
      const deleted = deleteSeriesRow.run(row.seriesUuid);
      if (Number(deleted.changes || 0) !== 1) throw deleteError('SERIES_DELETE_CONFLICT', 'La serie non è più presente nel database.', 409);
    },
  });
  return { kind: 'series', id: `series:${row.seriesUuid}`, seriesUuid: row.seriesUuid, title: row.title, ...result };
}

async function deleteReading(readingId) {
  const id = Number.parseInt(readingId, 10);
  const row = Number.isInteger(id) ? getReading.get(id) : null;
  if (!row) throw deleteError('READING_NOT_FOUND', 'Contenuto di lettura non trovato.', 404);
  const sectionRoot = config.mediaPaths[row.category];
  if (!sectionRoot) throw deleteError('READING_CATEGORY_INVALID', 'Categoria di lettura non valida.', 409);
  const result = await withStagedDirectoryDeletion({
    directoryPath: readingDirectoryPath(row),
    sectionRoot,
    label: row.category,
    deleteDatabaseRows: () => {
      const deleted = deleteReadingRow.run(row.id);
      if (Number(deleted.changes || 0) !== 1) throw deleteError('READING_DELETE_CONFLICT', 'Il contenuto non è più presente nel database.', 409);
    },
  });
  return { kind: 'reading', id: `reading:${row.id}`, category: row.category, title: row.title, ...result };
}

async function deleteMusicAlbum(albumUuid) {
  return withMusicMetadataEditLock(async () => {
    const uuid = String(albumUuid || '').trim();
    const row = uuid ? getAlbum.get(uuid) : null;
    if (!row) throw deleteError('MUSIC_ALBUM_NOT_FOUND', 'Album musicale non trovato.', 404);
    const result = await withStagedDirectoryDeletion({
      directoryPath: musicAlbumDirectoryPath(row),
      sectionRoot: config.mediaPaths.music,
      label: 'album',
      deleteDatabaseRows: () => {
        deleteAlbumTracks.run(row.id);
        const deleted = deleteAlbumRow.run(row.id);
        if (Number(deleted.changes || 0) !== 1) throw deleteError('MUSIC_ALBUM_DELETE_CONFLICT', 'L’album non è più presente nel database.', 409);
        deleteOrphanMusicArtists.run();
      },
    });

    try {
      const cachePath = musicCoverCachePath(row.coverCachePath);
      if (cachePath) await fs.rm(cachePath, { force: true });
    } catch (error) {
      console.warn('Pulizia cache copertina album non riuscita:', error);
    }
    return { kind: 'music-album', id: `music-album:${row.albumUuid}`, albumId: row.albumUuid, title: row.title, ...result };
  });
}

module.exports = {
  ContentDeleteError,
  deleteMovie,
  deleteSeries,
  deleteReading,
  deleteMusicAlbum,
};
