'use strict';

const {
  AccountAuthError,
  resolveRequestAccount,
} = require('../services/account-auth-service');

function attachAccountContext(req, context) {
  req.baiaAccount = context.account;
  req.baiaAccountSession = context.session;
  return context;
}

function sendAccountAuthError(res, error) {
  if (error.retryAfterSeconds) res.set('Retry-After', String(error.retryAfterSeconds));
  return res.status(error.status || 401).json({
    error: error.message,
    code: error.code,
  });
}

function createAccountAuth({ database } = {}) {
  if (!database) throw new TypeError('Database richiesto per accountAuth.');

  return function accountAuth(req, res, next) {
    try {
      const context = resolveRequestAccount(database, req);
      attachAccountContext(req, context);
      return next();
    } catch (error) {
      if (!(error instanceof AccountAuthError)) return next(error);
      return sendAccountAuthError(res, error);
    }
  };
}

module.exports = {
  attachAccountContext,
  sendAccountAuthError,
  createAccountAuth,
};
