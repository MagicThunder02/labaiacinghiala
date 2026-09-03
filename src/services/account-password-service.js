'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scryptAsync = promisify(crypto.scrypt);
const PASSWORD_FORMAT = 'scrypt';
const PASSWORD_FORMAT_VERSION = 1;
const SCRYPT_COST = 16_384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_KEY_BYTES = 64;
const PASSWORD_SALT_BYTES = 16;
const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_BYTES = 1024;
const DUMMY_PASSWORD_SALT = Buffer.from('BaiaAuthDummySalt', 'utf8');

class AccountPasswordError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AccountPasswordError';
    this.code = code;
  }
}

function validatePassword(password) {
  if (typeof password !== 'string') {
    throw new AccountPasswordError('PASSWORD_INVALID', 'La password non è valida.');
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new AccountPasswordError(
      'PASSWORD_TOO_SHORT',
      `La password deve contenere almeno ${MIN_PASSWORD_LENGTH} caratteri.`,
    );
  }
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    throw new AccountPasswordError('PASSWORD_TOO_LONG', 'La password è troppo lunga.');
  }
  return password;
}

function encodePasswordHash({ salt, hash, cost, blockSize, parallelization }) {
  return [
    PASSWORD_FORMAT,
    PASSWORD_FORMAT_VERSION,
    cost,
    blockSize,
    parallelization,
    salt.toString('base64url'),
    hash.toString('base64url'),
  ].join('$');
}

function parsePasswordHash(encodedHash) {
  if (typeof encodedHash !== 'string') return null;
  const parts = encodedHash.split('$');
  if (parts.length !== 7 || parts[0] !== PASSWORD_FORMAT || Number(parts[1]) !== PASSWORD_FORMAT_VERSION) {
    return null;
  }

  const cost = Number(parts[2]);
  const blockSize = Number(parts[3]);
  const parallelization = Number(parts[4]);
  if (![cost, blockSize, parallelization].every(Number.isSafeInteger)
      || cost !== SCRYPT_COST
      || blockSize !== SCRYPT_BLOCK_SIZE
      || parallelization !== SCRYPT_PARALLELIZATION) {
    return null;
  }

  let salt;
  let hash;
  try {
    salt = Buffer.from(parts[5], 'base64url');
    hash = Buffer.from(parts[6], 'base64url');
  } catch {
    return null;
  }
  if (salt.length < 16 || hash.length !== SCRYPT_KEY_BYTES
      || salt.toString('base64url') !== parts[5]
      || hash.toString('base64url') !== parts[6]) {
    return null;
  }

  return { salt, hash, cost, blockSize, parallelization };
}


function scryptOptions({
  cost = SCRYPT_COST,
  blockSize = SCRYPT_BLOCK_SIZE,
  parallelization = SCRYPT_PARALLELIZATION,
} = {}) {
  return {
    N: cost,
    r: blockSize,
    p: parallelization,
    maxmem: Math.max(32 * 1024 * 1024, 256 * cost * blockSize),
  };
}

const DUMMY_PASSWORD_HASH = encodePasswordHash({
  salt: DUMMY_PASSWORD_SALT,
  hash: crypto.scryptSync(
    'baia-account-auth-dummy-password',
    DUMMY_PASSWORD_SALT,
    SCRYPT_KEY_BYTES,
    scryptOptions(),
  ),
  cost: SCRYPT_COST,
  blockSize: SCRYPT_BLOCK_SIZE,
  parallelization: SCRYPT_PARALLELIZATION,
});

async function derivePasswordHash(password, salt, options = {}) {
  return scryptAsync(password, salt, SCRYPT_KEY_BYTES, scryptOptions(options));
}

async function hashAccountPassword(password) {
  const validated = validatePassword(password);
  const salt = crypto.randomBytes(PASSWORD_SALT_BYTES);
  const hash = await derivePasswordHash(validated, salt);
  return encodePasswordHash({
    salt,
    hash,
    cost: SCRYPT_COST,
    blockSize: SCRYPT_BLOCK_SIZE,
    parallelization: SCRYPT_PARALLELIZATION,
  });
}

async function verifyAccountPassword(password, encodedHash) {
  if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    return false;
  }
  const parsed = parsePasswordHash(encodedHash);
  if (!parsed) return false;

  let candidate;
  try {
    candidate = await derivePasswordHash(password, parsed.salt, parsed);
  } catch {
    return false;
  }
  return candidate.length === parsed.hash.length
    && crypto.timingSafeEqual(candidate, parsed.hash);
}

module.exports = {
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_BYTES,
  DUMMY_PASSWORD_HASH,
  AccountPasswordError,
  validatePassword,
  parsePasswordHash,
  hashAccountPassword,
  verifyAccountPassword,
};
