'use strict';

const express = require('express');
const { PairingError, redeemPairingInvite } = require('../services/pairing-service');

function createPairingRouter({ database } = {}) {
  if (!database) throw new TypeError('Database richiesto per il router pairing.');

  const router = express.Router();
  router.post('/redeem', (req, res, next) => {
    try {
      const device = redeemPairingInvite(database, req.body);
      return res.status(201).json({ paired: true, device });
    } catch (error) {
      if (!(error instanceof PairingError)) return next(error);

      if (error.code === 'INVALID_REQUEST') {
        return res.status(400).json({ error: error.message });
      }
      if (error.code === 'DEVICE_ALREADY_PAIRED') {
        return res.status(409).json({ error: error.message });
      }
      if (error.code === 'INVITE_INVALID' || error.code === 'PROOF_INVALID') {
        return res.status(401).json({ error: error.message });
      }
      return res.status(400).json({ error: error.message });
    }
  });

  return router;
}

module.exports = { createPairingRouter };
