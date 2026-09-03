'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MIN_PASSWORD_LENGTH,
  AccountPasswordError,
  parsePasswordHash,
  hashAccountPassword,
  verifyAccountPassword,
} = require('../src/services/account-password-service');

test('le password account sono salvate con scrypt, salt casuale e formato versionato', async () => {
  const password = 'Cinghiala-super-sicura-2026';
  const first = await hashAccountPassword(password);
  const second = await hashAccountPassword(password);

  assert.notEqual(first, password);
  assert.notEqual(first, second);
  assert.equal(parsePasswordHash(first)?.cost, 16_384);
  assert.equal(await verifyAccountPassword(password, first), true);
  assert.equal(await verifyAccountPassword('password errata', first), false);
});

test('il verificatore rifiuta hash malformati senza sollevare errori', async () => {
  assert.equal(await verifyAccountPassword('qualunque password', null), false);
  assert.equal(await verifyAccountPassword('qualunque password', 'scrypt$rotto'), false);
  assert.equal(await verifyAccountPassword('qualunque password', 'pbkdf2$1$2$3'), false);
});

test('la policy password è centralizzata e rifiuta valori troppo corti', async () => {
  await assert.rejects(
    hashAccountPassword('x'.repeat(MIN_PASSWORD_LENGTH - 1)),
    (error) => error instanceof AccountPasswordError && error.code === 'PASSWORD_TOO_SHORT',
  );
});
