const express = require('express');
const config = require('../config');
const packageJson = require('../../package.json');

const router = express.Router();

router.get('/', (req, res) => {
  res.json({
    app: {
      name: config.appDisplayName,
      uiVersion: config.appUiVersion,
      serverVersion: packageJson.version,
      profileName: config.profileName,
    },
  });
});

module.exports = router;
