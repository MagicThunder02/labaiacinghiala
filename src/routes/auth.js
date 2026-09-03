'use strict';

const express = require('express');
const {
  AccountPasswordError,
} = require('../services/account-password-service');
const {
  AccountAuthError,
  LoginRateLimiter,
  authStatePayload,
  clearDeviceAccountBinding,
  resolveRequestAccount,
  authenticateAccountCredentials,
  changeOwnAccountPassword,
} = require('../services/account-auth-service');
const {
  AccountAccessError,
  assertPasswordChangeCompleted,
  sendAccountAccessError,
} = require('../middleware/account-access');
const {
  attachAccountContext,
  createAccountAuth,
  sendAccountAuthError,
} = require('../middleware/account-auth');

function createAuthRouter({
  database,
  loginRateLimiter = new LoginRateLimiter(),
} = {}) {
  if (!database) throw new TypeError('Database richiesto per il router account.');

  const router = express.Router();
  const accountAuth = createAccountAuth({ database });

  router.post('/login', async (req, res, next) => {
    const limiterKey = req.baiaDevice?.id;
    try {
      if (!limiterKey) {
        throw new AccountAuthError('DEVICE_REQUIRED', 'È richiesto un dispositivo Baia verificato.', 403);
      }
      const activeContext = resolveRequestAccount(database, req, { required: false, clearInvalid: false });
      if (activeContext.account) assertPasswordChangeCompleted({ baiaAccount: activeContext.account });
      loginRateLimiter.assertAllowed(limiterKey);
      const context = await authenticateAccountCredentials(database, {
        device: req.baiaDevice,
        username: req.body?.username,
        password: req.body?.password,
      });
      loginRateLimiter.recordSuccess(limiterKey);
      attachAccountContext(req, context);
      return res.json(authStatePayload({
        account: context.account,
        device: req.baiaDevice,
        session: context.session,
      }));
    } catch (error) {
      if (error instanceof AccountAccessError) return sendAccountAccessError(res, error);
      if (error instanceof AccountAuthError) {
        if (limiterKey && error.code === 'ACCOUNT_CREDENTIALS_INVALID') {
          loginRateLimiter.recordFailure(limiterKey);
        }
        return sendAccountAuthError(res, error);
      }
      return next(error);
    }
  });

  router.post('/logout', (req, res) => {
    if (req.baiaDevice?.id) {
      clearDeviceAccountBinding(database, req.baiaDevice.id);
      return res.json({ loggedOut: true, localAccess: false });
    }
    return res.json({ loggedOut: false, localAccess: Boolean(req.baiaLocalAccess) });
  });

  router.get('/me', (req, res, next) => {
    try {
      const context = resolveRequestAccount(database, req, { required: false });
      if (!context.account) {
        return res.json(authStatePayload({
          device: req.baiaDevice,
          reasonCode: context.error?.code || 'ACCOUNT_REQUIRED',
        }));
      }
      attachAccountContext(req, context);
      return res.json(authStatePayload({
        account: context.account,
        device: req.baiaDevice,
        session: context.session,
      }));
    } catch (error) {
      if (error instanceof AccountAuthError) return sendAccountAuthError(res, error);
      return next(error);
    }
  });

  router.put('/password', accountAuth, async (req, res, next) => {
    try {
      const context = await changeOwnAccountPassword(database, {
        account: req.baiaAccount,
        device: req.baiaDevice,
        session: req.baiaAccountSession,
        currentPassword: req.body?.currentPassword,
        newPassword: req.body?.newPassword,
      });
      attachAccountContext(req, context);
      return res.json(authStatePayload({
        account: context.account,
        device: req.baiaDevice,
        session: context.session,
      }));
    } catch (error) {
      if (error instanceof AccountAuthError) return sendAccountAuthError(res, error);
      if (error instanceof AccountPasswordError) {
        return res.status(400).json({ error: error.message, code: error.code });
      }
      return next(error);
    }
  });

  return router;
}

module.exports = {
  createAuthRouter,
};
