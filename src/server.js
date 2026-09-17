'use strict';

const { createApp } = require('./app');
const { configureHttpTimeouts } = require('./http-timeouts');

function listen(app, config) {
  return new Promise((resolve, reject) => {
    const server = app.listen(config.port, config.host, () => resolve(server));
    server.once('error', reject);
  });
}

async function startServer(dependencies = {}) {
  const config = dependencies.config || require('./config');
  const db = dependencies.database || require('./database');
  const initializeLibraryStorage = dependencies.initializeLibraryStorage
    || require('./services/library-storage-service').initializeLibraryStorage;
  const ensureLibraryIdentity = dependencies.ensureLibraryIdentity
    || require('./services/library-identity-service').ensureLibraryIdentity;
  const reconcileLibraryAvailability = dependencies.reconcileLibraryAvailability
    || require('./services/library-reconciliation-service').reconcileLibraryAvailability;
  const scheduleDailyBackups = dependencies.scheduleDailyBackups
    || require('./services/database-backup-service').scheduleDailyBackups;
  const logger = dependencies.logger || console;

  const storage = await initializeLibraryStorage();
  const libraryIdentity = storage.available
    ? await ensureLibraryIdentity({ database: db, libraryRoot: config.libraryPath })
    : null;
  const app = dependencies.app || createApp({
    database: db,
    config,
    routers: dependencies.routers,
    staticRoot: dependencies.staticRoot,
    deviceAuth: dependencies.deviceAuth,
  });
  const server = await listen(app, config);
  configureHttpTimeouts(server, dependencies.httpTimeouts);

  logger.log(`${config.appDisplayName} attivo su http://${config.host}:${config.port}`);
  logger.log(`Libreria: ${config.libraryPath}`);
  logger.log(`Database: ${config.databasePath}`);
  if (libraryIdentity) {
    logger.log(`Identità libreria: ${libraryIdentity.libraryId}${libraryIdentity.initialized ? ' (inizializzata)' : ''}`);
  }

  if (!storage.available) {
    logger.warn('Archivio non raggiungibile: il catalogo resta conservato e nessun record verrà marcato offline.');
    logger.warn(storage.error);
  } else {
    logger.log('Archivio raggiungibile e scrivibile.');
  }

  scheduleDailyBackups();
  if (config.verifyLibraryOnStart && storage.available) {
    try {
      const result = await reconcileLibraryAvailability();
      if (result.storageAvailable) {
        logger.log(`Verifica libreria completata: ${result.checked} record controllati, ${result.unavailable} nuovi non disponibili, ${result.restored} ripristinati.`);
      }
    } catch (error) {
      logger.error('Verifica iniziale della libreria non riuscita:', error);
    }
  }

  return { app, server, database: db, config, storage, libraryIdentity };
}

function closeServer(server, database, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { database.close(); } catch {}
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      server.closeAllConnections?.();
      finish(new Error('Timeout durante l\'arresto del server.'));
    }, timeoutMs);
    timer.unref?.();
    server.close(finish);
  });
}

async function bootstrap() {
  let runtime;
  try {
    runtime = await startServer();
  } catch (error) {
    console.error('Avvio del server non riuscito:', error);
    try { require('./database').close(); } catch {}
    process.exitCode = 1;
    return;
  }

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nRicevuto ${signal}. Arresto del server...`);
    try {
      await closeServer(runtime.server, runtime.database);
      process.exitCode = 0;
    } catch (error) {
      console.error('Arresto del server non riuscito:', error);
      process.exitCode = 1;
    }
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

if (require.main === module) {
  bootstrap().catch((error) => {
    console.error('Avvio del server non riuscito:', error);
    process.exitCode = 1;
  });
}

module.exports = { bootstrap, closeServer, startServer };
