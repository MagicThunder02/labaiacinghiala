'use strict';

const {
  getAccountById,
  getAccountByKey,
  normalizeUsernameLookup,
} = require('./account-service');
const {
  hashAccountPassword,
  verifyAccountPassword,
  DUMMY_PASSWORD_HASH,
} = require('./account-password-service');
const { effectiveAccountSections } = require('./account-section-service');

const ACCOUNT_BINDING_SOURCES = new Set(['legacy', 'login', 'admin']);
const DEFAULT_LOGIN_MAX_FAILURES = 5;
const DEFAULT_LOGIN_WINDOW_MS = 5 * 60_000;
const DEFAULT_LOGIN_BLOCK_MS = 15 * 60_000;

class AccountAuthError extends Error {
  constructor(code, message, status = 401, details = {}) {
    super(message);
    this.name = 'AccountAuthError';
    this.code = code;
    this.status = status;
    Object.assign(this, details);
  }
}

class LoginRateLimiter {
  constructor({
    maxFailures = DEFAULT_LOGIN_MAX_FAILURES,
    windowMs = DEFAULT_LOGIN_WINDOW_MS,
    blockMs = DEFAULT_LOGIN_BLOCK_MS,
    now = () => Date.now(),
  } = {}) {
    this.maxFailures = maxFailures;
    this.windowMs = windowMs;
    this.blockMs = blockMs;
    this.now = now;
    this.entries = new Map();
  }

  clean(now = this.now()) {
    for (const [key, entry] of this.entries) {
      const lastRelevant = Math.max(Number(entry.windowStartedAt || 0), Number(entry.blockedUntil || 0));
      if (lastRelevant + Math.max(this.windowMs, this.blockMs) < now) this.entries.delete(key);
    }
  }

  assertAllowed(key) {
    const now = this.now();
    this.clean(now);
    const entry = this.entries.get(key);
    if (!entry || Number(entry.blockedUntil || 0) <= now) return;
    const retryAfterSeconds = Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000));
    throw new AccountAuthError(
      'LOGIN_RATE_LIMITED',
      'Troppi tentativi di accesso. Riprova più tardi.',
      429,
      { retryAfterSeconds },
    );
  }

  recordFailure(key) {
    const now = this.now();
    let entry = this.entries.get(key);
    if (!entry || now - Number(entry.windowStartedAt || 0) > this.windowMs) {
      entry = { failures: 0, windowStartedAt: now, blockedUntil: 0 };
    }
    entry.failures += 1;
    if (entry.failures >= this.maxFailures) entry.blockedUntil = now + this.blockMs;
    this.entries.set(key, entry);
  }

  recordSuccess(key) {
    this.entries.delete(key);
  }
}

function normalizeBindingSource(value) {
  const source = String(value || '').trim().toLowerCase();
  if (!ACCOUNT_BINDING_SOURCES.has(source)) {
    throw new AccountAuthError('ACCOUNT_BINDING_INVALID', 'Origine sessione account non valida.', 500);
  }
  return source;
}

function accountPublicView(account) {
  if (!account) return null;
  return {
    id: account.id,
    username: account.username,
    role: account.role,
    passwordConfigured: Boolean(account.passwordHash),
    mustChangePassword: account.mustChangePassword,
  };
}

function accountCapabilities(account) {
  const admin = account?.role === 'admin';
  return {
    manageAccounts: admin,
    uploadContent: admin,
    editMetadata: admin,
  };
}

function devicePublicView(device, session = {}) {
  if (!device) return null;
  return {
    id: device.id,
    deviceName: device.deviceName,
    fingerprint: device.fingerprint,
    installationId: device.installationId,
    bindingSource: session.bindingSource || device.accountBindingSource || null,
  };
}

function authStatePayload({ account = null, device = null, session = {}, reasonCode = null } = {}) {
  const authenticated = Boolean(account);
  return {
    authenticated,
    account: accountPublicView(account),
    sections: authenticated ? effectiveAccountSections(account, account.sections) : [],
    capabilities: authenticated ? accountCapabilities(account) : accountCapabilities(null),
    device: devicePublicView(device, session),
    localAccess: Boolean(session.localAccess),
    ...(reasonCode ? { reasonCode } : {}),
  };
}

function clearDeviceAccountBinding(db, deviceId) {
  if (!deviceId) return false;
  const result = db.prepare(`
    UPDATE paired_devices SET
      active_account_id = NULL,
      active_account_auth_version = NULL,
      account_authenticated_at = NULL,
      account_binding_source = NULL
    WHERE id = ?
  `).run(deviceId);
  return Number(result.changes) > 0;
}

