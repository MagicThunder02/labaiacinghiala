const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { constants } = require('node:fs');
const config = require('../config');
const { assertRealPathInsideLibrary } = require('./library-path-service');

function errorMessage(error) {
  return String(error?.message || error || 'Errore sconosciuto.');
}

async function probeWritable(directory) {
  const probePath = path.join(directory, `.baia-storage-probe-${process.pid}-${crypto.randomUUID()}`);
  let handle = null;
  try {
    handle = await fs.open(probePath, 'wx');
    await handle.writeFile('ok');
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(probePath, { force: true }).catch(() => {});
  }
}

async function checkLibraryStorage({ prepareManagedDirectories = false } = {}) {
  try {
    const rootStats = await fs.stat(config.libraryPath);
    if (!rootStats.isDirectory()) throw new Error(`LIBRARY_PATH non è una cartella: ${config.libraryPath}`);

    await fs.access(config.libraryPath, constants.R_OK | constants.W_OK);
    await fs.readdir(config.libraryPath);
    await probeWritable(config.libraryPath);

    if (prepareManagedDirectories) {
      for (const directory of Object.values(config.mediaPaths)) {
        await fs.mkdir(directory, { recursive: true });
        const stats = await fs.stat(directory);
        if (!stats.isDirectory()) throw new Error(`Percorso archivio non valido: ${directory}`);
        await fs.access(directory, constants.R_OK | constants.W_OK);
        await assertRealPathInsideLibrary(directory, { libraryRoot: config.libraryPath });
      }

      await fs.mkdir(config.uploadTempPath, { recursive: true });
      const uploadStats = await fs.stat(config.uploadTempPath);
      if (!uploadStats.isDirectory()) throw new Error(`Percorso upload non valido: ${config.uploadTempPath}`);
      await fs.access(config.uploadTempPath, constants.R_OK | constants.W_OK);
    }

    config.storageInitializationError = null;
    return { available: true, error: null };
  } catch (error) {
    const message = errorMessage(error);
    config.storageInitializationError = message;
    return { available: false, error: message };
  }
}

async function initializeLibraryStorage() {
  return checkLibraryStorage({ prepareManagedDirectories: true });
}

module.exports = {
  checkLibraryStorage,
  initializeLibraryStorage,
};
