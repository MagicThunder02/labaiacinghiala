const path = require('node:path');
const fs = require('node:fs');
const dotenv = require('dotenv');

dotenv.config({ quiet: true });

const PROJECT_ROOT = path.resolve(__dirname, '..');
const NODE_LOOPBACK_HOST = '127.0.0.1';

function resolveProjectPath(value, fallback) {
  const selected = value && value.trim() ? value.trim() : fallback;
  return path.isAbsolute(selected)
    ? path.normalize(selected)
    : path.resolve(PROJECT_ROOT, selected);
}

function ensureLocalDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

const libraryPathWasExplicitlyConfigured = Boolean(process.env.LIBRARY_PATH?.trim());
const libraryPath = resolveProjectPath(process.env.LIBRARY_PATH, './media');

const mediaPaths = Object.freeze({
  movies: path.join(libraryPath, 'Film'),
  series: path.join(libraryPath, 'Serie'),
  music: path.join(libraryPath, 'Musica'),
  books: path.join(libraryPath, 'Libri'),
  comics: path.join(libraryPath, 'Fumetti'),
  manga: path.join(libraryPath, 'Manga'),
});

const configuredHost = process.env.HOST?.trim() || NODE_LOOPBACK_HOST;

if (configuredHost !== NODE_LOOPBACK_HOST) {
  throw new Error(`HOST deve essere ${NODE_LOOPBACK_HOST}: Node non puo essere esposto su LAN o Internet.`);
}

const config = {
  projectRoot: PROJECT_ROOT,
  host: configuredHost,
  port: Number.parseInt(process.env.PORT || '3000', 10),
  libraryPath,
  mediaPaths,
  libraryIdentityPath: path.join(libraryPath, '.baia-library.json'),
  databasePath: resolveProjectPath(process.env.DATABASE_PATH, './data/media.sqlite'),
  databaseBackupsPath: resolveProjectPath(process.env.DATABASE_BACKUPS_PATH, './data/backups'),
  databaseDailyBackupRetention: Math.min(
    Math.max(Number.parseInt(process.env.DATABASE_DAILY_BACKUP_RETENTION || '50', 10) || 50, 1),
    365,
  ),
  databaseMonthlyBackupRetention: Math.min(
    Math.max(Number.parseInt(process.env.DATABASE_MONTHLY_BACKUP_RETENTION || '12', 10) || 12, 1),
    120,
  ),
  metadataPosterCachePath: resolveProjectPath(process.env.METADATA_POSTER_CACHE_PATH, './data/cache/posters'),
  musicCoverCachePath: resolveProjectPath(process.env.MUSIC_COVER_CACHE_PATH, './data/cache/music-covers'),
  // Percorso usato dalle versioni precedenti: viene mantenuto per importare le vecchie copertine.
  metadataPostersPath: resolveProjectPath(process.env.METADATA_POSTERS_PATH, './data/metadata-posters'),
  uploadTempPath: resolveProjectPath(process.env.UPLOAD_TEMP_PATH, path.join(libraryPath, '.uploads')),
  uploadMaxVideoBytes: Math.min(
    Math.max(Number.parseFloat(process.env.UPLOAD_MAX_VIDEO_GB || '100') || 100, 1),
    500,
  ) * 1024 * 1024 * 1024,
  // Verifica solo l'esistenza dei percorsi già registrati in SQLite; non scopre nuovi contenuti.
  verifyLibraryOnStart: String(
    process.env.VERIFY_LIBRARY_ON_START ?? process.env.AUTO_SCAN ?? 'true',
  ).toLowerCase() !== 'false',
  appDisplayName: process.env.APP_DISPLAY_NAME?.trim() || 'Baia Cinghiala',
  appUiVersion: process.env.APP_UI_VERSION?.trim() || '2.0',
  profileName: process.env.PROFILE_NAME?.trim() || 'Peru',
  storageInitializationError: null,
};

if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
  throw new Error('PORT deve essere un numero compreso tra 1 e 65535.');
}

ensureLocalDirectory(path.dirname(config.databasePath));
ensureLocalDirectory(config.databaseBackupsPath);
ensureLocalDirectory(config.metadataPosterCachePath);
ensureLocalDirectory(config.musicCoverCachePath);
ensureLocalDirectory(config.metadataPostersPath);

// La libreria locale predefinita può essere creata al primo avvio. Se LIBRARY_PATH è
// configurato esplicitamente (RAID/NAS), non lo creiamo: la raggiungibilità viene
// verificata prima di avviare il server, evitando di mascherare un volume non montato.
if (!libraryPathWasExplicitlyConfigured) ensureLocalDirectory(config.libraryPath);

module.exports = config;
