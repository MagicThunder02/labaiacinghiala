const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');
const {
  ensurePairingSchema,
  migratePairingSchemaToDeviceOnly,
  migratePairingInvitesToRevocable,
} = require('./services/pairing-service');
const {
  ensureAccountSchema,
  migrateLegacyProfilesToAccounts,
  migrateDeletedAccountUsernames,
  migrateAccountNamesToUsername,
} = require('./services/account-service');
const {
  normalizeLibraryRelativePath,
} = require('./services/library-path-service');
const {
  portableBasename,
  storedPathToRelative,
} = require('./services/video-library-path-service');
const {
  readingRelativePath,
  readingMetadataRelativePath,
  readingCoverRelativePath,
  readingFilePath,
} = require('./services/reading-library-path-service');
const {
  musicTrackRelativePath,
  musicAlbumRelativePath,
} = require('./services/music-library-path-service');

const TARGET_SCHEMA_VERSION = 19;
const db = new DatabaseSync(config.databasePath, { enableForeignKeyConstraints: true });

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
`);

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function tableExists(tableName) {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1
  `).get(tableName));
}

function createPreMigrationBackup() {
  const currentVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version || 0);
  if (currentVersion >= TARGET_SCHEMA_VERSION) return;

  const catalogTables = ['movies', 'series', 'reading_items', 'music_tracks'];
  const hasCatalogData = catalogTables.some((tableName) => {
    if (!tableExists(tableName)) return false;
    return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get()?.count || 0) > 0;
  });
  if (!hasCatalogData) return;

  fs.mkdirSync(config.databaseBackupsPath, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = path.join(config.databaseBackupsPath, `media-${stamp}-prima-migrazione.sqlite`);
  db.exec(`VACUUM INTO ${sqlString(destination)}`);
}

createPreMigrationBackup();

