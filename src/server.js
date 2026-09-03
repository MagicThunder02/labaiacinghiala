const path = require('node:path');
const express = require('express');
const config = require('./config');
const db = require('./database');
const { reconcileLibraryAvailability } = require('./services/library-reconciliation-service');
const appInfoRouter = require('./routes/app-info');
const moviesRouter = require('./routes/movies');
const seriesRouter = require('./routes/series');
const readingRouter = require('./routes/reading');
const musicRouter = require('./routes/music');
const libraryRouter = require('./routes/library');
const userStateRouter = require('./routes/user-state');
const musicMetadataRouter = require('./routes/music-metadata');
const metadataEditorRouter = require('./routes/metadata-editor');
const contentUploadRouter = require('./routes/content-upload');
const pairingRouter = require('./routes/pairing');
const { createAuthRouter } = require('./routes/auth');
const { createAdminAccountsRouter } = require('./routes/admin-accounts');
const { createAdminPairingInvitesRouter } = require('./routes/admin-pairing-invites');
const { createAdminPairedDevicesRouter } = require('./routes/admin-paired-devices');
const { scheduleDailyBackups } = require('./services/database-backup-service');
const { initializeLibraryStorage } = require('./services/library-storage-service');
const { ensureLibraryIdentity } = require('./services/library-identity-service');
const { apiCors } = require('./middleware/api-cors');
const { deviceAuth } = require('./middleware/device-auth');
const { apiErrorHandler } = require('./middleware/api-error-handler');
const { createAccountAuth } = require('./middleware/account-auth');
const {
  createMovieAccess,
  createReadingAccess,
  requirePasswordChangeCompleted,
  requireAdmin,
  requireLocalAdminBrowser,
  requireSection,
} = require('./middleware/account-access');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', false);
app.use('/api', apiCors);
app.use(express.json({ limit: '9mb' }));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, name: config.appDisplayName });
});

// Il redeem del pairing deve restare raggiungibile prima che il dispositivo
// possieda credenziali registrate. Tutte le altre API passano dal controllo device.
app.use('/api/pairing', pairingRouter);
app.use('/api', deviceAuth);
app.use('/api/auth', createAuthRouter({ database: db }));

// App-info resta disponibile a un dispositivo verificato prima del login.
app.use('/api/app-info', appInfoRouter);
app.use('/api', createAccountAuth({ database: db }));
app.use('/api', requirePasswordChangeCompleted);
app.use('/api/movies', createMovieAccess({ database: db }), moviesRouter, userStateRouter);
app.use('/api/series', requireSection('series'), seriesRouter);
app.use('/api/reading', createReadingAccess({ database: db }), readingRouter);
app.use('/api/music', requireSection('music'), musicRouter);
app.use('/api/admin/pairing-invites', requireLocalAdminBrowser, createAdminPairingInvitesRouter({ database: db }));
app.use('/api/admin/paired-devices', requireLocalAdminBrowser, createAdminPairedDevicesRouter({ database: db }));
app.use('/api/admin/accounts', requireAdmin, createAdminAccountsRouter({ database: db }));
app.use('/api/library', requireAdmin, libraryRouter);
app.use('/api/metadata/music', requireAdmin, musicMetadataRouter);
app.use('/api/metadata', requireAdmin, metadataEditorRouter);
app.use('/api/uploads', requireAdmin, contentUploadRouter);
app.use(express.static(path.join(config.projectRoot, 'public')));

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Endpoint non trovato.' });
});

app.use(apiErrorHandler);

let server = null;

async function startServer() {
  const storage = await initializeLibraryStorage();
  const libraryIdentity = storage.available
    ? await ensureLibraryIdentity({ database: db, libraryRoot: config.libraryPath })
    : null;

  server = app.listen(config.port, config.host, async () => {
    console.log(`${config.appDisplayName} attivo su http://localhost:${config.port}`);
    console.log(`Libreria: ${config.libraryPath}`);
    console.log(`Database: ${config.databasePath}`);
    if (libraryIdentity) {
      console.log(`Identità libreria: ${libraryIdentity.libraryId}${libraryIdentity.initialized ? ' (inizializzata)' : ''}`);
    }

    if (!storage.available) {
      console.warn('Archivio non raggiungibile: il catalogo resta conservato e nessun record verrà marcato offline.');
      console.warn(storage.error);
    } else {
      console.log('Archivio raggiungibile e scrivibile.');
    }

    scheduleDailyBackups();

    if (config.verifyLibraryOnStart && storage.available) {
      try {
        const result = await reconcileLibraryAvailability();
        if (result.storageAvailable) {
          console.log(`Verifica libreria completata: ${result.checked} record controllati, ${result.unavailable} nuovi non disponibili, ${result.restored} ripristinati.`);
        }
      } catch (error) {
        console.error('Verifica iniziale della libreria non riuscita:', error);
      }
    }
  });
}

startServer().catch((error) => {
  console.error('Avvio del server non riuscito:', error);
  try { db.close(); } catch {}
  process.exit(1);
});

function shutdown(signal) {
  console.log(`\nRicevuto ${signal}. Arresto del server...`);
  if (!server) {
    try { db.close(); } catch {}
    process.exit(0);
    return;
  }
  server.close(() => {
    try { db.close(); } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