function bindAccountToDevice(db, deviceId, account, {
  source = 'login',
  now = Date.now(),
} = {}) {
  if (!deviceId) {
    throw new AccountAuthError('DEVICE_REQUIRED', 'È richiesto un dispositivo Baia verificato.', 403);
  }
  const bindingSource = normalizeBindingSource(source);
  const accountId = typeof account === 'string' ? account : account?.id;
  const activeAccount = accountId ? getAccountById(db, accountId, { includeDeleted: true }) : null;
  if (!activeAccount || activeAccount.deletedAt || activeAccount.disabledAt) {
    throw new AccountAuthError('ACCOUNT_UNAVAILABLE', 'Account non disponibile.', 403);
  }

  const result = db.prepare(`
    UPDATE paired_devices SET
      active_account_id = ?,
      active_account_auth_version = ?,
      account_authenticated_at = ?,
      account_binding_source = ?
    WHERE id = ? AND revoked_at IS NULL
  `).run(
    activeAccount.id,
    Number(activeAccount.authVersion),
    Number(now),
    bindingSource,
    deviceId,
  );
  if (Number(result.changes) !== 1) {
    throw new AccountAuthError('DEVICE_UNAVAILABLE', 'Dispositivo non disponibile.', 403);
  }
  return {
    account: getAccountById(db, activeAccount.id),
    session: {
      bindingSource,
      authenticatedAt: Number(now),
      localAccess: false,
    },
  };
}

function resolveDeviceAccount(db, device, { clearInvalid = true } = {}) {
  if (!device?.activeAccountId) {
    throw new AccountAuthError('ACCOUNT_REQUIRED', 'Effettua l’accesso con un account Baia.');
  }

  const account = getAccountById(db, device.activeAccountId, { includeDeleted: true });
  let error = null;
  if (!account || account.deletedAt) {
    error = new AccountAuthError('ACCOUNT_DELETED', 'L’account non è più disponibile.', 403);
  } else if (account.disabledAt) {
    error = new AccountAuthError('ACCOUNT_DISABLED', 'L’account è stato disabilitato.', 403);
  } else if (Number(device.activeAccountAuthVersion) !== Number(account.authVersion)) {
    error = new AccountAuthError('ACCOUNT_SESSION_EXPIRED', 'La sessione account non è più valida.');
  }

  if (error) {
    if (clearInvalid && device.id) clearDeviceAccountBinding(db, device.id);
    throw error;
  }

  return {
    account,
    session: {
      bindingSource: device.accountBindingSource || 'login',
      authenticatedAt: Number(device.accountAuthenticatedAt || 0) || null,
      localAccess: false,
    },
  };
}

function resolveLocalAdminAccount(db) {
  let account = null;
  try {
    const defaultAccount = getAccountByKey(db, 'default', { includeDeleted: true });
    if (defaultAccount?.role === 'admin' && !defaultAccount.disabledAt && !defaultAccount.deletedAt) {
      account = defaultAccount;
    }
  } catch {}

  if (!account) {
    const row = db.prepare(`
      SELECT id
      FROM accounts
      WHERE role = 'admin' AND disabled_at IS NULL AND deleted_at IS NULL
      ORDER BY CASE WHEN account_key = 'default' THEN 0 ELSE 1 END,
               created_at ASC,
               id ASC
      LIMIT 1
    `).get();
    if (row) account = getAccountById(db, row.id);
  }
  if (!account) {
    throw new AccountAuthError('LOCAL_ADMIN_UNAVAILABLE', 'Nessun account amministratore locale disponibile.', 503);
  }
  return {
    account,
    session: {
      bindingSource: 'admin',
      authenticatedAt: null,
      localAccess: true,
    },
  };
}

function resolveRequestAccount(db, req, { required = true, clearInvalid = true } = {}) {
  try {
    if (req.baiaLocalAccess) return resolveLocalAdminAccount(db);
    if (req.baiaDevice) return resolveDeviceAccount(db, req.baiaDevice, { clearInvalid });
    throw new AccountAuthError('ACCOUNT_REQUIRED', 'Effettua l’accesso con un account Baia.');
  } catch (error) {
    if (!required && error instanceof AccountAuthError && [
      'ACCOUNT_REQUIRED',
      'ACCOUNT_DELETED',
      'ACCOUNT_DISABLED',
      'ACCOUNT_SESSION_EXPIRED',
    ].includes(error.code)) {
      return { account: null, session: null, error };
    }
    throw error;
  }
}