db.exec(`
  CREATE TABLE IF NOT EXISTS library_identity (
    singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
    library_id TEXT NOT NULL UNIQUE,
    format_version INTEGER NOT NULL CHECK (format_version >= 1),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS movies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL UNIQUE,
    relative_path TEXT NOT NULL,
    file_name TEXT NOT NULL,
    title TEXT NOT NULL,
    year INTEGER,
    extension TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    modified_at INTEGER NOT NULL,
    media_type TEXT NOT NULL DEFAULT 'movie',
    series_title TEXT,
    season_number INTEGER,
    episode_number INTEGER,
    genres_json TEXT NOT NULL DEFAULT '[]',
    director TEXT,
    poster_path TEXT,
    metadata_auto_json TEXT,
    content_uuid TEXT,
    metadata_path TEXT,
    storage_version INTEGER NOT NULL DEFAULT 0,
    available INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0, 1)),
    last_seen_at TEXT,
    missing_since TEXT,
    added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS watch_progress (
    movie_id INTEGER NOT NULL,
    profile_key TEXT NOT NULL DEFAULT 'default',
    seconds REAL NOT NULL DEFAULT 0,
    duration_seconds REAL NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (movie_id, profile_key),
    FOREIGN KEY (movie_id) REFERENCES movies(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS favorites (
    movie_id INTEGER NOT NULL,
    profile_key TEXT NOT NULL DEFAULT 'default',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (movie_id, profile_key),
    FOREIGN KEY (movie_id) REFERENCES movies(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS media_metadata_overrides (
    movie_id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    year INTEGER,
    genres_json TEXT NOT NULL DEFAULT '[]',
    director TEXT,
    poster_path TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (movie_id) REFERENCES movies(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS series (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    series_uuid TEXT NOT NULL UNIQUE,
    directory_path TEXT NOT NULL UNIQUE,
    relative_path TEXT NOT NULL,
    title TEXT NOT NULL,
    year INTEGER,
    genres_json TEXT NOT NULL DEFAULT '[]',
    director TEXT,
    poster_path TEXT,
    metadata_path TEXT NOT NULL,
    storage_version INTEGER NOT NULL DEFAULT 1,
    available INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0, 1)),
    last_seen_at TEXT,
    missing_since TEXT,
    added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS reading_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_uuid TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL CHECK (category IN ('books', 'comics', 'manga')),
    file_path TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    file_name TEXT NOT NULL,
    title TEXT NOT NULL,
    year INTEGER,
    author TEXT NOT NULL DEFAULT '',
    genres_json TEXT NOT NULL DEFAULT '[]',
    extension TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    modified_at INTEGER NOT NULL,
    cover_path TEXT,
    metadata_path TEXT NOT NULL,
    storage_version INTEGER NOT NULL DEFAULT 1,
    available INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0, 1)),
    last_seen_at TEXT,
    missing_since TEXT,
    added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS reading_bookmarks (
    reading_item_id INTEGER NOT NULL,
    profile_key TEXT NOT NULL DEFAULT 'default',
    locator_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (reading_item_id, profile_key),
    FOREIGN KEY (reading_item_id) REFERENCES reading_items(id) ON DELETE CASCADE
  );


  CREATE TABLE IF NOT EXISTS music_artists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    artist_uuid TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    sort_name TEXT,
    added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS music_albums (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    album_uuid TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    directory_path TEXT NOT NULL UNIQUE,
    relative_path TEXT NOT NULL,
    album_artists_json TEXT NOT NULL DEFAULT '[]',
    genres_json TEXT NOT NULL DEFAULT '[]',
    year INTEGER,
    compilation INTEGER NOT NULL DEFAULT 0 CHECK (compilation IN (0, 1)),
    cover_cache_path TEXT,
    added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS music_album_artists (
    album_id INTEGER NOT NULL,
    artist_id INTEGER NOT NULL,
    position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
    PRIMARY KEY (album_id, artist_id),
    UNIQUE (album_id, position),
    FOREIGN KEY (album_id) REFERENCES music_albums(id) ON DELETE CASCADE,
    FOREIGN KEY (artist_id) REFERENCES music_artists(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS music_tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    track_uuid TEXT NOT NULL UNIQUE,
    album_id INTEGER NOT NULL,
    file_path TEXT NOT NULL UNIQUE,
    relative_path TEXT NOT NULL,
    file_name TEXT NOT NULL,
    title TEXT NOT NULL,
    artists_json TEXT NOT NULL DEFAULT '[]',
    genres_json TEXT NOT NULL DEFAULT '[]',
    composers_json TEXT NOT NULL DEFAULT '[]',
    comment TEXT NOT NULL DEFAULT '',
    date_text TEXT NOT NULL DEFAULT '',
    year INTEGER,
    track_number INTEGER,
    track_total INTEGER,
    disc_number INTEGER,
    disc_total INTEGER,
    compilation INTEGER NOT NULL DEFAULT 0 CHECK (compilation IN (0, 1)),
    extension TEXT NOT NULL CHECK (extension IN ('.mp3', '.flac', '.wav')),
    mime_type TEXT NOT NULL,
    duration_seconds REAL NOT NULL DEFAULT 0,
    duration_ms REAL NOT NULL DEFAULT 0,
    bitrate_kbps REAL,
    sample_rate_hz REAL,
    channels INTEGER,
    bits_per_sample INTEGER,
    codec TEXT,
    container_format TEXT,
    is_lossless INTEGER NOT NULL DEFAULT 0 CHECK (is_lossless IN (0, 1)),
    bitrate_mode TEXT,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    modified_at INTEGER NOT NULL,
    has_cover_art INTEGER NOT NULL DEFAULT 0 CHECK (has_cover_art IN (0, 1)),
    available INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0, 1)),
    last_seen_at TEXT,
    missing_since TEXT,
    added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (album_id) REFERENCES music_albums(id) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS music_track_artists (
    track_id INTEGER NOT NULL,
    artist_id INTEGER NOT NULL,
    position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
    PRIMARY KEY (track_id, artist_id),
    UNIQUE (track_id, position),
    FOREIGN KEY (track_id) REFERENCES music_tracks(id) ON DELETE CASCADE,
    FOREIGN KEY (artist_id) REFERENCES music_artists(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS music_track_favorites (
    track_id INTEGER NOT NULL,
    profile_key TEXT NOT NULL DEFAULT 'default',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (track_id, profile_key),
    FOREIGN KEY (track_id) REFERENCES music_tracks(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS music_listening_history (
    track_id INTEGER NOT NULL,
    profile_key TEXT NOT NULL DEFAULT 'default',
    play_count INTEGER NOT NULL DEFAULT 0 CHECK (play_count >= 0),
    completed_count INTEGER NOT NULL DEFAULT 0 CHECK (completed_count >= 0),
    last_position_seconds REAL NOT NULL DEFAULT 0 CHECK (last_position_seconds >= 0),
    last_duration_seconds REAL NOT NULL DEFAULT 0 CHECK (last_duration_seconds >= 0),
    last_played_at TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (track_id, profile_key),
    FOREIGN KEY (track_id) REFERENCES music_tracks(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS music_playback_sessions (
    session_id TEXT PRIMARY KEY,
    track_id INTEGER NOT NULL,
    profile_key TEXT NOT NULL DEFAULT 'default',
    qualified INTEGER NOT NULL DEFAULT 0 CHECK (qualified IN (0, 1)),
    completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
    listened_seconds REAL NOT NULL DEFAULT 0 CHECK (listened_seconds >= 0),
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (track_id) REFERENCES music_tracks(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS music_playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_uuid TEXT NOT NULL UNIQUE,
    profile_key TEXT NOT NULL DEFAULT 'default',
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS music_playlist_tracks (
    playlist_id INTEGER NOT NULL,
    track_id INTEGER NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (playlist_id, track_id),
    UNIQUE (playlist_id, position),
    FOREIGN KEY (playlist_id) REFERENCES music_playlists(id) ON DELETE CASCADE,
    FOREIGN KEY (track_id) REFERENCES music_tracks(id) ON DELETE CASCADE
  );
`);

