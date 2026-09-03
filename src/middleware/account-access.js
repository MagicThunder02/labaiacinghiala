'use strict';

const {
  effectiveAccountSections,
  normalizeSectionKey,
} = require('../services/account-section-service');

const READING_SECTION_KEYS = Object.freeze(['books', 'comics', 'manga']);

const SECTION_LABELS = Object.freeze({
  films: 'Film',
  series: 'Serie',
  music: 'Musica',
  books: 'Libri',
  comics: 'Fumetti',
  manga: 'Manga',
});

class AccountAccessError extends Error {
  constructor(code, message, status = 403, details = {}) {
    super(message);
    this.name = 'AccountAccessError';
    this.code = code;
    this.status = status;
    Object.assign(this, details);
  }
}

function accountSectionSet(req) {
  if (!req.baiaAccount) {
    throw new AccountAccessError(
      'ACCOUNT_REQUIRED',
      'Effettua l’accesso con un account Baia.',
      401,
    );
  }
  return new Set(effectiveAccountSections(req.baiaAccount, req.baiaAccount.sections));
}

function assertSectionAccess(req, sectionKey) {
  const normalized = normalizeSectionKey(sectionKey);
  if (accountSectionSet(req).has(normalized)) return normalized;
  throw new AccountAccessError(
    'SECTION_ACCESS_DENIED',
    `Il tuo account non può accedere alla sezione ${SECTION_LABELS[normalized]}.`,
    403,
    { section: normalized },
  );
}

function assertAllSectionsAccess(req, sectionKeys) {
  for (const sectionKey of sectionKeys) assertSectionAccess(req, sectionKey);
}

function assertPasswordChangeCompleted(req) {
  if (!req.baiaAccount) {
    throw new AccountAccessError(
      'ACCOUNT_REQUIRED',
      'Effettua l’accesso con un account Baia.',
      401,
    );
  }
  if (!req.baiaAccount.mustChangePassword) return;
  throw new AccountAccessError(
    'PASSWORD_CHANGE_REQUIRED',
    'Devi impostare una nuova password prima di continuare.',
    403,
  );
}

function assertAdminAccess(req) {
  if (req.baiaAccount?.role === 'admin') return;
  throw new AccountAccessError(
    'ADMIN_REQUIRED',
    'Questa operazione richiede un account amministratore.',
    403,
  );
}

function assertLocalAdminBrowserAccess(req) {
  if (req.baiaLocalAccess === true && req.baiaAccount?.role === 'admin') return;
  throw new AccountAccessError(
    'LOCAL_ADMIN_REQUIRED',
    'Questa operazione è disponibile soltanto dal browser sul PC server.',
    403,
  );
}

function sendAccountAccessError(res, error) {
  return res.status(error.status || 403).json({
    error: error.message,
    code: error.code,
    ...(error.section ? { section: error.section } : {}),
  });
}

function accessMiddleware(check) {
  return function accountAccess(req, res, next) {
    try {
      check(req);
      return next();
    } catch (error) {
      if (!(error instanceof AccountAccessError)) return next(error);
      return sendAccountAccessError(res, error);
    }
  };
}

function requireSection(sectionKey) {
  const normalized = normalizeSectionKey(sectionKey);
  return accessMiddleware((req) => assertSectionAccess(req, normalized));
}

const passwordChangeAccessMiddleware = accessMiddleware(assertPasswordChangeCompleted);
const adminAccessMiddleware = accessMiddleware(assertAdminAccess);
const localAdminBrowserAccessMiddleware = accessMiddleware(assertLocalAdminBrowserAccess);

function requirePasswordChangeCompleted(req, res, next) {
  return passwordChangeAccessMiddleware(req, res, next);
}

function requireAdmin(req, res, next) {
  return adminAccessMiddleware(req, res, next);
}

function requireLocalAdminBrowser(req, res, next) {
  return localAdminBrowserAccessMiddleware(req, res, next);
}

function relativePath(req) {
  const value = String(req.path || req.url || '/').split('?', 1)[0];
  if (!value) return '/';
  return value.startsWith('/') ? value : `/${value}`;
}

function requestedMovieListSections(req) {
  const type = String(req.query?.type || 'all').trim().toLowerCase();
  if (type === 'movie') return ['films'];
  if (type === 'series') return ['series'];
  return ['films', 'series'];
}

function mediaTypeSection(mediaType) {
  if (mediaType === 'movie') return 'films';
  if (mediaType === 'series') return 'series';
  return null;
}

function createMovieAccess({ database } = {}) {
  if (!database) throw new TypeError('Database richiesto per il controllo accessi Film/Serie.');
  const getMediaType = database.prepare(`
    SELECT media_type AS mediaType
    FROM movies
    WHERE id = ?
    LIMIT 1
  `);

  return accessMiddleware((req) => {
    const path = relativePath(req);
    if (path === '/filters' || path === '/home') {
      assertSectionAccess(req, 'films');
      return;
    }
    if (path === '/') {
      assertAllSectionsAccess(req, requestedMovieListSections(req));
      return;
    }

    const resource = path.match(/^\/(\d+)(?:\/|$)/);
    if (!resource) return;

    // "Simili" è un catalogo esclusivamente cinematografico anche se viene
    // invocato con un ID non coerente: non deve esporre film a un account Serie.
    if (/^\/\d+\/similar\/?$/.test(path)) {
      assertSectionAccess(req, 'films');
      return;
    }

    const section = mediaTypeSection(getMediaType.get(resource[1])?.mediaType);
    if (section) assertSectionAccess(req, section);
  });
}

function createReadingAccess({ database } = {}) {
  if (!database) throw new TypeError('Database richiesto per il controllo accessi Reading.');
  const getCategory = database.prepare(`
    SELECT category
    FROM reading_items
    WHERE id = ?
    LIMIT 1
  `);

  return accessMiddleware((req) => {
    const path = relativePath(req);
    if (path === '/' || path === '/filters' || path === '/home') {
      const category = String(req.query?.category || '').trim().toLowerCase();
      if (READING_SECTION_KEYS.includes(category)) {
        assertSectionAccess(req, category);
      }
      return;
    }

    const resource = path.match(/^\/(\d+)(?:\/|$)/);
    if (!resource) return;
    const category = String(getCategory.get(resource[1])?.category || '').trim().toLowerCase();
    if (READING_SECTION_KEYS.includes(category)) assertSectionAccess(req, category);
  });
}

module.exports = {
  READING_SECTION_KEYS,
  SECTION_LABELS,
  AccountAccessError,
  accountSectionSet,
  assertSectionAccess,
  assertAllSectionsAccess,
  assertPasswordChangeCompleted,
  assertAdminAccess,
  assertLocalAdminBrowserAccess,
  sendAccountAccessError,
  requireSection,
  requirePasswordChangeCompleted,
  requireAdmin,
  requireLocalAdminBrowser,
  requestedMovieListSections,
  mediaTypeSection,
  createMovieAccess,
  createReadingAccess,
};
