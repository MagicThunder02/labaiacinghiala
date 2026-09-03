'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function createEnvironment(root) {
  const library = path.join(root, 'media');
  fs.mkdirSync(library, { recursive: true });
  return {
    ...process.env,
    DATABASE_PATH: path.join(root, 'media.sqlite'),
    DATABASE_BACKUPS_PATH: path.join(root, 'backups'),
    LIBRARY_PATH: library,
    METADATA_POSTER_CACHE_PATH: path.join(root, 'poster-cache'),
    METADATA_POSTERS_PATH: path.join(root, 'posters'),
    UPLOAD_TEMP_PATH: path.join(library, '.uploads'),
  };
}

test('stream musica usa UUID logici, MIME sicuro e HTTP Range senza esporre path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-music-stream-'));
  const script = String.raw`
    const fs = require('node:fs');
    const path = require('node:path');
    const { Writable } = require('node:stream');
    const { once } = require('node:events');
    const db = require('./src/database');

    const albumDirectory = path.join(process.env.LIBRARY_PATH, 'Musica', 'Artista', 'Album');
    fs.mkdirSync(albumDirectory, { recursive: true });
    const filePath = path.join(albumDirectory, '01 Brano.mp3');
    fs.writeFileSync(filePath, Buffer.from('0123456789', 'ascii'));
    const stats = fs.statSync(filePath);
    const albumId = Number(db.prepare(
      'INSERT INTO music_albums (album_uuid, title, directory_path, relative_path) VALUES (?, ?, ?, ?)'
    ).run('123e4567-e89b-42d3-a456-426614174100', 'Album', albumDirectory, path.relative(process.env.LIBRARY_PATH, albumDirectory)).lastInsertRowid);
    db.prepare(
      'INSERT INTO music_tracks (track_uuid, album_id, file_path, relative_path, file_name, title, extension, mime_type, size_bytes, modified_at, available) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)'
    ).run(
      '123e4567-e89b-42d3-a456-426614174000',
      albumId,
      filePath,
      path.relative(process.env.LIBRARY_PATH, filePath),
      '01 Brano.mp3',
      'Brano',
      '.mp3',
      'text/html',
      stats.size,
      Math.trunc(stats.mtimeMs),
    );

    const { resolveMusicTrackStream, sendMusicTrackStream } = require('./src/services/music-stream-service');

    class MockResponse extends Writable {
      constructor() {
        super();
        this.statusCode = 200;
        this.headers = {};
        this.chunks = [];
        this.jsonPayload = null;
      }
      _write(chunk, encoding, callback) {
        this.chunks.push(Buffer.from(chunk));
        callback();
      }
      status(code) { this.statusCode = code; return this; }
      set(name, value) {
        if (typeof name === 'object') Object.assign(this.headers, name);
        else this.headers[name] = value;
        return this;
      }
      writeHead(code, headers) {
        this.statusCode = code;
        Object.assign(this.headers, headers || {});
        return this;
      }
      json(payload) {
        this.jsonPayload = payload;
        this.set('Content-Type', 'application/json');
        this.end(JSON.stringify(payload));
        return this;
      }
    }

    async function request(method, range, trackId = '123e4567-e89b-42d3-a456-426614174000') {
      const req = { method, headers: range ? { range } : {} };
      const res = new MockResponse();
      const failure = [];
      const result = sendMusicTrackStream(req, res, (error) => failure.push(error), trackId);
      await Promise.resolve(result);
      if (!res.writableFinished) await once(res, 'finish');
      if (failure.length) throw failure[0];
      return {
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(res.chunks).toString('ascii'),
        jsonPayload: res.jsonPayload,
      };
    }

    (async () => {
      const resolved = await resolveMusicTrackStream('123e4567-e89b-42d3-a456-426614174000');
      const range = await request('GET', 'bytes=2-5');
      const head = await request('HEAD');
      const invalid = await request('GET', 'bytes=99-120');
      const missing = await request('GET', null, '123e4567-e89b-42d3-a456-426614174999');
      console.log(JSON.stringify({
        resolved: {
          fileName: resolved.fileName,
          mimeType: resolved.mimeType,
          size: resolved.size,
          hasAbsolutePathInternally: path.isAbsolute(resolved.filePath),
        },
        range,
        head,
        invalid,
        missing,
      }));
      db.close();
    })().catch((error) => {
      console.error(error);
      try { db.close(); } catch {}
      process.exitCode = 1;
    });
  `;

  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: createEnvironment(root),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  assert.deepEqual(payload.resolved, {
    fileName: '01 Brano.mp3',
    mimeType: 'audio/mpeg',
    size: 10,
    hasAbsolutePathInternally: true,
  });
  assert.equal(payload.range.statusCode, 206);
  assert.equal(payload.range.body, '2345');
  assert.equal(payload.range.headers['Accept-Ranges'], 'bytes');
  assert.equal(payload.range.headers['Content-Range'], 'bytes 2-5/10');
  assert.equal(payload.range.headers['Content-Length'], 4);
  assert.equal(payload.range.headers['Content-Type'], 'audio/mpeg');
  assert.equal(payload.range.headers['X-Content-Type-Options'], 'nosniff');

  assert.equal(payload.head.statusCode, 200);
  assert.equal(payload.head.body, '');
  assert.equal(payload.head.headers['Content-Length'], 10);

  assert.equal(payload.invalid.statusCode, 416);
  assert.equal(payload.invalid.headers['Content-Range'], 'bytes */10');
  assert.equal(payload.missing.statusCode, 404);
  assert.equal(payload.missing.jsonPayload.error, 'Brano non disponibile.');

  const serialized = JSON.stringify({ range: payload.range, head: payload.head, missing: payload.missing });
  assert.equal(serialized.includes(root), false);
  fs.rmSync(root, { recursive: true, force: true });
});