function ensureColumn(tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (!columns.some((column) => column.name === columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

ensureColumn('movies', 'media_type', "TEXT NOT NULL DEFAULT 'movie'");
ensureColumn('movies', 'series_title', 'TEXT');
ensureColumn('movies', 'season_number', 'INTEGER');
ensureColumn('movies', 'episode_number', 'INTEGER');
ensureColumn('movies', 'genres_json', "TEXT NOT NULL DEFAULT '[]'");
ensureColumn('movies', 'director', 'TEXT');
ensureColumn('movies', 'poster_path', 'TEXT');
ensureColumn('movies', 'metadata_auto_json', 'TEXT');
ensureColumn('movies', 'content_uuid', 'TEXT');
ensureColumn('movies', 'metadata_path', 'TEXT');
ensureColumn('movies', 'series_uuid', 'TEXT');
ensureColumn('movies', 'storage_version', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('movies', 'available', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('movies', 'last_seen_at', 'TEXT');
ensureColumn('movies', 'missing_since', 'TEXT');

ensurePairingSchema(db);
ensureAccountSchema(db);


function migrateVideoPathsToRelative() {
  const currentVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version || 0);
  if (currentVersion >= 11) return;

  const updateMoviePaths = db.prepare(`
    UPDATE movies SET
      file_path = ?,
      relative_path = ?,
      metadata_path = ?,
      poster_path = ?,
      metadata_auto_json = ?
    WHERE id = ?
  `);
  const updateSeriesPaths = db.prepare(`
    UPDATE series SET
      directory_path = ?,
      relative_path = ?,
      metadata_path = ?,
      poster_path = ?
    WHERE id = ?
  `);
  const updateOverridePoster = db.prepare(`
    UPDATE media_metadata_overrides SET poster_path = ? WHERE movie_id = ?
  `);

  db.exec('BEGIN IMMEDIATE');
  try {
    const movies = db.prepare(`
      SELECT id, relative_path, media_type, file_name, metadata_path, poster_path, metadata_auto_json
      FROM movies
    `).all();
    const movieRelativeById = new Map();

    for (const row of movies) {
      const relativePath = normalizeLibraryRelativePath(row.relative_path);
      const normalizedFileName = portableBasename(row.file_name)
        || portableBasename(relativePath);
      const episodeMetadataName = `${normalizedFileName.replace(/\.[^.]+$/, '')}.metadata.json`;
      const metadataPath = storedPathToRelative(row.metadata_path, {
        anchorRelativePath: relativePath,
        fallbackFileName: row.media_type === 'series' ? episodeMetadataName : 'metadata.json',
      });
      const posterPath = storedPathToRelative(row.poster_path, {
        anchorRelativePath: relativePath,
      });

      let metadataAutoJson = row.metadata_auto_json;
      if (metadataAutoJson) {
        try {
          const parsed = JSON.parse(metadataAutoJson);
          if (parsed?.automatic?.posterPath) {
            parsed.automatic.posterPath = storedPathToRelative(parsed.automatic.posterPath, {
              anchorRelativePath: relativePath,
            });
            metadataAutoJson = JSON.stringify(parsed);
          }
        } catch {
          // Conserviamo documenti automatici legacy non validi senza alterarne il contenuto.
        }
      }

      updateMoviePaths.run(
        relativePath,
        relativePath,
        metadataPath,
        posterPath,
        metadataAutoJson,
        row.id,
      );
      movieRelativeById.set(Number(row.id), relativePath);
    }

    const overrides = db.prepare(`
      SELECT movie_id AS movieId, poster_path AS posterPath
      FROM media_metadata_overrides
      WHERE COALESCE(poster_path, '') <> ''
    `).all();
    for (const row of overrides) {
      const anchorRelativePath = movieRelativeById.get(Number(row.movieId));
      if (!anchorRelativePath) continue;
      updateOverridePoster.run(storedPathToRelative(row.posterPath, {
        anchorRelativePath,
      }), row.movieId);
    }

    const seriesRows = db.prepare(`
      SELECT id, relative_path, metadata_path, poster_path
      FROM series
    `).all();
    for (const row of seriesRows) {
      const relativePath = normalizeLibraryRelativePath(row.relative_path);
      const metadataPath = storedPathToRelative(row.metadata_path, {
        anchorRelativePath: relativePath,
        anchorIsDirectory: true,
        fallbackFileName: 'metadata.json',
      });
      const posterPath = storedPathToRelative(row.poster_path, {
        anchorRelativePath: relativePath,
        anchorIsDirectory: true,
      });
      updateSeriesPaths.run(relativePath, relativePath, metadataPath, posterPath, row.id);
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw new Error(`Migrazione dei percorsi Film/Serie non riuscita: ${error.message}`);
  }
}

migrateVideoPathsToRelative();

function createPortableReadingItemsTable(tableName) {
  db.exec(`
    CREATE TABLE ${tableName} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_uuid TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL CHECK (category IN ('books', 'comics', 'manga')),
      file_path TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      title TEXT NOT NULL,
      year INTEGER,
      author TEXT NOT NULL DEFAULT '',
      genres_json TEXT NOT NULL DEFAULT '[]',
      extension TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      modified_at INTEGER NOT NULL,
      cover_path TEXT,
      metadata_path TEXT NOT NULL,
      storage_version INTEGER NOT NULL DEFAULT 1,
      available INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0, 1)),
      last_seen_at TEXT,
      missing_since TEXT,
      added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

function migrateReadingPathsToRelative() {
  const currentVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version || 0);
  if (currentVersion >= 12 || !tableExists('reading_items')) return;

  const rows = db.prepare('SELECT * FROM reading_items ORDER BY id').all();
  if (!rows.length) return;

  const now = new Date().toISOString();
  const portableRows = rows.map((row) => {
    const relativePath = readingRelativePath(row);
    const metadataPath = readingMetadataRelativePath(row);
    const coverPath = readingCoverRelativePath(row);
    let stats = null;
    try {
      const candidate = readingFilePath({ ...row, relative_path: relativePath });
      const candidateStats = fs.statSync(candidate);
      if (candidateStats.isFile()) stats = candidateStats;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error;
    }
    const isAvailable = Boolean(stats);
    const availabilityChanged = Number(row.available) !== (isAvailable ? 1 : 0);
    return {
      ...row,
      file_path: relativePath,
      relative_path: relativePath,
      file_name: portableBasename(row.file_name) || portableBasename(relativePath),
      cover_path: coverPath,
      metadata_path: metadataPath,
      available: isAvailable ? 1 : 0,
      size_bytes: stats ? Number(stats.size || 0) : Number(row.size_bytes || 0),
      modified_at: stats ? Math.trunc(stats.mtimeMs) : Number(row.modified_at || 0),
      last_seen_at: stats ? now : row.last_seen_at,
      missing_since: stats ? null : (row.missing_since || now),
      updated_at: availabilityChanged ? now : row.updated_at,
    };
  });

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DROP TABLE IF EXISTS reading_items_portable');
    createPortableReadingItemsTable('reading_items_portable');
    const insert = db.prepare(`
      INSERT INTO reading_items_portable (
        id, content_uuid, category, file_path, relative_path, file_name,
        title, year, author, genres_json, extension, mime_type,
        size_bytes, modified_at, cover_path, metadata_path, storage_version,
        available, last_seen_at, missing_since, added_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);
    for (const row of portableRows) {
      insert.run(
        row.id, row.content_uuid, row.category, row.file_path, row.relative_path, row.file_name,
        row.title, row.year, row.author, row.genres_json, row.extension, row.mime_type,
        row.size_bytes, row.modified_at, row.cover_path, row.metadata_path, row.storage_version,
        row.available, row.last_seen_at, row.missing_since, row.added_at, row.updated_at,
      );
    }
    db.exec('DROP TABLE reading_items');
    db.exec('ALTER TABLE reading_items_portable RENAME TO reading_items');
    const maximumId = Number(db.prepare('SELECT COALESCE(MAX(id), 0) AS maximumId FROM reading_items').get()?.maximumId || 0);
    db.prepare("DELETE FROM sqlite_sequence WHERE name = 'reading_items'").run();
    if (maximumId > 0) {
      db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('reading_items', ?)").run(maximumId);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    db.exec('PRAGMA foreign_keys = ON');
    throw new Error(`Migrazione dei percorsi Libri/Fumetti/Manga non riuscita: ${error.message}`);
  }
  db.exec('PRAGMA foreign_keys = ON');
  const foreignKeyProblems = db.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeyProblems.length) {
    throw new Error('Migrazione dei percorsi Libri/Fumetti/Manga non riuscita: vincoli SQLite non validi.');
  }
}

migrateReadingPathsToRelative();

function timestampValue(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function migrateReadingDuplicates() {
  const currentVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version || 0);
  if (currentVersion >= 13 || !tableExists('reading_items')) return;

  const duplicateGroups = db.prepare(`
    SELECT relative_path AS relativePath, COUNT(*) AS itemCount
    FROM reading_items
    WHERE COALESCE(relative_path, '') <> ''
    GROUP BY relative_path COLLATE NOCASE
    HAVING COUNT(*) > 1
  `).all();
  if (!duplicateGroups.length) return;

  const getItems = db.prepare(`
    SELECT * FROM reading_items
    WHERE relative_path = ? COLLATE NOCASE
    ORDER BY id ASC
  `);
  const getBookmarks = db.prepare(`
    SELECT reading_item_id AS readingItemId, profile_key AS profileKey,
      locator_json AS locatorJson, updated_at AS updatedAt
    FROM reading_bookmarks
    WHERE reading_item_id = ?
  `);
  const upsertBookmark = db.prepare(`
    INSERT INTO reading_bookmarks (reading_item_id, profile_key, locator_json, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(reading_item_id, profile_key) DO UPDATE SET
      locator_json = excluded.locator_json,
      updated_at = excluded.updated_at
    WHERE excluded.updated_at > reading_bookmarks.updated_at
  `);
  const deleteBookmarks = db.prepare('DELETE FROM reading_bookmarks WHERE reading_item_id = ?');
  const deleteItem = db.prepare('DELETE FROM reading_items WHERE id = ?');
  const updateSurvivorDates = db.prepare(`
    UPDATE reading_items SET added_at = ?, updated_at = ? WHERE id = ?
  `);

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const group of duplicateGroups) {
      const items = getItems.all(group.relativePath);
      const bookmarksByItem = new Map();
      for (const item of items) {
        const bookmarks = getBookmarks.all(item.id);
        bookmarksByItem.set(item.id, bookmarks);
      }

      items.sort((left, right) => {
        const leftLatestBookmark = Math.max(0, ...bookmarksByItem.get(left.id).map((row) => timestampValue(row.updatedAt)));
        const rightLatestBookmark = Math.max(0, ...bookmarksByItem.get(right.id).map((row) => timestampValue(row.updatedAt)));
        return Number(right.available || 0) - Number(left.available || 0)
          || rightLatestBookmark - leftLatestBookmark
          || timestampValue(right.updated_at) - timestampValue(left.updated_at)
          || timestampValue(right.last_seen_at) - timestampValue(left.last_seen_at)
          || Number(right.id) - Number(left.id);
      });

      const survivor = items[0];
      const losingItems = items.slice(1);
      const latestBookmarkByProfile = new Map();
      for (const item of items) {
        for (const bookmark of bookmarksByItem.get(item.id)) {
          const current = latestBookmarkByProfile.get(bookmark.profileKey);
          if (!current || timestampValue(bookmark.updatedAt) > timestampValue(current.updatedAt)) {
            latestBookmarkByProfile.set(bookmark.profileKey, bookmark);
          }
        }
      }

      for (const bookmark of latestBookmarkByProfile.values()) {
        upsertBookmark.run(survivor.id, bookmark.profileKey, bookmark.locatorJson, bookmark.updatedAt);
      }
      for (const item of losingItems) {
        deleteBookmarks.run(item.id);
        deleteItem.run(item.id);
      }

      const earliestAddedAt = items
        .map((item) => item.added_at)
        .filter(Boolean)
        .sort()[0] || survivor.added_at;
      const latestUpdatedAt = items
        .map((item) => item.updated_at)
        .filter(Boolean)
        .sort()
        .at(-1) || survivor.updated_at;
      updateSurvivorDates.run(earliestAddedAt, latestUpdatedAt, survivor.id);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw new Error(`Deduplicazione di Libri/Fumetti/Manga non riuscita: ${error.message}`);
  }
}

migrateReadingDuplicates();

function migrateMusicPathsToRelative() {
  const currentVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version || 0);
  if (currentVersion >= 14 || !tableExists('music_tracks') || !tableExists('music_albums')) return;

  const albums = db.prepare('SELECT * FROM music_albums ORDER BY id').all();
  const tracks = db.prepare('SELECT * FROM music_tracks ORDER BY id').all();
  const albumRelativeById = new Map();
  const trackRelativeById = new Map();

  for (const album of albums) albumRelativeById.set(Number(album.id), musicAlbumRelativePath(album));
  for (const track of tracks) trackRelativeById.set(Number(track.id), musicTrackRelativePath(track));

  const trackGroups = new Map();
  for (const track of tracks) {
    const relativePath = trackRelativeById.get(Number(track.id));
    const key = relativePath.normalize('NFC').toLocaleLowerCase('it');
    if (!trackGroups.has(key)) trackGroups.set(key, []);
    trackGroups.get(key).push(track);
  }

  const albumGroups = new Map();
  for (const album of albums) {
    const relativePath = albumRelativeById.get(Number(album.id));
    const key = relativePath.normalize('NFC').toLocaleLowerCase('it');
    if (!albumGroups.has(key)) albumGroups.set(key, []);
    albumGroups.get(key).push(album);
  }

  const insertFavorite = db.prepare(`
    INSERT OR IGNORE INTO music_track_favorites (track_id, profile_key, created_at)
    SELECT ?, profile_key, created_at FROM music_track_favorites WHERE track_id = ?
  `);
  const getHistory = db.prepare(`
    SELECT profile_key AS profileKey, play_count AS playCount,
      completed_count AS completedCount, last_position_seconds AS lastPositionSeconds,
      last_duration_seconds AS lastDurationSeconds, last_played_at AS lastPlayedAt,
      updated_at AS updatedAt
    FROM music_listening_history WHERE track_id = ?
  `);
  const upsertHistory = db.prepare(`
    INSERT INTO music_listening_history (
      track_id, profile_key, play_count, completed_count,
      last_position_seconds, last_duration_seconds, last_played_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(track_id, profile_key) DO UPDATE SET
      play_count = MAX(music_listening_history.play_count, excluded.play_count),
      completed_count = MAX(music_listening_history.completed_count, excluded.completed_count),
      last_position_seconds = CASE
        WHEN excluded.updated_at >= music_listening_history.updated_at
        THEN excluded.last_position_seconds ELSE music_listening_history.last_position_seconds END,
      last_duration_seconds = CASE
        WHEN excluded.updated_at >= music_listening_history.updated_at
        THEN excluded.last_duration_seconds ELSE music_listening_history.last_duration_seconds END,
      last_played_at = CASE
        WHEN COALESCE(excluded.last_played_at, '') >= COALESCE(music_listening_history.last_played_at, '')
        THEN excluded.last_played_at ELSE music_listening_history.last_played_at END,
      updated_at = MAX(music_listening_history.updated_at, excluded.updated_at)
  `);
  const deleteHistory = db.prepare('DELETE FROM music_listening_history WHERE track_id = ?');
  const deletePlaylistDuplicate = db.prepare(`
    DELETE FROM music_playlist_tracks
    WHERE track_id = ? AND playlist_id IN (
      SELECT playlist_id FROM music_playlist_tracks WHERE track_id = ?
    )
  `);
  const reassignPlaylist = db.prepare('UPDATE music_playlist_tracks SET track_id = ? WHERE track_id = ?');
  const reassignSessions = db.prepare('UPDATE music_playback_sessions SET track_id = ? WHERE track_id = ?');
  const deleteTrack = db.prepare('DELETE FROM music_tracks WHERE id = ?');
  const updateTrackPath = db.prepare(`
    UPDATE music_tracks SET file_path = ?, relative_path = ? WHERE id = ?
  `);
  const countAlbumTracks = db.prepare('SELECT COUNT(*) AS count FROM music_tracks WHERE album_id = ?');
  const listAlbumArtists = db.prepare(`
    SELECT artist_id AS artistId FROM music_album_artists
    WHERE album_id = ? ORDER BY position
  `);
  const hasAlbumArtist = db.prepare(`
    SELECT 1 FROM music_album_artists WHERE album_id = ? AND artist_id = ? LIMIT 1
  `);
  const nextAlbumArtistPosition = db.prepare(`
    SELECT COALESCE(MAX(position), -1) + 1 AS nextPosition
    FROM music_album_artists WHERE album_id = ?
  `);
  const insertAlbumArtist = db.prepare(`
    INSERT INTO music_album_artists (album_id, artist_id, position) VALUES (?, ?, ?)
  `);
  const reassignAlbumTracks = db.prepare('UPDATE music_tracks SET album_id = ? WHERE album_id = ?');
  const deleteAlbum = db.prepare('DELETE FROM music_albums WHERE id = ?');
  const updateAlbumPath = db.prepare(`
    UPDATE music_albums SET directory_path = ?, relative_path = ?, cover_cache_path = NULL WHERE id = ?
  `);

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const group of trackGroups.values()) {
      group.sort((left, right) => Number(right.available || 0) - Number(left.available || 0)
        || timestampValue(right.updated_at) - timestampValue(left.updated_at)
        || Number(right.id) - Number(left.id));
      const survivor = group[0];
      const relativePath = trackRelativeById.get(Number(survivor.id));

      for (const loser of group.slice(1)) {
        insertFavorite.run(survivor.id, loser.id);
        for (const history of getHistory.all(loser.id)) {
          upsertHistory.run(
            survivor.id, history.profileKey, history.playCount, history.completedCount,
            history.lastPositionSeconds, history.lastDurationSeconds,
            history.lastPlayedAt, history.updatedAt,
          );
        }
        deleteHistory.run(loser.id);
        deletePlaylistDuplicate.run(loser.id, survivor.id);
        reassignPlaylist.run(survivor.id, loser.id);
        reassignSessions.run(survivor.id, loser.id);
        deleteTrack.run(loser.id);
      }
      updateTrackPath.run(relativePath, relativePath, survivor.id);
    }

    for (const group of albumGroups.values()) {
      group.sort((left, right) => Number(countAlbumTracks.get(right.id)?.count || 0)
        - Number(countAlbumTracks.get(left.id)?.count || 0)
        || timestampValue(right.updated_at) - timestampValue(left.updated_at)
        || Number(right.id) - Number(left.id));
      const survivor = group[0];
      const relativePath = albumRelativeById.get(Number(survivor.id));

      for (const loser of group.slice(1)) {
        for (const relation of listAlbumArtists.all(loser.id)) {
          if (hasAlbumArtist.get(survivor.id, relation.artistId)) continue;
          const position = Number(nextAlbumArtistPosition.get(survivor.id)?.nextPosition || 0);
          insertAlbumArtist.run(survivor.id, relation.artistId, position);
        }
        reassignAlbumTracks.run(survivor.id, loser.id);
        deleteAlbum.run(loser.id);
      }
      updateAlbumPath.run(relativePath, relativePath, survivor.id);
    }

    db.exec(`
      UPDATE music_albums SET cover_cache_path = NULL;
      DELETE FROM music_artists
      WHERE NOT EXISTS (SELECT 1 FROM music_album_artists aa WHERE aa.artist_id = music_artists.id)
        AND NOT EXISTS (SELECT 1 FROM music_track_artists ta WHERE ta.artist_id = music_artists.id);
    `);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw new Error(`Migrazione dei percorsi Musica non riuscita: ${error.message}`);
  }
}

migrateMusicPathsToRelative();

function migrateLegacyAccounts() {
  const currentVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version || 0);
  if (currentVersion >= 15) return;
  migrateLegacyProfilesToAccounts(db, { defaultDisplayName: config.profileName });
}

