'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const {
  LIBRARY_IDENTITY_FILE,
  ensureLibraryIdentity,
  LibraryIdentityError,
} = require('../src/services/library-identity-service');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-library-identity-'));
  const library = path.join(root, 'media');
  fs.mkdirSync(library, { recursive: true });
  const database = new DatabaseSync(path.join(root, 'media.sqlite'));
  database.exec(`
    CREATE TABLE library_identity (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      library_id TEXT NOT NULL UNIQUE,
      format_version INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  return { root, library, database, markerPath: path.join(library, LIBRARY_IDENTITY_FILE) };
}

function cleanup(value) {
  try { value.database.close(); } catch {}
  fs.rmSync(value.root, { recursive: true, force: true });
}

test('prima inizializzazione crea la stessa identità nel database e nella libreria', async () => {
  const value = fixture();
  try {
    const identity = await ensureLibraryIdentity({ database: value.database, libraryRoot: value.library });
    assert.equal(identity.initialized, true);
    assert.match(identity.libraryId, /^[0-9a-f-]{36}$/i);

    const marker = JSON.parse(fs.readFileSync(value.markerPath, 'utf8'));
    const row = value.database.prepare(`
      SELECT library_id AS libraryId, format_version AS formatVersion
      FROM library_identity WHERE singleton_id = 1
    `).get();
    assert.deepEqual(marker, { libraryId: identity.libraryId, formatVersion: 1 });
    assert.deepEqual({ ...row }, { libraryId: identity.libraryId, formatVersion: 1 });

    const second = await ensureLibraryIdentity({ database: value.database, libraryRoot: value.library });
    assert.equal(second.initialized, false);
    assert.equal(second.libraryId, identity.libraryId);
  } finally {
    cleanup(value);
  }
});

test('blocca una cartella media appartenente a un altro database', async () => {
  const value = fixture();
  try {
    const databaseId = crypto.randomUUID();
    const libraryId = crypto.randomUUID();
    value.database.prepare(`
      INSERT INTO library_identity (singleton_id, library_id, format_version)
      VALUES (1, ?, 1)
    `).run(databaseId);
    fs.writeFileSync(value.markerPath, JSON.stringify({ libraryId, formatVersion: 1 }));

    await assert.rejects(
      ensureLibraryIdentity({ database: value.database, libraryRoot: value.library }),
      (error) => {
        assert.ok(error instanceof LibraryIdentityError);
        assert.equal(error.code, 'LIBRARY_IDENTITY_MISMATCH');
        assert.match(error.message, new RegExp(databaseId));
        assert.match(error.message, new RegExp(libraryId));
        assert.match(error.message, /Avvio bloccato/);
        return true;
      },
    );
  } finally {
    cleanup(value);
  }
});

test('non ricrea automaticamente un marcatore mancante', async () => {
  const value = fixture();
  try {
    value.database.prepare(`
      INSERT INTO library_identity (singleton_id, library_id, format_version)
      VALUES (1, ?, 1)
    `).run(crypto.randomUUID());
    await assert.rejects(
      ensureLibraryIdentity({ database: value.database, libraryRoot: value.library }),
      (error) => error.code === 'LIBRARY_MARKER_MISSING',
    );
    assert.equal(fs.existsSync(value.markerPath), false);
  } finally {
    cleanup(value);
  }
});

test('non adotta automaticamente una libreria già associata', async () => {
  const value = fixture();
  try {
    fs.writeFileSync(value.markerPath, JSON.stringify({ libraryId: crypto.randomUUID(), formatVersion: 1 }));
    await assert.rejects(
      ensureLibraryIdentity({ database: value.database, libraryRoot: value.library }),
      (error) => error.code === 'DATABASE_IDENTITY_MISSING',
    );
    const count = value.database.prepare('SELECT COUNT(*) AS count FROM library_identity').get().count;
    assert.equal(Number(count), 0);
  } finally {
    cleanup(value);
  }
});

test('rifiuta un marcatore corrotto o trasformato in collegamento', async (t) => {
  const value = fixture();
  try {
    fs.writeFileSync(value.markerPath, '{non-json');
    await assert.rejects(
      ensureLibraryIdentity({ database: value.database, libraryRoot: value.library }),
      (error) => error.code === 'INVALID_LIBRARY_MARKER',
    );

    fs.rmSync(value.markerPath, { force: true });
    const target = path.join(value.root, 'external-marker.json');
    fs.writeFileSync(target, JSON.stringify({ libraryId: crypto.randomUUID(), formatVersion: 1 }));
    try {
      fs.symlinkSync(target, value.markerPath, 'file');
    } catch (error) {
      if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) {
        t.skip(`collegamenti simbolici non disponibili: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      ensureLibraryIdentity({ database: value.database, libraryRoot: value.library }),
      (error) => error.code === 'INVALID_LIBRARY_MARKER',
    );
  } finally {
    cleanup(value);
  }
});
