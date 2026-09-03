'use strict';

const express = require('express');
const {
  PairingError,
  listPairedDevices,
  revokePairedDevice,
} = require('../services/pairing-service');

function sendPairedDeviceError(res, error) {
  if (!(error instanceof PairingError)) return null;
  return res.status(error.status || 400).json({
    error: error.message,
    code: error.code,
  });
}

function createAdminPairedDevicesRouter({ database } = {}) {
  if (!database) throw new TypeError('Database richiesto per la gestione dispositivi pairing.');

  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.get('/', (req, res, next) => {
    try {
      return res.json({ devices: listPairedDevices(database) });
    } catch (error) {
      return sendPairedDeviceError(res, error) || next(error);
    }
  });

  router.post('/:deviceId/revoke', (req, res, next) => {
    try {
      revokePairedDevice(database, req.params.deviceId);
      const device = listPairedDevices(database)
        .find((item) => item.id === req.params.deviceId) || null;
      return res.json({ device });
    } catch (error) {
      return sendPairedDeviceError(res, error) || next(error);
    }
  });

  return router;
}

module.exports = {
  sendPairedDeviceError,
  createAdminPairedDevicesRouter,
};
