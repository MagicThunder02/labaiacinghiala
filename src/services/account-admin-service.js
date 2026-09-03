'use strict';

const {
  AccountError,
  createAccount,
  getAccountById,
  listAccounts,
  updateAccount,
  setAccountPasswordHash,
  softDeleteAccount,
} = require('./account-service');
const {
  AccountPasswordError,
  hashAccountPassword,
} = require('./account-password-service');
const { effectiveAccountSections } = require('./account-section-service');

class AccountAdminError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AccountAdminError';
    this.code = code;
    this.status = status;
  }
}

function normalizeRequiredBoolean(value, fieldName, defaultValue) {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'boolean') {
    throw new AccountAdminError(
      'ACCOUNT_BOOLEAN_INVALID',
      `Il campo ${fieldName} deve essere booleano.`,
    );
  }
  return value;
}

function assertDifferentAccount(actorAccountId, targetAccountId, action) {
  if (actorAccountId && actorAccountId === targetAccountId) {
    throw new AccountAdminError(
      'ACCOUNT_SELF_OPERATION_FORBIDDEN',
      `Non puoi ${action} il tuo account amministratore da questa pagina.`,
      409,
    );
  }
}

function activeDeviceCounts(db) {
  const rows = db.prepare(`
    SELECT active_account_id AS accountId, COUNT(*) AS count
    FROM paired_devices
    WHERE revoked_at IS NULL
      AND active_account_id IS NOT NULL
      AND active_account_auth_version = (
        SELECT auth_version FROM accounts WHERE id = paired_devices.active_account_id
      )
    GROUP BY active_account_id
  `).all();
  return new Map(rows.map((row) => [row.accountId, Number(row.count || 0)]));
}

