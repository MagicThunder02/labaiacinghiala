'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function createEnvironment(root) {
  const library = path.join(root, 'media');
  const uploads = path.join(library, '.uploads');
  fs.mkdirSync(uploads, { recursive: true });
  return {
    ...process.env,
    DATABASE_PATH: path.join(root, 'media.sqlite'),
    DATABASE_BACKUPS_PATH: path.join(root, 'backups'),
    LIBRARY_PATH: library,
    METADATA_POSTER_CACHE_PATH: path.join(root, 'poster-cache'),
    METADATA_POSTERS_PATH: path.join(root, 'posters'),
    UPLOAD_TEMP_PATH: uploads,
  };
}

function runScript(root, script) {
  return spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: createEnvironment(root),
  });
}

function lastJson(stdout) {
  return JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
}

test('il percorso canonico multidisco usa Disco-Traccia senza cartelle aggiuntive', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-music-multidisc-'));
  const script = `
    const path = require('node:path');
    const config = require('./src/config');
    const { buildMusicStoragePlan } = require('./src/services/music-import-service');
    const plan = buildMusicStoragePlan({
      fileName: 'source.flac', extension: '.flac',
      tags: {
        title: 'Overture', artists: ['Example Artist'], album: 'Live',
        albumArtists: ['Example Artist'], trackNumber: 1, trackTotal: 12,
        discNumber: 2, discTotal: 2, compilation: false,
      },
    });
    console.log(JSON.stringify({
      fileName: plan.fileName,
      relativePath: plan.relativePath,
      albumDirectory: plan.albumDirectory,
      musicRoot: config.mediaPaths.music,
    }));
    require('./src/database').close();
  `;
  const result = runScript(root, script);
  assert.equal(result.status, 0, result.stderr);
  const payload = lastJson(result.stdout);
  assert.equal(payload.fileName, '2-01 Overture.flac');
  assert.equal(payload.relativePath, 'Musica/Example Artist/Live/2-01 Overture.flac');
  assert.equal(payload.albumDirectory, path.join(payload.musicRoot, 'Example Artist', 'Live'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('la scansione indicizza solo file conformi e non modifica il filesystem', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-music-scan-strict-'));
  const library = path.join(root, 'media');
  const music = path.join(library, 'Musica');
  const valid = path.join(music, 'Black Sabbath', 'Paranoid', '01 Iron Man.mp3');
  const invalid = path.join(music, 'cartella casuale', 'brano.mp3');
  const cover = path.join(music, 'Black Sabbath', 'Paranoid', 'cover.jpg');
  fs.mkdirSync(path.dirname(valid), { recursive: true });
  fs.mkdirSync(path.dirname(invalid), { recursive: true });
  fs.writeFileSync(valid, 'valid-audio');
  fs.writeFileSync(invalid, 'invalid-audio');
  fs.writeFileSync(cover, 'cover');

  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const db = require('./src/database');
    const { scanMusicLibrary } = require('./src/services/music-library-scan-service');
    const metadataReader = async (filePath) => ({
      fileName: path.basename(filePath), extension: '.mp3', format: 'mp3', hasCoverArt: false,
      tags: {
        title: 'Iron Man', artists: ['Black Sabbath'], album: 'Paranoid',
        albumArtists: ['Black Sabbath'], genres: ['Heavy Metal'], composers: [],
        comment: '', date: '1970', year: 1970, trackNumber: 1, trackTotal: 8,
        discNumber: 1, discTotal: 1, compilation: false,
      },
      properties: { durationSeconds: 355, durationMs: 355000 },
    });
    (async () => {
      const report = await scanMusicLibrary({ metadataReader });
      const rows = db.prepare('SELECT relative_path AS relativePath, available FROM music_tracks').all();
      console.log(JSON.stringify({
        report,
        rows,
        validExists: fs.existsSync(${JSON.stringify(valid)}),
        invalidExists: fs.existsSync(${JSON.stringify(invalid)}),
        coverExists: fs.existsSync(${JSON.stringify(cover)}),
      }));
      db.close();
    })().catch((error) => { console.error(error); db.close(); process.exitCode = 1; });
  `;

  const result = runScript(root, script);
  assert.equal(result.status, 0, result.stderr);
  const payload = lastJson(result.stdout);
  assert.equal(payload.report.counts.visited, 3);
  assert.equal(payload.report.counts.supported, 2);
  assert.equal(payload.report.counts.created, 1);
  assert.equal(payload.report.counts.ignored, 2);
  assert.equal(payload.report.counts.errors, 0);
  assert.deepEqual(payload.rows, [{ relativePath: 'Musica/Black Sabbath/Paranoid/01 Iron Man.mp3', available: 1 }]);
  assert.equal(payload.validExists, true);
  assert.equal(payload.invalidExists, true);
  assert.equal(payload.coverExists, true);
  assert.ok(payload.report.issues.some((issue) => issue.code === 'MUSIC_LIBRARY_SCAN_NON_CANONICAL_PATH'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('la scansione aggiorna, riattiva e marca come mancanti senza cambiare gli UUID', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-music-scan-reconcile-'));
  const music = path.join(root, 'media', 'Musica', 'Artist', 'Album');
  const first = path.join(music, '01 First.mp3');
  const second = path.join(music, '02 Second.mp3');
  const third = path.join(music, '03 Third.mp3');
  fs.mkdirSync(music, { recursive: true });
  fs.writeFileSync(first, 'first');
  fs.writeFileSync(second, 'second');
  fs.writeFileSync(third, 'third');

  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const db = require('./src/database');
    const { scanMusicLibrary } = require('./src/services/music-library-scan-service');
    const metadataReader = async (filePath) => {
      const number = Number(path.basename(filePath).slice(0, 2));
      const titles = { 1: 'First', 2: 'Second', 3: 'Third' };
      return {
        fileName: path.basename(filePath), extension: '.mp3', format: 'mp3', hasCoverArt: false,
        tags: {
          title: titles[number], artists: ['Artist'], album: 'Album', albumArtists: ['Artist'],
          genres: [], composers: [], trackNumber: number, trackTotal: 3,
          discNumber: 1, discTotal: 1, compilation: false,
        },
        properties: { durationSeconds: 100 + number, durationMs: (100 + number) * 1000 },
      };
    };
    (async () => {
      await scanMusicLibrary({ metadataReader });
      const before = db.prepare('SELECT track_uuid AS trackUuid, file_path AS filePath FROM music_tracks ORDER BY track_number').all();
      fs.appendFileSync(${JSON.stringify(first)}, '-changed');
      const future = new Date(Date.now() + 2000);
      fs.utimesSync(${JSON.stringify(first)}, future, future);
      fs.unlinkSync(${JSON.stringify(second)});
      db.prepare('UPDATE music_tracks SET available = 0 WHERE relative_path = ?').run('Musica/Artist/Album/03 Third.mp3');
      const report = await scanMusicLibrary({ metadataReader });
      const after = db.prepare('SELECT track_uuid AS trackUuid, file_path AS filePath, available FROM music_tracks ORDER BY track_number').all();
      console.log(JSON.stringify({ before, report, after }));
      db.close();
    })().catch((error) => { console.error(error); db.close(); process.exitCode = 1; });
  `;

  const result = runScript(root, script);
  assert.equal(result.status, 0, result.stderr);
  const payload = lastJson(result.stdout);
  assert.equal(payload.report.counts.updated, 1);
  assert.equal(payload.report.counts.reactivated, 1);
  assert.equal(payload.report.counts.missing, 1);
  assert.deepEqual(payload.after.map((row) => row.trackUuid), payload.before.map((row) => row.trackUuid));
  assert.deepEqual(payload.after.map((row) => row.available), [1, 0, 1]);
  fs.rmSync(root, { recursive: true, force: true });
});
