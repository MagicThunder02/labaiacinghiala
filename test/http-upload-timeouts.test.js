'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const express = require('express');
const multer = require('multer');
const { configureHttpTimeouts, allowLongUpload } = require('../src/http-timeouts');

const boundary = 'baia-upload-timeout-regression';
const multipartStart = Buffer.from(
  `--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="sample.mp4"\r\n`
  + 'Content-Type: video/mp4\r\n\r\n',
);
const multipartEnd = Buffer.from(`\r\n--${boundary}--\r\n`);

async function until(predicate, message, timeoutMs = 3000) {
  const started = Date.now();
  while (!(await predicate())) {
    assert.ok(Date.now() - started < timeoutMs, message);
    await delay(20);
  }
}

async function createFixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'baia-upload-timeouts-'));
  const app = express();
  const multipart = multer({ dest: directory }).single('video');
  const uploads = [];
  const uploadErrors = [];
  let ordinaryCompleted = 0;

  app.post('/upload', (req, res) => {
    if (req.headers['x-test-admin'] !== 'yes') {
      res.status(403).end();
      return;
    }
    allowLongUpload(req);
    multipart(req, res, async (error) => {
      if (error) {
        uploadErrors.push(error);
        if (!res.destroyed) res.status(400).end();
        return;
      }
      try {
        uploads.push(await fs.readFile(req.file.path));
        await fs.rm(req.file.path);
        if (options.processingDelayMs) await delay(options.processingDelayMs);
        res.status(201).end('uploaded');
      } catch (failure) {
        uploadErrors.push(failure);
        if (!res.destroyed) res.status(500).end();
      }
    });
  });

  app.post('/ordinary', (req, res) => {
    req.on('error', () => {});
    req.on('data', () => {});
    req.on('end', () => {
      ordinaryCompleted += 1;
      res.status(200).end('received');
    });
  });
  app.get('/health', (req, res) => res.end('ok'));
  app.post('/empty-processing', async (req, res) => {
    await delay(options.processingDelayMs || 0);
    res.end('processed');
  });

  const server = http.createServer({ connectionsCheckingInterval: 20 }, app);
  configureHttpTimeouts(server, {
    requestTimeoutMs: options.requestTimeoutMs ?? 300,
    uploadIdleTimeoutMs: options.uploadIdleTimeoutMs ?? 500,
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    port: server.address().port,
    directory,
    uploads,
    uploadErrors,
    ordinaryCompleted: () => ordinaryCompleted,
  };
}

function requestTo(fixture, route, { headers = {}, agent = false } = {}) {
  let request;
  const result = new Promise((resolve) => {
    request = http.request({
      hostname: '127.0.0.1',
      port: fixture.port,
      path: route,
      method: 'POST',
      agent,
      headers,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString(),
      }));
      response.on('error', (error) => resolve({ error }));
    });
    request.on('error', (error) => resolve({ error }));
  });
  return { request, result };
}

function uploadTo(fixture, payloadLength, options = {}) {
  return requestTo(fixture, '/upload', {
    ...options,
    headers: {
      'x-test-admin': 'yes',
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': multipartStart.length + payloadLength + multipartEnd.length,
      ...options.headers,
    },
  });
}

async function waitForPartialFile(fixture) {
  await until(async () => {
    const files = await fs.readdir(fixture.directory);
    if (files.length !== 1) return false;
    return (await fs.stat(path.join(fixture.directory, files[0]))).size > 0;
  }, 'Multer must have written a partial file before cancellation');
}

test('active multipart upload outlives the ordinary request deadline without losing bytes', { timeout: 10000 }, async (t) => {
  const fixture = await createFixture(t);
  const chunks = Array.from({ length: 16 }, (_, index) => Buffer.alloc(4096, index));
  const expected = Buffer.concat(chunks);
  const { request, result } = uploadTo(fixture, expected.length);
  request.write(multipartStart);
  for (const chunk of chunks) {
    request.write(chunk);
    await delay(45);
  }
  request.end(multipartEnd);

  assert.deepEqual(await result, { status: 201, body: 'uploaded' });
  assert.deepEqual(fixture.uploads, [expected]);
  assert.deepEqual(fixture.uploadErrors, []);
  assert.deepEqual(await fs.readdir(fixture.directory), []);
});

test('stalled multipart upload closes and removes its partial file', { timeout: 10000 }, async (t) => {
  const fixture = await createFixture(t);
  const { request, result } = uploadTo(fixture, 1024 * 1024);
  request.write(multipartStart);
  request.write(Buffer.alloc(4096, 7));
  await waitForPartialFile(fixture);

  const outcome = await result;
  assert.equal(outcome.status, 408);
  assert.equal(JSON.parse(outcome.body).code, 'UPLOAD_IDLE_TIMEOUT');
  await until(async () => fixture.uploadErrors.length === 1
    && (await fs.readdir(fixture.directory)).length === 0,
    'stalled upload left a partial file');
  assert.equal(fixture.uploads.length, 0);
  assert.equal(fixture.uploadErrors.length, 1);
});

