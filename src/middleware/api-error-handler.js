'use strict';

function isMalformedJsonError(error) {
  return Boolean(
    error
    && error.type === 'entity.parse.failed'
    && Number(error.status || error.statusCode) === 400,
  );
}

function apiErrorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);

  if (isMalformedJsonError(error)) {
    return res.status(400).json({
      error: 'Corpo JSON non valido.',
      code: 'INVALID_JSON',
    });
  }

  console.error(error);
  return res.status(500).json({ error: 'Errore interno del server.' });
}

module.exports = {
  isMalformedJsonError,
  apiErrorHandler,
};
