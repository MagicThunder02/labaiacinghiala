'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertPasswordChangeCompleted,
  assertAdminAccess,
  assertLocalAdminBrowserAccess,
  assertSectionAccess,
  requirePasswordChangeCompleted,
  requireAdmin,
  requireLocalAdminBrowser,
  requireSection,
} = require('../src/middleware/account-access');

function invoke(middleware, req) {
  const result = {
    nextCalled: false,
    nextError: null,
    statusCode: 200,
    payload: null,
  };
  const res = {
    status(value) {
      result.statusCode = value;
      return this;
    },
    json(value) {
      result.payload = value;
      return this;
    },
  };
  middleware(req, res, (error) => {
    result.nextCalled = true;
    result.nextError = error || null;
  });
  return result;
}

function account(role, sections = []) {
  return { id: `${role}-account`, role, sections };
}

test('un account normale accede soltanto alle sezioni assegnate', () => {
  const req = { baiaAccount: account('user', ['films', 'books']) };
  assert.equal(assertSectionAccess(req, 'films'), 'films');
  assert.equal(assertSectionAccess(req, 'books'), 'books');
  assert.throws(
    () => assertSectionAccess(req, 'music'),
    (error) => error.code === 'SECTION_ACCESS_DENIED'
      && error.status === 403
      && error.section === 'music',
  );

  const allowed = invoke(requireSection('films'), req);
  assert.equal(allowed.nextCalled, true);
  assert.equal(allowed.nextError, null);

  const denied = invoke(requireSection('music'), req);
  assert.equal(denied.nextCalled, false);
  assert.equal(denied.statusCode, 403);
  assert.deepEqual(denied.payload, {
    error: 'Il tuo account non può accedere alla sezione Musica.',
    code: 'SECTION_ACCESS_DENIED',
    section: 'music',
  });
});



test('il cambio password obbligatorio blocca ogni API applicativa con un errore stabile', () => {
  const pending = { baiaAccount: { ...account('admin', []), mustChangePassword: true } };
  assert.throws(
    () => assertPasswordChangeCompleted(pending),
    (error) => error.code === 'PASSWORD_CHANGE_REQUIRED' && error.status === 403,
  );

  const denied = invoke(requirePasswordChangeCompleted, pending);
  assert.equal(denied.nextCalled, false);
  assert.equal(denied.statusCode, 403);
  assert.deepEqual(denied.payload, {
    error: 'Devi impostare una nuova password prima di continuare.',
    code: 'PASSWORD_CHANGE_REQUIRED',
  });

  const allowed = invoke(requirePasswordChangeCompleted, {
    baiaAccount: { ...account('user', ['films']), mustChangePassword: false },
  });
  assert.equal(allowed.nextCalled, true);
  assert.equal(allowed.nextError, null);
});

test('un amministratore accede a tutte le sezioni anche senza righe esplicite', () => {
  const req = { baiaAccount: account('admin', []) };
  for (const section of ['films', 'series', 'music', 'books', 'comics', 'manga']) {
    assert.equal(assertSectionAccess(req, section), section);
  }
  assert.doesNotThrow(() => assertAdminAccess(req));
  assert.equal(invoke(requireAdmin, req).nextCalled, true);
});

test('gli inviti pairing richiedono insieme browser locale e ruolo amministratore', () => {
  const allowedReq = {
    baiaLocalAccess: true,
    baiaAccount: account('admin', []),
  };
  assert.doesNotThrow(() => assertLocalAdminBrowserAccess(allowedReq));
  assert.equal(invoke(requireLocalAdminBrowser, allowedReq).nextCalled, true);

  for (const req of [
    { baiaLocalAccess: false, baiaAccount: account('admin', []) },
    { baiaLocalAccess: true, baiaAccount: account('user', ['films']) },
    { baiaLocalAccess: true },
  ]) {
    const result = invoke(requireLocalAdminBrowser, req);
    assert.equal(result.nextCalled, false);
    assert.equal(result.statusCode, 403);
    assert.equal(result.payload.code, 'LOCAL_ADMIN_REQUIRED');
  }
});

test('le operazioni amministrative rifiutano gli account normali con un errore stabile', () => {
  const result = invoke(requireAdmin, { baiaAccount: account('user', ['films']) });
  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 403);
  assert.deepEqual(result.payload, {
    error: 'Questa operazione richiede un account amministratore.',
    code: 'ADMIN_REQUIRED',
  });
});

test('i controlli accesso non accettano una richiesta priva del principal account', () => {
  const result = invoke(requireSection('films'), {});
  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 401);
  assert.equal(result.payload.code, 'ACCOUNT_REQUIRED');
});
