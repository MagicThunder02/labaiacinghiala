'use strict';

const API_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE']);

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isRelativeApiPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/api/') || value.startsWith('//')) return false;
  if (value.includes('\\') || value.includes('#')) return false;
  try {
    const parsed = new URL(value, 'http://baia.invalid');
    return parsed.origin === 'http://baia.invalid' && parsed.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

function isPairingRedeemRequest(value) {
  return isRecord(value)
    && typeof value.inviteToken === 'string'
    && value.inviteToken.startsWith('baia1.')
    && typeof value.installationId === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.installationId)
    && typeof value.publicKey === 'string'
    && /^[A-Za-z0-9_-]{43}$/.test(value.publicKey)
    && typeof value.signature === 'string'
    && /^[A-Za-z0-9_-]{86}$/.test(value.signature)
    && (value.deviceName === undefined || typeof value.deviceName === 'string');
}

function parseApiError(value) {
  if (!isRecord(value) || typeof value.error !== 'string') return null;
  return {
    error: value.error,
    ...(typeof value.code === 'string' ? { code: value.code } : {}),
    ...(typeof value.section === 'string' ? { section: value.section } : {}),
  };
}

function parseApiTransportResponse(value) {
  if (!isRecord(value)
    || !Number.isInteger(value.status)
    || value.status < 100
    || value.status > 599
    || typeof value.ok !== 'boolean'
    || !isRecord(value.headers)
    || typeof value.body !== 'string') {
    throw new TypeError('Risposta del trasporto Baia non valida.');
  }
  const headers = {};
  for (const [name, headerValue] of Object.entries(value.headers)) {
    if (typeof headerValue !== 'string') throw new TypeError('Header del trasporto Baia non valido.');
    headers[name.toLowerCase()] = headerValue;
  }
  return { status: value.status, ok: value.ok, headers, body: value.body };
}

function parseCoreBootstrap(value) {
  if (!isRecord(value)
    || typeof value.coreVersion !== 'string'
    || typeof value.platform !== 'string'
    || typeof value.apiBaseUrl !== 'string'
    || typeof value.transport !== 'string'
    || typeof value.installationId !== 'string') {
    throw new TypeError('Bootstrap pubblico Baia Core non valido.');
  }
  return {
    coreVersion: value.coreVersion,
    platform: value.platform,
    apiBaseUrl: value.apiBaseUrl,
    transport: value.transport,
    installationId: value.installationId,
  };
}

function parsePairingStatus(value) {
  if (!isRecord(value)
    || typeof value.paired !== 'boolean'
    || typeof value.currentServerMatches !== 'boolean'
    || typeof value.suggestedDeviceName !== 'string') {
    throw new TypeError('Stato pairing Baia Core non valido.');
  }
  const nullableString = (field) => field === null || typeof field === 'string';
  if (!nullableString(value.serverBaseUrl)
    || !nullableString(value.deviceId)
    || !nullableString(value.deviceName)
    || !nullableString(value.fingerprint)
    || !nullableString(value.pairedAt)) {
    throw new TypeError('Stato pairing Baia Core incompleto.');
  }
  return value;
}

module.exports = {
  API_METHODS,
  isPairingRedeemRequest,
  isRecord,
  isRelativeApiPath,
  parseApiError,
  parseApiTransportResponse,
  parseCoreBootstrap,
  parsePairingStatus,
};
