const db = require('../database');
const { isLocalAdminBrowserRequest, normalizeAddress } = require('./local-admin-access');
const {
  DeviceAuthError,
  verifyRequestAuthorization,
  verifyMediaAuthorization,
} = require('../services/device-auth-service');

const replayCache = new Map();
const lastSeenWrites = new Map();
const LAST_SEEN_WRITE_INTERVAL_MS = 30_000;

function requestTarget(req) {
  return String(req.originalUrl || req.url || '').split('#', 1)[0];
}

function requestPath(req) {
  return requestTarget(req).split('?', 1)[0];
}

function mediaAuthFromRequest(req) {
  const deviceId = req.query?._baia_device;
  const expires = req.query?._baia_expires;
  const signature = req.query?._baia_signature;
  if (!deviceId && !expires && !signature) return null;
  return { deviceId, expires, signature };
}

function headerAuthFromRequest(req) {
  const deviceId = req.get('X-Baia-Device-Id');
  const timestamp = req.get('X-Baia-Timestamp');
  const nonce = req.get('X-Baia-Nonce');
  const signature = req.get('X-Baia-Signature');
  if (!deviceId && !timestamp && !nonce && !signature) return null;
  return { deviceId, timestamp, nonce, signature };
}

function touchLastSeen(deviceId) {
  const now = Date.now();
  if (now - Number(lastSeenWrites.get(deviceId) || 0) < LAST_SEEN_WRITE_INTERVAL_MS) return;
  db.prepare(`
    UPDATE paired_devices
    SET last_seen_at = ?
    WHERE id = ? AND revoked_at IS NULL
  `).run(now, deviceId);
  lastSeenWrites.set(deviceId, now);
}

function attachDevice(req, device) {
  req.baiaDevice = device;
  touchLastSeen(device.id);
}

function deviceAuth(req, res, next) {
  try {
    const mediaAuth = mediaAuthFromRequest(req);
    if (mediaAuth && (req.method === 'GET' || req.method === 'HEAD')) {
      const device = verifyMediaAuthorization(db, mediaAuth, {
        path: requestPath(req),
      });
      attachDevice(req, device);
      return next();
    }

    const headerAuth = headerAuthFromRequest(req);
    if (headerAuth) {
      const device = verifyRequestAuthorization(db, headerAuth, {
        method: req.method,
        target: requestTarget(req),
        replayCache,
      });
      attachDevice(req, device);
      return next();
    }

    // Il browser amministrativo è accettato soltanto tramite loopback, con Host e
    // contesto browser locali verificati e senza indicazioni di proxy. Le richieste
    // Tauri continuano invece a richiedere sempre la firma del dispositivo.
    if (isLocalAdminBrowserRequest(req)) {
      req.baiaLocalAccess = true;
      return next();
    }

    throw new DeviceAuthError('AUTH_REQUIRED', 'Dispositivo Baia non autenticato.');
  } catch (error) {
    if (!(error instanceof DeviceAuthError)) return next(error);
    return res.status(error.status || 401).json({ error: error.message, code: error.code });
  }
}

module.exports = {
  deviceAuth,
  isLocalAdminBrowserRequest,
  normalizeAddress,
};