function accountAdminView(account, {
  currentAccountId = null,
  activeDeviceCount = 0,
} = {}) {
  if (!account) return null;
  return {
    id: account.id,
    username: account.username,
    role: account.role,
    sections: effectiveAccountSections(account, account.sections),
    passwordConfigured: Boolean(account.passwordHash),
    mustChangePassword: Boolean(account.mustChangePassword),
    disabled: Boolean(account.disabledAt),
    activeDeviceCount: Number(activeDeviceCount || 0),
    current: account.id === currentAccountId,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

function getManagedAccount(db, accountId, { currentAccountId = null } = {}) {
  const account = getAccountById(db, accountId);
  if (!account) throw new AccountAdminError('ACCOUNT_NOT_FOUND', 'Account non trovato.', 404);
  const counts = activeDeviceCounts(db);
  return accountAdminView(account, {
    currentAccountId,
    activeDeviceCount: counts.get(account.id) || 0,
  });
}

function listManagedAccounts(db, { currentAccountId = null } = {}) {
  const counts = activeDeviceCounts(db);
  return listAccounts(db).map((account) => accountAdminView(account, {
    currentAccountId,
    activeDeviceCount: counts.get(account.id) || 0,
  }));
}

async function createManagedAccount(db, {
  username,
  password,
  role = 'user',
  sections = [],
  mustChangePassword = true,
} = {}, { currentAccountId = null } = {}) {
  const requireChange = normalizeRequiredBoolean(
    mustChangePassword,
    'mustChangePassword',
    true,
  );
  const passwordHash = await hashAccountPassword(password);
  const account = createAccount(db, {
    username,
    passwordHash,
    role,
    sections,
    mustChangePassword: requireChange,
  });
  return accountAdminView(account, { currentAccountId, activeDeviceCount: 0 });
}

function clearAccountDeviceBindings(db, accountId) {
  const result = db.prepare(`
    UPDATE paired_devices SET
      active_account_id = NULL,
      active_account_auth_version = NULL,
      account_authenticated_at = NULL,
      account_binding_source = NULL
    WHERE active_account_id = ?
  `).run(accountId);
  return Number(result.changes || 0);
}

function updateManagedAccount(db, actorAccountId, accountId, {
  username,
  role,
  sections,
  disabled,
} = {}) {
  const current = getAccountById(db, accountId);
  if (!current) throw new AccountAdminError('ACCOUNT_NOT_FOUND', 'Account non trovato.', 404);

  if (actorAccountId === accountId) {
    if (role !== undefined && String(role).trim().toLowerCase() !== current.role) {
      throw new AccountAdminError(
        'ACCOUNT_SELF_OPERATION_FORBIDDEN',
        'Non puoi cambiare il ruolo del tuo account amministratore da questa pagina.',
        409,
      );
    }
    if (disabled === true) {
      throw new AccountAdminError(
        'ACCOUNT_SELF_OPERATION_FORBIDDEN',
        'Non puoi disabilitare il tuo account amministratore attivo.',
        409,
      );
    }
  }

  const updated = updateAccount(db, accountId, {
    username,
    role,
    sections,
    disabled,
  });
  if (Number(updated.authVersion) !== Number(current.authVersion)) {
    clearAccountDeviceBindings(db, accountId);
  }
  return getManagedAccount(db, accountId, { currentAccountId: actorAccountId });
}

async function resetManagedPassword(db, actorAccountId, accountId, {
  password,
  mustChangePassword = true,
} = {}) {
  assertDifferentAccount(actorAccountId, accountId, 'reimpostare la password del');
  const requireChange = normalizeRequiredBoolean(
    mustChangePassword,
    'mustChangePassword',
    true,
  );
  const snapshot = getAccountById(db, accountId);
  if (!snapshot) throw new AccountAdminError('ACCOUNT_NOT_FOUND', 'Account non trovato.', 404);
  const passwordHash = await hashAccountPassword(password);

  db.exec('BEGIN IMMEDIATE');
  try {
    const current = getAccountById(db, accountId);
    if (!current) throw new AccountAdminError('ACCOUNT_NOT_FOUND', 'Account non trovato.', 404);
    if (Number(current.authVersion) !== Number(snapshot.authVersion)) {
      throw new AccountAdminError(
        'ACCOUNT_CHANGED',
        'L’account è stato modificato durante il reset della password. Riprova.',
        409,
      );
    }
    const updated = setAccountPasswordHash(db, accountId, passwordHash, {
      mustChangePassword: requireChange,
    });
    clearAccountDeviceBindings(db, accountId);
    db.exec('COMMIT');
    return accountAdminView(updated, {
      currentAccountId: actorAccountId,
      activeDeviceCount: 0,
    });
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

function logoutManagedAccountDevices(db, actorAccountId, accountId) {
  assertDifferentAccount(actorAccountId, accountId, 'disconnettere tutti i dispositivi del');
  const account = getAccountById(db, accountId);
  if (!account) throw new AccountAdminError('ACCOUNT_NOT_FOUND', 'Account non trovato.', 404);
  return {
    account: accountAdminView(account, {
      currentAccountId: actorAccountId,
      activeDeviceCount: 0,
    }),
    loggedOutDevices: clearAccountDeviceBindings(db, accountId),
  };
}

function deleteManagedAccount(db, actorAccountId, accountId) {
  assertDifferentAccount(actorAccountId, accountId, 'eliminare');
  const current = getAccountById(db, accountId);
  if (!current) throw new AccountAdminError('ACCOUNT_NOT_FOUND', 'Account non trovato.', 404);

  db.exec('BEGIN IMMEDIATE');
  try {
    softDeleteAccount(db, accountId);
    const disconnectedDevices = clearAccountDeviceBindings(db, accountId);
    db.exec('COMMIT');
    return { deleted: true, accountId, disconnectedDevices };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

module.exports = {
  AccountAdminError,
  accountAdminView,
  getManagedAccount,
  listManagedAccounts,
  createManagedAccount,
  updateManagedAccount,
  resetManagedPassword,
  logoutManagedAccountDevices,
  deleteManagedAccount,
  clearAccountDeviceBindings,
  AccountError,
  AccountPasswordError,
};