function findLoginAccount(db, username) {
  let normalized;
  try {
    normalized = normalizeUsernameLookup(username);
  } catch {
    return null;
  }
  const row = db.prepare(`
    SELECT id
    FROM accounts
    WHERE username_normalized = ?
    LIMIT 1
  `).get(normalized);
  return row ? getAccountById(db, row.id, { includeDeleted: true }) : null;
}

async function authenticateAccountCredentials(db, {
  device,
  username,
  password,
  now = Date.now(),
} = {}) {
  if (!device?.id) {
    throw new AccountAuthError('DEVICE_REQUIRED', 'È richiesto un dispositivo Baia verificato.', 403);
  }

  const account = findLoginAccount(db, username);
  const candidateHash = account?.passwordHash || DUMMY_PASSWORD_HASH;
  const validPassword = await verifyAccountPassword(password, candidateHash);
  const current = account ? getAccountById(db, account.id, { includeDeleted: true }) : null;
  const usableAccount = current
    && !current.deletedAt
    && !current.disabledAt
    && current.passwordHash
    && current.passwordHash === account.passwordHash
    && Number(current.authVersion) === Number(account.authVersion);
  if (!validPassword || !usableAccount) {
    throw new AccountAuthError('ACCOUNT_CREDENTIALS_INVALID', 'Username o password non validi.');
  }

  return bindAccountToDevice(db, device.id, current, { source: 'login', now });
}

async function changeOwnAccountPassword(db, {
  account,
  device = null,
  session = {},
  currentPassword,
  newPassword,
  now = Date.now(),
  nowIso = new Date(now).toISOString(),
} = {}) {
  if (!account?.id) {
    throw new AccountAuthError('ACCOUNT_REQUIRED', 'Effettua l’accesso con un account Baia.');
  }

  if (account.passwordHash) {
    const validCurrentPassword = await verifyAccountPassword(currentPassword, account.passwordHash);
    if (!validCurrentPassword) {
      throw new AccountAuthError('CURRENT_PASSWORD_INVALID', 'La password attuale non è corretta.', 400);
    }
  } else if (!session.localAccess && session.bindingSource !== 'legacy') {
    throw new AccountAuthError('PASSWORD_SETUP_NOT_ALLOWED', 'Impostazione iniziale della password non consentita.', 403);
  }

  const passwordHash = await hashAccountPassword(newPassword);
  db.exec('BEGIN IMMEDIATE');
  try {
    if (device?.id) {
      const currentBinding = db.prepare(`
        SELECT active_account_id AS accountId,
               active_account_auth_version AS authVersion,
               revoked_at AS revokedAt
        FROM paired_devices
        WHERE id = ?
        LIMIT 1
      `).get(device.id);
      if (!currentBinding
          || currentBinding.revokedAt !== null
          || currentBinding.accountId !== account.id
          || Number(currentBinding.authVersion) !== Number(account.authVersion)) {
        throw new AccountAuthError('ACCOUNT_SESSION_EXPIRED', 'La sessione account non è più valida.');
      }
    }

    const update = db.prepare(`
      UPDATE accounts SET
        password_hash = ?,
        must_change_password = 0,
        auth_version = auth_version + 1,
        updated_at = ?
      WHERE id = ?
        AND auth_version = ?
        AND disabled_at IS NULL
        AND deleted_at IS NULL
    `).run(passwordHash, nowIso, account.id, Number(account.authVersion));
    if (Number(update.changes) !== 1) {
      throw new AccountAuthError('ACCOUNT_SESSION_EXPIRED', 'La sessione account non è più valida.');
    }

    const updated = getAccountById(db, account.id);
    let reboundSession = session;
    if (device?.id) {
      reboundSession = bindAccountToDevice(db, device.id, updated, {
        source: 'login',
        now,
      }).session;
    }
    db.exec('COMMIT');
    return {
      account: getAccountById(db, account.id),
      session: reboundSession,
    };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

module.exports = {
  DEFAULT_LOGIN_MAX_FAILURES,
  DEFAULT_LOGIN_WINDOW_MS,
  DEFAULT_LOGIN_BLOCK_MS,
  AccountAuthError,
  LoginRateLimiter,
  accountPublicView,
  accountCapabilities,
  authStatePayload,
  clearDeviceAccountBinding,
  bindAccountToDevice,
  resolveDeviceAccount,
  resolveLocalAdminAccount,
  resolveRequestAccount,
  authenticateAccountCredentials,
  changeOwnAccountPassword,
};
