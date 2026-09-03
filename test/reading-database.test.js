const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('migrazione schema crea reading_items e reading_bookmarks in modo additivo', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-reading-db-'));
  const library = path.join(root, 'media');
  fs.mkdirSync(library, { recursive: true });
  const script = `
    const db = require('./src/database');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('movies','series','reading_items','reading_bookmarks') ORDER BY name").all().map((row) => row.name);
    const version = Number(db.prepare('PRAGMA user_version').get().user_version);
    console.log(JSON.stringify({ tables, version }));
    db.close();
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_PATH: path.join(root, 'media.sqlite'),
      DATABASE_BACKUPS_PATH: path.join(root, 'backups'),
      LIBRARY_PATH: library,
      METADATA_POSTER_CACHE_PATH: path.join(root, 'poster-cache'),
      METADATA_POSTERS_PATH: path.join(root, 'posters'),
      UPLOAD_TEMP_PATH: path.join(library, '.uploads'),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = result.stdout.trim().split(/\r?\n/).at(-1);
  const payload = JSON.parse(output);
  assert.equal(payload.version, 19);
  assert.deepEqual(payload.tables, ['movies', 'reading_bookmarks', 'reading_items', 'series']);
  fs.rmSync(root, { recursive: true, force: true });
});