migrateLegacyAccounts();

function migrateDeviceOnlyPairing() {
  const currentVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version || 0);
  if (currentVersion >= 16) return;
  migratePairingSchemaToDeviceOnly(db);
}

migrateDeviceOnlyPairing();

function migrateDeletedUsernames() {
  const currentVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version || 0);
  if (currentVersion >= 17) return;
  migrateDeletedAccountUsernames(db);
}

migrateDeletedUsernames();

function migrateAccountUsernames() {
  const currentVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version || 0);
  if (currentVersion >= 18) return;
  migrateAccountNamesToUsername(db);
}

migrateAccountUsernames();

function migrateRevocablePairingInvites() {
  const currentVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version || 0);
  if (currentVersion >= 19) return;
  migratePairingInvitesToRevocable(db);
}

migrateRevocablePairingInvites();

db.exec(`
  DROP INDEX IF EXISTS idx_movies_metadata_status;
  DROP TABLE IF EXISTS library_scans;

  UPDATE movies SET available = 1 WHERE available IS NULL;

  CREATE INDEX IF NOT EXISTS idx_movies_title ON movies(title COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_movies_file_name ON movies(file_name COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_movies_added_at ON movies(added_at DESC);
  CREATE INDEX IF NOT EXISTS idx_movies_media_type ON movies(media_type);
  CREATE INDEX IF NOT EXISTS idx_movies_year ON movies(year);
  CREATE INDEX IF NOT EXISTS idx_movies_series ON movies(series_title COLLATE NOCASE, season_number, episode_number);
  CREATE INDEX IF NOT EXISTS idx_movies_available ON movies(available);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_movies_content_uuid ON movies(content_uuid);
  CREATE INDEX IF NOT EXISTS idx_movies_series_uuid ON movies(series_uuid, season_number, episode_number);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_series_uuid ON series(series_uuid);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_series_directory_path ON series(directory_path);
  CREATE INDEX IF NOT EXISTS idx_series_title ON series(title COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_series_available ON series(available);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_reading_content_uuid ON reading_items(content_uuid);
  CREATE INDEX IF NOT EXISTS idx_reading_file_path ON reading_items(file_path COLLATE NOCASE);
  DROP INDEX IF EXISTS idx_reading_relative_path;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_reading_relative_path ON reading_items(relative_path COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_reading_category_title ON reading_items(category, title COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_reading_category_added ON reading_items(category, added_at DESC);
  CREATE INDEX IF NOT EXISTS idx_reading_available ON reading_items(available);
  CREATE INDEX IF NOT EXISTS idx_reading_bookmarks_profile_updated ON reading_bookmarks(profile_key, updated_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_music_artists_uuid ON music_artists(artist_uuid);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_music_artists_name ON music_artists(name COLLATE NOCASE);
  DROP INDEX IF EXISTS idx_music_albums_directory;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_music_albums_directory ON music_albums(directory_path COLLATE NOCASE);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_music_albums_relative_path ON music_albums(relative_path COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_music_albums_title ON music_albums(title COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_music_albums_year ON music_albums(year);
  CREATE INDEX IF NOT EXISTS idx_music_album_artists_artist ON music_album_artists(artist_id, album_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_music_tracks_uuid ON music_tracks(track_uuid);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_music_tracks_relative_path ON music_tracks(relative_path COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_music_tracks_album_order ON music_tracks(album_id, disc_number, track_number, title COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_music_tracks_title ON music_tracks(title COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_music_tracks_available ON music_tracks(available);
  CREATE INDEX IF NOT EXISTS idx_music_tracks_added ON music_tracks(added_at DESC);
  CREATE INDEX IF NOT EXISTS idx_music_track_artists_artist ON music_track_artists(artist_id, track_id);
  CREATE INDEX IF NOT EXISTS idx_music_favorites_profile_added ON music_track_favorites(profile_key, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_music_history_profile_played ON music_listening_history(profile_key, last_played_at DESC);
  CREATE INDEX IF NOT EXISTS idx_music_playback_sessions_profile_updated ON music_playback_sessions(profile_key, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_music_playback_sessions_track ON music_playback_sessions(track_id, updated_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_music_playlists_profile_name
    ON music_playlists(profile_key, name COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_music_playlists_profile_updated
    ON music_playlists(profile_key, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_music_playlist_tracks_order
    ON music_playlist_tracks(playlist_id, position);
  CREATE INDEX IF NOT EXISTS idx_music_playlist_tracks_track
    ON music_playlist_tracks(track_id, playlist_id);
  PRAGMA user_version = ${TARGET_SCHEMA_VERSION};
`);

module.exports = db;
