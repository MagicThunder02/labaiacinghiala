'use strict';

const express = require('express');
const packageJson = require('../../package.json');

function createAppInfoRouter({ config, version = packageJson.version } = {}) {
  if (!config) throw new TypeError('Configurazione richiesta per il router app-info.');

  const router = express.Router();
  router.get('/', (req, res) => {
    res.json({
      app: {
        name: config.appDisplayName,
        uiVersion: config.appUiVersion,
        serverVersion: version,
        profileName: config.profileName,
      },
    });
  });
  return router;
}

module.exports = { createAppInfoRouter };
