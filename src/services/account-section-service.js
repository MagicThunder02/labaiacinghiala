'use strict';

const SECTION_KEYS = Object.freeze([
  'films',
  'series',
  'music',
  'books',
  'comics',
  'manga',
]);
const SECTION_KEY_SET = new Set(SECTION_KEYS);

class AccountSectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AccountSectionError';
    this.code = code;
  }
}

function normalizeSectionKey(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!SECTION_KEY_SET.has(normalized)) {
    throw new AccountSectionError('SECTION_INVALID', 'Sezione account non valida.');
  }
  return normalized;
}

function normalizeSectionKeys(values) {
  if (!Array.isArray(values)) {
    throw new AccountSectionError('SECTIONS_INVALID', 'L’elenco delle sezioni deve essere un array.');
  }
  return [...new Set(values.map(normalizeSectionKey))]
    .sort((left, right) => SECTION_KEYS.indexOf(left) - SECTION_KEYS.indexOf(right));
}

function getAccountSections(db, accountId) {
  return db.prepare(`
    SELECT section_key AS sectionKey
    FROM account_section_access
    WHERE account_id = ?
    ORDER BY CASE section_key
      WHEN 'films' THEN 1
      WHEN 'series' THEN 2
      WHEN 'music' THEN 3
      WHEN 'books' THEN 4
      WHEN 'comics' THEN 5
      WHEN 'manga' THEN 6
      ELSE 99
    END
  `).all(accountId).map((row) => row.sectionKey);
}

function replaceAccountSections(db, accountId, sectionKeys) {
  const normalized = normalizeSectionKeys(sectionKeys);
  const account = db.prepare('SELECT id FROM accounts WHERE id = ? LIMIT 1').get(accountId);
  if (!account) {
    throw new AccountSectionError('ACCOUNT_NOT_FOUND', 'Account non trovato.');
  }

  db.exec('SAVEPOINT baia_account_sections');
  try {
    db.prepare('DELETE FROM account_section_access WHERE account_id = ?').run(accountId);
    const insert = db.prepare(`
      INSERT INTO account_section_access (account_id, section_key)
      VALUES (?, ?)
    `);
    for (const sectionKey of normalized) insert.run(accountId, sectionKey);
    db.exec('RELEASE SAVEPOINT baia_account_sections');
  } catch (error) {
    try { db.exec('ROLLBACK TO SAVEPOINT baia_account_sections'); } catch {}
    try { db.exec('RELEASE SAVEPOINT baia_account_sections'); } catch {}
    throw error;
  }
  return normalized;
}

function effectiveAccountSections(account, storedSections = []) {
  return account?.role === 'admin'
    ? [...SECTION_KEYS]
    : normalizeSectionKeys(storedSections);
}

module.exports = {
  SECTION_KEYS,
  AccountSectionError,
  normalizeSectionKey,
  normalizeSectionKeys,
  getAccountSections,
  replaceAccountSections,
  effectiveAccountSections,
};
