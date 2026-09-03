'use strict';

const {
  isAllowedLocalAdminHost,
  isAllowedLocalAdminOrigin,
} = require('./local-admin-access');

const TAURI_APP_ORIGINS = new Set([
  'http://tauri.localhost',
  'http://localhost:1430',
  'http://127.0.0.1:1430',
]);

function isAllowedApiOrigin(origin, requestHost, localPort) {
  if (TAURI_APP_ORIGINS.has(String(origin || ''))) return true;
  return isAllowedLocalAdminHost(requestHost, localPort)
    && isAllowedLocalAdminOrigin(origin, localPort);
}

function apiCors(req, res, next) {
  const origin = req.get('Origin');
  if (!origin) return next();

  if (!isAllowedApiOrigin(origin, req.get('Host'), req.socket?.localPort)) {
    return res.status(403).json({
      error: 'Origine non autorizzata.',
      code: 'ORIGIN_NOT_ALLOWED',
    });
  }

  res.vary('Origin');
  res.set('Access-Control-Allow-Origin', origin);
  res.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-Baia-Device-Id, X-Baia-Timestamp, X-Baia-Nonce, X-Baia-Signature, Range');
  res.set('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Length, Content-Range');
  res.set('Access-Control-Max-Age', '600');

  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
}

module.exports = {
  TAURI_APP_ORIGINS,
  apiCors,
  isAllowedApiOrigin,
};
