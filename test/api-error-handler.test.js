'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isMalformedJsonError,
  apiErrorHandler,
} = require('../src/middleware/api-error-handler');

test('riconosce soltanto gli errori di parsing JSON prodotti da express.json', () => {
  assert.equal(isMalformedJsonError({ type: 'entity.parse.failed', status: 400 }), true);
  assert.equal(isMalformedJsonError({ type: 'entity.parse.failed', statusCode: 400 }), true);
  assert.equal(isMalformedJsonError({ type: 'entity.parse.failed', status: 500 }), false);
  assert.equal(isMalformedJsonError(new SyntaxError('generico')), false);
});

test('il gestore restituisce INVALID_JSON senza esporre dettagli del parser', () => {
  let statusCode = null;
  let payload = null;
  const res = {
    headersSent: false,
    status(value) {
      statusCode = value;
      return this;
    },
    json(value) {
      payload = value;
      return this;
    },
  };

  apiErrorHandler(
    { type: 'entity.parse.failed', status: 400, message: 'Unexpected token at position 1' },
    {},
    res,
    () => assert.fail('next non deve essere invocato'),
  );

  assert.equal(statusCode, 400);
  assert.deepEqual(payload, {
    error: 'Corpo JSON non valido.',
    code: 'INVALID_JSON',
  });
});
