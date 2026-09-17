'use strict';

const path = require('node:path');
const express = require('express');
const { apiCors } = require('./middleware/api-cors');
const { createDeviceAuth } = require('./middleware/device-auth');
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
const { createAuthRouter } = require('./routes/auth');
const { createPairingRouter } = require('./routes/pairing');
const { createAppInfoRouter } = require('./routes/app-info');
const { createAdminAccountsRouter } = require('./routes/admin-accounts');
const { createAdminPairingInvitesRouter } = require('./routes/admin-pairing-invites');
const { createAdminPairedDevicesRouter } = require('./routes/admin-paired-devices');

function loadLegacyRouters() {
  return {
    movies: require('./routes/movies'),
    series: require('./routes/series'),
    reading: require('./routes/reading'),
    music: require('./routes/music'),
    library: require('./routes/library'),
    userState: require('./routes/user-state'),
    musicMetadata: require('./routes/music-metadata'),
    metadataEditor: require('./routes/metadata-editor'),
    contentUpload: require('./routes/content-upload'),
  };
}

function createDefaultRouters({ database, config }) {
  return {
    ...loadLegacyRouters(),
    pairing: createPairingRouter({ database }),
    auth: createAuthRouter({ database }),
    appInfo: createAppInfoRouter({ config }),
    adminAccounts: createAdminAccountsRouter({ database }),
    adminPairingInvites: createAdminPairingInvitesRouter({ database }),
    adminPairedDevices: createAdminPairedDevicesRouter({ database }),
  };
}

/**
 * Costruisce Express senza aprire socket o registrare signal handler.
 * Database, configurazione, router e directory statica sono sostituibili nei test.
 */
function createApp({ database, config, routers, staticRoot, deviceAuth } = {}) {
  const selectedConfig = config || require('./config');
  const selectedDatabase = database || require('./database');
  const selectedRouters = routers || createDefaultRouters({
    database: selectedDatabase,
    config: selectedConfig,
  });
  const authenticateDevice = deviceAuth || createDeviceAuth({ database: selectedDatabase });
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use('/api', apiCors);
  app.use(express.json({ limit: '9mb' }));

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, name: selectedConfig.appDisplayName });
  });

  // Il redeem del pairing resta raggiungibile prima delle credenziali device.
  app.use('/api/pairing', selectedRouters.pairing);
  app.use('/api', authenticateDevice);
  app.use('/api/auth', selectedRouters.auth);

  // App-info resta disponibile a un dispositivo verificato prima del login.
  app.use('/api/app-info', selectedRouters.appInfo);
  app.use('/api', createAccountAuth({ database: selectedDatabase }));
  app.use('/api', requirePasswordChangeCompleted);
  app.use('/api/movies', createMovieAccess({ database: selectedDatabase }), selectedRouters.movies, selectedRouters.userState);
  app.use('/api/series', requireSection('series'), selectedRouters.series);
  app.use('/api/reading', createReadingAccess({ database: selectedDatabase }), selectedRouters.reading);
  app.use('/api/music', requireSection('music'), selectedRouters.music);
  app.use('/api/admin/pairing-invites', requireLocalAdminBrowser, selectedRouters.adminPairingInvites);
  app.use('/api/admin/paired-devices', requireLocalAdminBrowser, selectedRouters.adminPairedDevices);
  app.use('/api/admin/accounts', requireAdmin, selectedRouters.adminAccounts);
  app.use('/api/library', requireAdmin, selectedRouters.library);
  app.use('/api/metadata/music', requireAdmin, selectedRouters.musicMetadata);
  app.use('/api/metadata', requireAdmin, selectedRouters.metadataEditor);
  app.use('/api/uploads', requireAdmin, selectedRouters.contentUpload);

  const frontendRoot = staticRoot || path.join(selectedConfig.projectRoot, 'public');
  app.use(express.static(frontendRoot));

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Endpoint non trovato.' });
  });
  app.use(apiErrorHandler);
  return app;
}

module.exports = { createApp, createDefaultRouters };
