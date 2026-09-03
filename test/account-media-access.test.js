'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const {
  createMovieAccess,
  createReadingAccess,
} = require('../src/middleware/account-access');

function databaseFixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE movies (
      id INTEGER PRIMARY KEY,
      media_type TEXT NOT NULL
    );
    CREATE TABLE reading_items (
      id INTEGER PRIMARY KEY,
      category TEXT NOT NULL
    );
    INSERT INTO movies (id, media_type) VALUES
      (1, 'movie'),
      (2, 'series');
    INSERT INTO reading_items (id, category) VALUES
      (10, 'books'),
      (11, 'comics'),
      (12, 'manga');
  `);
  return db;
}

function invoke(middleware, {
  path = '/',
  query = {},
  role = 'user',
  sections = [],
} = {}) {
  const req = {
    path,
    query,
    baiaAccount: { id: 'account-1', role, sections },
  };
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

function assertAllowed(result) {
  assert.equal(result.nextCalled, true);
  assert.equal(result.nextError, null);
  assert.equal(result.payload, null);
}

function assertDenied(result, section) {
  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 403);
  assert.equal(result.payload.code, 'SECTION_ACCESS_DENIED');
  assert.equal(result.payload.section, section);
}

test('Film e Serie sono distinti anche quando condividono /api/movies', () => {
  const db = databaseFixture();
  const access = createMovieAccess({ database: db });

  assertAllowed(invoke(access, {
    path: '/',
    query: { type: 'movie' },
    sections: ['films'],
  }));
  assertDenied(invoke(access, {
    path: '/',
    query: { type: 'series' },
    sections: ['films'],
  }), 'series');

  assertAllowed(invoke(access, {
    path: '/1/stream',
    sections: ['films'],
  }));
  assertDenied(invoke(access, {
    path: '/2/stream',
    sections: ['films'],
  }), 'series');
  assertAllowed(invoke(access, {
    path: '/2/progress',
    sections: ['series'],
  }));
  assertDenied(invoke(access, {
    path: '/1/progress',
    sections: ['series'],
  }), 'films');
  assertDenied(invoke(access, {
    path: '/1/stream',
    query: {
      _baia_device: 'device',
      _baia_expires: '9999999999',
      _baia_signature: 'signature',
    },
    sections: ['series'],
  }), 'films');

  db.close();
});

test('il catalogo misto richiede entrambe le sezioni e Simili non espone film a Serie', () => {
  const db = databaseFixture();
  const access = createMovieAccess({ database: db });

  assertDenied(invoke(access, {
    path: '/',
    query: {},
    sections: ['films'],
  }), 'series');
  assertAllowed(invoke(access, {
    path: '/',
    query: { type: 'all' },
    sections: ['films', 'series'],
  }));
  assertDenied(invoke(access, {
    path: '/2/similar',
    sections: ['series'],
  }), 'films');
  assertAllowed(invoke(access, {
    path: '/2/similar',
    sections: ['films'],
  }));

  db.close();
});

test('Libri Fumetti e Manga vengono risolti dalla query o dall ID logico', () => {
  const db = databaseFixture();
  const access = createReadingAccess({ database: db });

  assertAllowed(invoke(access, {
    path: '/home',
    query: { category: 'books' },
    sections: ['books'],
  }));
  assertDenied(invoke(access, {
    path: '/home',
    query: { category: 'manga' },
    sections: ['books'],
  }), 'manga');
  assertAllowed(invoke(access, {
    path: '/11/file',
    sections: ['comics'],
  }));
  assertDenied(invoke(access, {
    path: '/12/cover',
    sections: ['comics'],
  }), 'manga');
  assertAllowed(invoke(access, {
    path: '/12/reader/entry/4',
    sections: ['manga'],
  }));

  db.close();
});

test('un amministratore supera tutti i controlli media', () => {
  const db = databaseFixture();
  const movieAccess = createMovieAccess({ database: db });
  const readingAccess = createReadingAccess({ database: db });

  assertAllowed(invoke(movieAccess, { path: '/', role: 'admin' }));
  assertAllowed(invoke(movieAccess, { path: '/2/stream', role: 'admin' }));
  assertAllowed(invoke(readingAccess, { path: '/12/file', role: 'admin' }));

  db.close();
});
