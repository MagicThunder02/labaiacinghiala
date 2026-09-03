'use strict';

const express = require('express');
const {
  AccountAdminError,
  AccountError,
  AccountPasswordError,
  listManagedAccounts,
  createManagedAccount,
  updateManagedAccount,
  resetManagedPassword,
  logoutManagedAccountDevices,
  deleteManagedAccount,
} = require('../services/account-admin-service');

const ACCOUNT_ERROR_STATUS = Object.freeze({
  ACCOUNT_NOT_FOUND: 404,
  USERNAME_EXISTS: 409,
  ACCOUNT_KEY_EXISTS: 409,
  LAST_ADMIN_REQUIRED: 409,
});

function sendAdminAccountError(res, error) {
  if (error instanceof AccountAdminError) {
    return res.status(error.status || 400).json({ error: error.message, code: error.code });
  }
  if (error instanceof AccountPasswordError) {
    return res.status(400).json({ error: error.message, code: error.code });
  }
  if (error instanceof AccountError) {
    return res.status(ACCOUNT_ERROR_STATUS[error.code] || 400).json({
      error: error.message,
      code: error.code,
    });
  }
  return null;
}

function createAdminAccountsRouter({ database } = {}) {
  if (!database) throw new TypeError('Database richiesto per la gestione account.');

  const router = express.Router();

  router.get('/', (req, res, next) => {
    try {
      return res.json({
        accounts: listManagedAccounts(database, { currentAccountId: req.baiaAccount.id }),
      });
    } catch (error) {
      return sendAdminAccountError(res, error) || next(error);
    }
  });

  router.post('/', async (req, res, next) => {
    try {
      const account = await createManagedAccount(database, {
        username: req.body?.username,
        password: req.body?.password,
        role: req.body?.role,
        sections: req.body?.sections,
        mustChangePassword: req.body?.mustChangePassword,
      }, { currentAccountId: req.baiaAccount.id });
      return res.status(201).json({ account });
    } catch (error) {
      return sendAdminAccountError(res, error) || next(error);
    }
  });

  router.put('/:accountId', (req, res, next) => {
    try {
      const account = updateManagedAccount(
        database,
        req.baiaAccount.id,
        req.params.accountId,
        {
          username: req.body?.username,
          role: req.body?.role,
          sections: req.body?.sections,
          disabled: req.body?.disabled,
        },
      );
      return res.json({ account });
    } catch (error) {
      return sendAdminAccountError(res, error) || next(error);
    }
  });

  router.put('/:accountId/password', async (req, res, next) => {
    try {
      const account = await resetManagedPassword(
        database,
        req.baiaAccount.id,
        req.params.accountId,
        {
          password: req.body?.password,
          mustChangePassword: req.body?.mustChangePassword,
        },
      );
      return res.json({ account });
    } catch (error) {
      return sendAdminAccountError(res, error) || next(error);
    }
  });

  router.post('/:accountId/logout-devices', (req, res, next) => {
    try {
      return res.json(logoutManagedAccountDevices(
        database,
        req.baiaAccount.id,
        req.params.accountId,
      ));
    } catch (error) {
      return sendAdminAccountError(res, error) || next(error);
    }
  });

  router.post('/:accountId/delete', (req, res, next) => {
    try {
      return res.json(deleteManagedAccount(
        database,
        req.baiaAccount.id,
        req.params.accountId,
      ));
    } catch (error) {
      return sendAdminAccountError(res, error) || next(error);
    }
  });

  return router;
}

module.exports = {
  ACCOUNT_ERROR_STATUS,
  sendAdminAccountError,
  createAdminAccountsRouter,
};
