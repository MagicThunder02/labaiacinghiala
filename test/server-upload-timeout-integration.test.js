'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');

const longUpload = process.env.BAIA_LONG_UPLOAD_TEST === '1';
const durationMs = longUpload ? 335_000 : 0;

test(`server reale: upload salvato integro${longUpload ? ' dopo oltre cinque minuti' : ''}`, {
  timeout: durationMs + 30_000,
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'baia-upload-http-'));
  const library = path.join(root, 'library');
  await fs.mkdir(library);
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    windowsHide: true,
    env: {
      ...process.env,
      HOST: '127.0.0.1', PORT: String(port), VERIFY_LIBRARY_ON_START: 'false',
      LIBRARY_PATH: library,
      UPLOAD_TEMP_PATH: path.join(library, '.uploads'),
      DATABASE_PATH: path.join(root, 'media.sqlite'),
      DATABASE_BACKUPS_PATH: path.join(root, 'backups'),
      METADATA_POSTER_CACHE_PATH: path.join(root, 'poster-cache'),
      MUSIC_COVER_CACHE_PATH: path.join(root, 'music-cache'),
      METADATA_POSTERS_PATH: path.join(root, 'posters'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    // root is exclusively the directory created by mkdtemp for this test.
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const origin = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      ready = (await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(500) })).ok;
      if (ready) break;
    } catch {}
    if (child.exitCode !== null) break;
    await delay(100);
  }
  assert.ok(ready, logs);

  // Complete bootstrap only in this disposable database; production auth runs
  // unchanged and still verifies local browser context and admin permissions.
  const fixtureDb = new DatabaseSync(path.join(root, 'media.sqlite'));
  try {
    fixtureDb.prepare("UPDATE accounts SET must_change_password = 0 WHERE account_key = 'default'").run();
  } finally {
    fixtureDb.close();
  }

  // A synthetic video payload checks transport/storage integrity, not decoding.
  const video = Buffer.alloc(1024 * 1024, 0x42);
  const poster = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  );
  const form = new FormData();
  form.set('title', 'Timeout regression');
  form.set('director', 'Test');
  form.set('year', '2026');
  form.set('genre', 'Documentario');
  form.set('poster', new Blob([poster], { type: 'image/png' }), 'poster.png');
  form.set('video', new Blob([video], { type: 'video/mp4' }), 'test.mp4');
  const encoded = new Request(origin, { method: 'POST', body: form });
  const body = Buffer.from(await encoded.arrayBuffer());
  let request;
  const responsePromise = new Promise((resolve, reject) => {
    request = http.request(`${origin}/api/uploads/movies`, {
      method: 'POST', agent: false,
      headers: {
        Origin: origin,
        'Sec-Fetch-Site': 'same-origin',
        'Content-Type': encoded.headers.get('content-type'),
        'Content-Length': body.length,
      },
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, text }));
    });
    request.on('error', reject);
  });
  t.after(() => request.destroy());
  const started = Date.now();
  const send = async () => {
    const chunks = longUpload ? 68 : 4;
    const chunkSize = Math.ceil(body.length / chunks);
    for (let index = 0; index < chunks; index += 1) {
      if (index > 0) await delay(longUpload ? 5000 : 10);
      if (request.destroyed) break;
      request.write(body.subarray(index * chunkSize, (index + 1) * chunkSize));
    }
    request.end();
  };
  const [response] = await Promise.all([responsePromise, send()]);
  assert.equal(response.status, 201, `${response.text}\n${logs}`);
  const result = JSON.parse(response.text);
  const saved = await fs.readFile(path.join(library, result.movie.relativePath));
  assert.deepEqual(saved, video);
  assert.deepEqual(await fs.readdir(path.join(library, '.uploads')), []);
  if (longUpload) assert.ok(Date.now() - started >= 335_000);
  t.diagnostic(`Upload HTTP ${response.status}, file integro, temporanei puliti; durata ${Date.now() - started} ms.`);
});