test('client cancellation removes a partially received multipart file', { timeout: 10000 }, async (t) => {
  const fixture = await createFixture(t);
  const { request, result } = uploadTo(fixture, 1024 * 1024);
  request.write(multipartStart);
  request.write(Buffer.alloc(4096, 11));
  await waitForPartialFile(fixture);
  request.destroy();

  assert.ok((await result).error);
  await until(async () => fixture.uploadErrors.length === 1
    && (await fs.readdir(fixture.directory)).length === 0,
    'cancelled upload left a partial file');
  assert.equal(fixture.uploads.length, 0);
  assert.equal(fixture.uploadErrors.length, 1);
});

test('completed upload can finish processing after the upload inactivity deadline', { timeout: 10000 }, async (t) => {
  const fixture = await createFixture(t, { processingDelayMs: 800 });
  const payload = Buffer.from('complete upload before slow processing');
  const { request, result } = uploadTo(fixture, payload.length);
  request.end(Buffer.concat([multipartStart, payload, multipartEnd]));

  assert.deepEqual(await result, { status: 201, body: 'uploaded' });
  assert.deepEqual(fixture.uploads, [payload]);
});

test('ordinary requests still expire even while their bodies continue arriving', { timeout: 10000 }, async (t) => {
  const fixture = await createFixture(t);
  const { request, result } = requestTo(fixture, '/ordinary', {
    headers: { 'content-length': '1000000' },
  });
  request.write('initial data');
  const writer = setInterval(() => {
    if (!request.destroyed) request.write('still active');
  }, 40);
  t.after(() => clearInterval(writer));
  const outcome = await result;
  clearInterval(writer);

  // A client still writing may receive the connection reset before the 408.
  if (outcome.error) {
    assert.ok(['ECONNRESET', 'EPIPE'].includes(outcome.error.code), outcome.error.message);
  } else {
    assert.equal(outcome.status, 408);
    assert.equal(JSON.parse(outcome.body).code, 'REQUEST_BODY_TIMEOUT');
  }
  assert.equal(fixture.ordinaryCompleted(), 0);
});

test('empty requests can finish slow processing without a body receipt timeout', { timeout: 10000 }, async (t) => {
  const fixture = await createFixture(t, { processingDelayMs: 800 });
  const { request, result } = requestTo(fixture, '/empty-processing');
  request.end();

  assert.deepEqual(await result, { status: 200, body: 'processed' });
});

test('upload timeout exemption does not survive HTTP keep-alive reuse', { timeout: 10000 }, async (t) => {
  const fixture = await createFixture(t);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  const payload = Buffer.from('first request');
  const upload = uploadTo(fixture, payload.length, { agent });
  upload.request.end(Buffer.concat([multipartStart, payload, multipartEnd]));
  assert.equal((await upload.result).status, 201);

  const ordinary = requestTo(fixture, '/ordinary', {
    agent,
    headers: { 'content-length': '1000000' },
  });
  ordinary.request.write('incomplete second request');
  const outcome = await ordinary.result;

  assert.equal(ordinary.request.reusedSocket, true, 'regression must exercise the same connection');
  assert.equal(outcome.status, 408);
  assert.equal(JSON.parse(outcome.body).code, 'REQUEST_BODY_TIMEOUT');
  assert.equal(fixture.ordinaryCompleted(), 0);
});

test('incomplete HTTP headers still time out before reaching the application', { timeout: 10000 }, async (t) => {
  const fixture = await createFixture(t);
  fixture.server.headersTimeout = 200;
  const received = await new Promise((resolve, reject) => {
    const socket = net.connect(fixture.port, '127.0.0.1');
    const chunks = [];
    t.after(() => socket.destroy());
    socket.on('connect', () => socket.write('POST /ordinary HTTP/1.1\r\nHost: localhost\r\nX-Partial: '));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => resolve(Buffer.concat(chunks).toString()));
  });

  assert.match(received, /^HTTP\/1\.1 408 /);
  assert.equal(fixture.ordinaryCompleted(), 0);
});

test('multipart request receives no upload privilege before authorization', { timeout: 10000 }, async (t) => {
  const fixture = await createFixture(t);
  const upload = uploadTo(fixture, 0, { headers: { 'x-test-admin': 'no' } });
  upload.request.end(Buffer.concat([multipartStart, multipartEnd]));

  assert.equal((await upload.result).status, 403);
  assert.deepEqual(fixture.uploads, []);
  assert.deepEqual(await fs.readdir(fixture.directory), []);
});

test('early refusal still bounds the time spent draining an incomplete body', { timeout: 10000 }, async (t) => {
  const fixture = await createFixture(t);
  let forcedClose = false;
  const received = await new Promise((resolve) => {
    const socket = net.connect(fixture.port, '127.0.0.1');
    const chunks = [];
    const writer = setInterval(() => {
      if (!socket.destroyed) socket.write('still sending a refused body');
    }, 40);
    const deadline = setTimeout(() => {
      forcedClose = true;
      socket.destroy();
    }, 2500);
    t.after(() => {
      clearInterval(writer);
      clearTimeout(deadline);
      socket.destroy();
    });
    socket.on('connect', () => socket.write(
      'POST /upload HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n'
      + 'Content-Length: 1000000\r\n\r\ninitial data',
    ));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', () => {});
    socket.on('close', () => {
      clearInterval(writer);
      clearTimeout(deadline);
      resolve(Buffer.concat(chunks).toString());
    });
  });

  assert.match(received, /^HTTP\/1\.1 403 /);
  assert.equal(forcedClose, false, 'refused request lost its body deadline');
  assert.deepEqual(fixture.uploads, []);
});
