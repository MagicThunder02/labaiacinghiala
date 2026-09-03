'use strict';

const express = require('express');
const { directBootstrapFromEnvironment } = require('../direct-bootstrap');
const {
  PairingError,
  createPairingInvite,
  listPairingInvites,
  revokePairingInvite,
} = require('../services/pairing-service');

function sendPairingInviteError(res, error) {
  if (!(error instanceof PairingError)) return null;
  return res.status(error.status || 400).json({
    error: error.message,
    code: error.code,
  });
}

function createAdminPairingInvitesRouter({ database } = {}) {
  if (!database) throw new TypeError('Database richiesto per la gestione inviti pairing.');

  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.get('/', (req, res, next) => {
    try {
      return res.json({ invites: listPairingInvites(database) });
    } catch (error) {
      return sendPairingInviteError(res, error) || next(error);
    }
  });

  router.post('/', (req, res, next) => {
    try {
      const created = createPairingInvite(database, {
        ttlMinutes: req.body?.ttlMinutes,
      });
      const directBootstrap = directBootstrapFromEnvironment(created.token);
      return res.status(201).json({
        invite: {
          id: created.inviteId,
          token: created.token,
          ...(directBootstrap ? { directBootstrap } : {}),
          createdAt: created.createdAt,
          expiresAt: created.expiresAt,
        },
      });
    } catch (error) {
      return sendPairingInviteError(res, error) || next(error);
    }
  });

  router.post('/:inviteId/revoke', (req, res, next) => {
    try {
      return res.json({
        invite: revokePairingInvite(database, req.params.inviteId),
      });
    } catch (error) {
      return sendPairingInviteError(res, error) || next(error);
    }
  });

  return router;
}

module.exports = {
  sendPairingInviteError,
  createAdminPairingInvitesRouter,
};
