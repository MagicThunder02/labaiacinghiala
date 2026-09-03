const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'api-config.js'), 'utf8');

function makeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function loadApi({ location, invoke, Channel = null, storage = {}, fetchImpl = null, events = [] }) {
  const window = {
    location,
    localStorage: makeStorage(storage),
    parent: null,
    dispatchEvent(event) { events.push(event); },
  };
  window.parent = window;
  if (invoke) window.__TAURI__ = { core: { invoke, ...(Channel ? { Channel } : {}) } };

  class TestCustomEvent {
    constructor(type, options = {}) {
      this.type = type;
      this.detail = options.detail;
    }
  }

  const context = vm.createContext({
    window,
    URL,
    CustomEvent: TestCustomEvent,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  vm.runInContext(source, context);
  return window.BaiaApi;
}

function loadIframeApi({ location, frameInvoke, parentInvoke }) {
  const parent = {
    __TAURI__: { core: { invoke: parentInvoke } },
  };
  const window = {
    location,
    localStorage: makeStorage(),
    parent,
    __TAURI__: { core: { invoke: frameInvoke } },
    dispatchEvent() {},
  };

  class TestCustomEvent {
    constructor(type, options = {}) {
      this.type = type;
      this.detail = options.detail;
    }
  }

  const context = vm.createContext({ window, URL, CustomEvent: TestCustomEvent });
  vm.runInContext(source, context);
  return window.BaiaApi;
}

test('iframe Tauri preferisce il Core del parent per evitare callback IPC locali bloccati', async () => {
  const parentCalls = [];
  let frameCalls = 0;
  const api = loadIframeApi({
    location: { protocol: 'http:', hostname: 'tauri.localhost', port: '' },
    frameInvoke: async () => {
      frameCalls += 1;
      return new Promise(() => {});
    },
    parentInvoke: async (command) => {
      parentCalls.push(command);
      if (command === 'baia_core_bootstrap') {
        return {
          coreVersion: '0.5.0',
          platform: 'android',
          apiBaseUrl: 'http://127.0.0.1:3000',
          transport: 'connector-local-tls-v1',
          installationId: 'android-test-id',
        };
      }
      throw new Error('unexpected command');
    },
  });

  const outcome = await Promise.race([
    api.ready.then(() => 'resolved'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 250)),
  ]);

  assert.equal(outcome, 'resolved');
  assert.equal(frameCalls, 0);
  assert.deepEqual(parentCalls, ['baia_core_bootstrap']);
  assert.equal(api.getBaseUrl(), 'http://127.0.0.1:3000');
});

test('browser web mantiene URL API relative', async () => {
  const api = loadApi({ location: { protocol: 'http:', hostname: '192.168.1.20', port: '3000' } });
  await api.ready;
  assert.equal(api.getBaseUrl(), '');
  assert.equal(api.url('/api/movies'), '/api/movies');
});

test('Tauri usa endpoint ricevuto dal Baia Core', async () => {
  const calls = [];
  const api = loadApi({
    location: { protocol: 'http:', hostname: 'tauri.localhost', port: '' },
    invoke: async (command) => {
      calls.push(command);
      if (command === 'baia_core_bootstrap') {
        return { coreVersion: '0.5.0', platform: 'windows', apiBaseUrl: 'http://127.0.0.1:3456', transport: 'direct-local', installationId: 'test-id' };
      }
      throw new Error('unexpected command');
    },
  });

  await api.ready;
  assert.deepEqual(calls, ['baia_core_bootstrap']);
  assert.equal(api.getBaseUrl(), 'http://127.0.0.1:3456');
  assert.equal(api.url('/api/movies'), 'http://127.0.0.1:3456/api/movies');
});

test('Tauri mantiene fallback locale se il Core non risponde', async () => {
  const api = loadApi({
    location: { protocol: 'http:', hostname: 'tauri.localhost', port: '' },
    invoke: async () => { throw new Error('core unavailable'); },
  });

  await api.ready;
  assert.equal(api.getBaseUrl(), 'http://127.0.0.1:3000');
  assert.match(String(api.getCoreBootstrapError()), /core unavailable/);
});

test('override locale resta disponibile nella web app classica', async () => {
  const api = loadApi({
    location: { protocol: 'http:', hostname: '192.168.1.20', port: '3000' },
    storage: { baiaApiBaseUrl: 'http://10.0.0.5:3000/' },
  });

  await api.ready;
  assert.equal(api.getBaseUrl(), 'http://10.0.0.5:3000');
});

test('Tauri ignora il vecchio endpoint localStorage e usa il Core', async () => {
  const api = loadApi({
    location: { protocol: 'http:', hostname: 'localhost', port: '1430' },
    storage: { baiaApiBaseUrl: 'http://10.0.0.5:3000/' },
    invoke: async () => ({ coreVersion: '0.5.0', platform: 'windows', apiBaseUrl: 'http://127.0.0.1:3000', transport: 'direct-local', installationId: 'test-id' }),
  });

  await api.ready;
  assert.equal(api.getBaseUrl(), 'http://127.0.0.1:3000');
});

test('Tauri aggiorna il runtime dopo il salvataggio nativo dell endpoint', async () => {
  const calls = [];
  const api = loadApi({
    location: { protocol: 'http:', hostname: 'tauri.localhost', port: '' },
    invoke: async (command, args) => {
      calls.push([command, args]);
      if (command === 'baia_core_bootstrap') {
        return { coreVersion: '0.5.0', platform: 'windows', apiBaseUrl: 'http://127.0.0.1:3000', transport: 'direct-local', installationId: 'test-id' };
      }
      if (command === 'baia_core_set_server_endpoint') {
        assert.equal(args.endpoint, 'http://192.168.1.50:3000');
        return { coreVersion: '0.5.0', platform: 'windows', apiBaseUrl: args.endpoint, transport: 'direct-configured', installationId: 'test-id' };
      }
      throw new Error('unexpected command');
    },
  });

  await api.ready;
  const updated = await api.setServerEndpoint('http://192.168.1.50:3000/');
  assert.equal(updated.transport, 'direct-configured');
  assert.equal(api.getBaseUrl(), 'http://192.168.1.50:3000');
  assert.equal(calls[1][0], 'baia_core_set_server_endpoint');
});

test('Tauri aggiorna il runtime dopo il ripristino nativo', async () => {
  const api = loadApi({
    location: { protocol: 'http:', hostname: 'tauri.localhost', port: '' },
    invoke: async (command) => {
      if (command === 'baia_core_bootstrap') {
        return { coreVersion: '0.5.0', platform: 'windows', apiBaseUrl: 'http://192.168.1.50:3000', transport: 'direct-configured', installationId: 'test-id' };
      }
      if (command === 'baia_core_reset_server_endpoint') {
        return { coreVersion: '0.5.0', platform: 'windows', apiBaseUrl: 'http://127.0.0.1:3000', transport: 'direct-local', installationId: 'test-id' };
      }
      throw new Error('unexpected command');
    },
  });

  await api.ready;
  assert.equal(api.getBaseUrl(), 'http://192.168.1.50:3000');
  await api.resetServerEndpoint();
  assert.equal(api.getBaseUrl(), 'http://127.0.0.1:3000');
});


test('Tauri richiede al Core solo i dati pubblici dell identità dispositivo', async () => {
  const calls = [];
  const api = loadApi({
    location: { protocol: 'http:', hostname: 'tauri.localhost', port: '' },
    invoke: async (command) => {
      calls.push(command);
      if (command === 'baia_core_bootstrap') {
        return { coreVersion: '0.5.0', platform: 'windows', apiBaseUrl: 'http://127.0.0.1:3000', transport: 'direct-local', installationId: 'test-id' };
      }
      if (command === 'baia_core_device_identity') {
        return { algorithm: 'Ed25519', publicKey: 'public-only', fingerprint: 'SHA256:test', secretStorage: 'Windows Credential Manager' };
      }
      throw new Error('unexpected command');
    },
  });

  await api.ready;
  const identity = await api.getDeviceIdentity();
  assert.equal(identity.algorithm, 'Ed25519');
  assert.equal(identity.publicKey, 'public-only');
  assert.equal(identity.fingerprint, 'SHA256:test');
  assert.equal(Object.hasOwn(identity, 'privateKey'), false);
  assert.deepEqual(calls, ['baia_core_bootstrap', 'baia_core_device_identity']);
});

test('Tauri legge lo stato pairing solo dal Baia Core', async () => {
  const calls = [];
  const api = loadApi({
    location: { protocol: 'http:', hostname: 'tauri.localhost', port: '' },
    invoke: async (command) => {
      calls.push(command);
      if (command === 'baia_core_bootstrap') {
        return { coreVersion: '0.5.0', platform: 'windows', apiBaseUrl: 'http://127.0.0.1:3000', transport: 'direct-local', installationId: 'test-id' };
      }
      if (command === 'baia_core_pairing_status') {
        return { paired: false, currentServerMatches: false, suggestedDeviceName: 'Baia test' };
      }
      throw new Error('unexpected command');
    },
  });

  await api.ready;
  const status = await api.getPairingStatus();
  assert.equal(status.paired, false);
  assert.equal(status.suggestedDeviceName, 'Baia test');
  assert.deepEqual(calls, ['baia_core_bootstrap', 'baia_core_pairing_status']);
});

test('Tauri passa al Core solo invito e nome dispositivo, senza materiale di firma', async () => {
  const calls = [];
  const api = loadApi({
    location: { protocol: 'http:', hostname: 'tauri.localhost', port: '' },
    invoke: async (command, args) => {
      calls.push([command, args]);
      if (command === 'baia_core_bootstrap') {
        return { coreVersion: '0.5.0', platform: 'windows', apiBaseUrl: 'http://127.0.0.1:3000', transport: 'direct-local', installationId: 'test-id' };
      }
      if (command === 'baia_core_pair_with_invite') {
        assert.deepEqual(Object.keys(args).sort(), ['deviceName', 'inviteToken']);
        assert.equal(args.inviteToken, 'baia1.test.secret');
        assert.equal(args.deviceName, 'PC salotto');
        assert.equal(Object.hasOwn(args, 'privateKey'), false);
        assert.equal(Object.hasOwn(args, 'signature'), false);
        return { paired: true, currentServerMatches: true, deviceName: 'PC test' };
      }
      throw new Error('unexpected command');
    },
  });

  await api.ready;
  const status = await api.pairWithInvite('  baia1.test.secret  ', '  PC salotto  ');
  assert.equal(status.paired, true);
  assert.equal(calls[1][0], 'baia_core_pair_with_invite');
});

test('Tauri ottiene header di autenticazione dal Core senza esporre la chiave privata', async () => {
  const calls = [];
  const api = loadApi({
    location: { protocol: 'http:', hostname: 'tauri.localhost', port: '' },
    invoke: async (command, args) => {
      calls.push([command, args]);
      if (command === 'baia_core_bootstrap') {
        return { coreVersion: '0.5.0', platform: 'windows', apiBaseUrl: 'http://127.0.0.1:3000', transport: 'direct-local', installationId: 'test-id' };
      }
      if (command === 'baia_core_authorize_request') {
        assert.deepEqual(JSON.parse(JSON.stringify(args)), { method: 'GET', url: 'http://127.0.0.1:3000/api/movies?limit=10' });
        return { deviceId: 'device-id', timestamp: 123, nonce: 'nonce', signature: 'signature' };
      }
      throw new Error('unexpected command');
    },
  });

  const headers = await api.requestAuthHeaders('GET', '/api/movies?limit=10');
  assert.deepEqual(JSON.parse(JSON.stringify(headers)), {
    'X-Baia-Device-Id': 'device-id',
    'X-Baia-Timestamp': '123',
    'X-Baia-Nonce': 'nonce',
    'X-Baia-Signature': 'signature',
  });
  assert.equal(calls[1][0], 'baia_core_authorize_request');
  assert.equal(Object.hasOwn(headers, 'privateKey'), false);
});

test('Tauri mantiene il vecchio URL firmato diretto per media non allowlistati', async () => {
  let mediaCalls = 0;
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const api = loadApi({
    location: { protocol: 'http:', hostname: 'tauri.localhost', port: '' },
    invoke: async (command, args) => {
      if (command === 'baia_core_bootstrap') {
        return { coreVersion: '0.5.0', platform: 'windows', apiBaseUrl: 'http://127.0.0.1:3000', transport: 'direct-local', installationId: 'test-id' };
      }
      if (command === 'baia_core_authorize_media_url') {
        mediaCalls += 1;
        assert.equal(args.url, 'http://127.0.0.1:3000/api/movies/7/poster?v=1&extra=1');
        return `http://127.0.0.1:3000/api/movies/7/poster?v=1&extra=1&_baia_device=d&_baia_expires=${expires}&_baia_signature=s`;
      }
      throw new Error('unexpected command');
    },
  });

  const first = await api.authorizeMediaUrl('/api/movies/7/poster?v=1&extra=1');
  const second = await api.authorizeMediaUrl('/api/movies/7/poster?v=1&extra=1');
  assert.match(first, /_baia_signature=s/);
  assert.equal(second, first);
  assert.equal(mediaCalls, 1);
});

test('Tauri instrada i poster Film nel ponte media e non inoltra i cache-buster v/t', async () => {
  let bridgeCalls = 0;
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const api = loadApi({
    location: { protocol: 'http:', hostname: 'tauri.localhost', port: '' },
    invoke: async (command, args) => {
      if (command === 'baia_core_bootstrap') {
        return { coreVersion: '0.5.0', platform: 'android', apiBaseUrl: 'http://127.0.0.1:3000', transport: 'connector-local-tls-v1', installationId: 'test-id' };
      }
      if (command === 'baia_core_media_bridge_url') {
        bridgeCalls += 1;
        assert.deepEqual(JSON.parse(JSON.stringify(args)), { path: '/api/movies/7/poster' });
        assert.equal(Object.hasOwn(args, 'url'), false);
        return `http://127.0.0.1:49151/media/poster-token?_baia_expires=${expires}`;
      }
      if (command === 'baia_core_authorize_media_url') {
        throw new Error('Il poster Film allowlistato non deve usare il vecchio URL Node firmato diretto.');
      }
      throw new Error(`unexpected command: ${command}`);
    },
  });

  const first = await api.authorizeMediaUrl('/api/movies/7/poster?v=2026-08-21T00%3A00%3A00.000Z&t=123');
  const second = await api.authorizeMediaUrl('/api/movies/7/poster?v=2026-08-21T00%3A00%3A00.000Z&t=123');
  assert.match(first, /^http:\/\/127\.0\.0\.1:49151\/media\//);
  assert.equal(second, first);
  assert.equal(bridgeCalls, 1);
});

test('Tauri instrada poster Serie, cover Reading e cover Album Musica nel ponte media senza query applicative', async () => {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const seriesId = '123e4567-e89b-42d3-a456-426614174000';
  const albumId = '223e4567-e89b-42d3-a456-426614174000';
  const expectedPaths = [
    `/api/series/${seriesId}/poster`,
    '/api/reading/21/cover',
    `/api/music/albums/${albumId}/cover`,
  ];
  const bridgePaths = [];
  const api = loadApi({
    location: { protocol: 'http:', hostname: 'tauri.localhost', port: '' },
    invoke: async (command, args) => {
      if (command === 'baia_core_bootstrap') {
        return { coreVersion: '0.5.0', platform: 'android', apiBaseUrl: 'http://127.0.0.1:3000', transport: 'connector-local-tls-v1', installationId: 'test-id' };
      }
      if (command === 'baia_core_media_bridge_url') {
        bridgePaths.push(args.path);
        assert.equal(Object.hasOwn(args, 'url'), false);
        return `http://127.0.0.1:49155/media/artwork-token?_baia_expires=${expires}`;
      }
      if (command === 'baia_core_authorize_media_url') {
        throw new Error('Le copertine allowlistate non devono usare il vecchio URL Node firmato diretto.');
      }
      throw new Error(`unexpected command: ${command}`);
    },
  });

  await api.authorizeMediaUrl(`/api/series/${seriesId}/poster?v=series&t=1`);
  await api.authorizeMediaUrl('/api/reading/21/cover?v=reading');
  await api.authorizeMediaUrl(`/api/music/albums/${albumId}/cover?v=music`);
  assert.deepEqual(bridgePaths, expectedPaths);
});

test('Tauri fetchApi scarica le cover Musica dal ponte media e non dal loopback Node', async () => {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const albumId = '223e4567-e89b-42d3-a456-426614174000';
  const fetchCalls = [];
  const response = {
    status: 200,
    ok: true,
    headers: { get: () => 'image/jpeg' },
    clone() { return this; },
  };
  const api = loadApi({
    location: { protocol: 'http:', hostname: 'tauri.localhost', port: '' },
    fetchImpl: async (target, options) => { fetchCalls.push([target, options]); return response; },
    invoke: async (command, args) => {
      if (command === 'baia_core_bootstrap') {
        return { coreVersion: '0.5.0', platform: 'android', apiBaseUrl: 'http://127.0.0.1:3000', transport: 'connector-local-tls-v1', installationId: 'test-id' };
      }
      if (command === 'baia_core_media_bridge_url') {
        assert.deepEqual(JSON.parse(JSON.stringify(args)), { path: `/api/music/albums/${albumId}/cover` });
        return `http://127.0.0.1:49156/media/music-cover-token?_baia_expires=${expires}`;
      }
      if (command === 'baia_core_authorize_request') {
        throw new Error('La cover Musica via fetchApi non deve usare la firma API diretta verso Node.');
      }
      throw new Error(`unexpected command: ${command}`);
    },
  });

  assert.equal(await api.fetchApi(`/api/music/albums/${albumId}/cover?v=music`), response);
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0][0], /^http:\/\/127\.0\.0\.1:49156\/media\//);
});

test('Tauri instrada gli stream Film nel ponte media locale del Core', async () => {
  let bridgeCalls = 0;
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const api = loadApi({
    location: { protocol: 'http:', hostname: 'tauri.localhost', port: '' },
    invoke: async (command, args) => {
      if (command === 'baia_core_bootstrap') {
        return { coreVersion: '0.5.0', platform: 'windows', apiBaseUrl: 'http://127.0.0.1:3000', transport: 'direct-local', installationId: 'test-id' };
      }
      if (command === 'baia_core_media_bridge_url') {
        bridgeCalls += 1;
        assert.deepEqual(JSON.parse(JSON.stringify(args)), { path: '/api/movies/7/stream' });
        assert.equal(Object.hasOwn(args, 'url'), false);
        return `http://127.0.0.1:49152/media/opaque-token?_baia_expires=${expires}`;
      }
      throw new Error(`unexpected command: ${command}`);
    },
  });

  const first = await api.authorizeMediaUrl('/api/movies/7/stream');
  const second = await api.authorizeMediaUrl('/api/movies/7/stream');
  assert.match(first, /^http:\/\/127\.0\.0\.1:49152\/media\//);
  assert.equal(second, first);
  assert.equal(bridgeCalls, 1);
});

test('Tauri instrada anche gli stream Musica nel ponte media locale del Core', async () => {
  let bridgeCalls = 0;
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const trackPath = '/api/music/tracks/123e4567-e89b-42d3-a456-426614174000/stream';
  const api = loadApi({
    location: { protocol: 'http:', hostname: 'tauri.localhost', port: '' },
    invoke: async (command, args) => {
      if (command === 'baia_core_bootstrap') {
        return { coreVersion: '0.5.0', platform: 'windows', apiBaseUrl: 'http://127.0.0.1:3000', transport: 'direct-local', installationId: 'test-id' };
      }
      if (command === 'baia_core_media_bridge_url') {
        bridgeCalls += 1;
        assert.deepEqual(JSON.parse(JSON.stringify(args)), { path: trackPath });
        assert.equal(Object.hasOwn(args, 'url'), false);
        return `http://127.0.0.1:49153/media/music-token?_baia_expires=${expires}`;
      }
      throw new Error(`unexpected command: ${command}`);
    },
  });

  const first = await api.authorizeMediaUrl(trackPath);
  const second = await api.authorizeMediaUrl(trackPath);
  assert.match(first, /^http:\/\/127\.0\.0\.1:49153\/media\//);
  assert.equal(second, first);
  assert.equal(bridgeCalls, 1);
});

test('Tauri instrada il file PDF Reading nel ponte media locale del Core', async () => {
  let bridgeCalls = 0;
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const filePath = '/api/reading/21/file';
  const api = loadApi({
    location: { protocol: 'http:', hostname: 'tauri.localhost', port: '' },
    invoke: async (command, args) => {
      if (command === 'baia_core_bootstrap') {
        return { coreVersion: '0.5.0', platform: 'windows', apiBaseUrl: 'http://127.0.0.1:3000', transport: 'direct-local', installationId: 'test-id' };
      }
      if (command === 'baia_core_media_bridge_url') {
        bridgeCalls += 1;
        assert.deepEqual(JSON.parse(JSON.stringify(args)), { path: filePath });
        assert.equal(Object.hasOwn(args, 'url'), false);
        return `http://127.0.0.1:49154/media/reading-token?_baia_expires=${expires}`;
      }
      if (command === 'baia_core_authorize_media_url') {
        throw new Error('Il file PDF Reading non deve usare il vecchio URL media firmato diretto.');
      }
      throw new Error(`unexpected command: ${command}`);
    },
  });

  const first = await api.authorizeMediaUrl(filePath);
  const second = await api.authorizeMediaUrl(filePath);
  assert.match(first, /^http:\/\/127\.0\.0\.1:49154\/media\//);
  assert.equal(second, first);
  assert.equal(bridgeCalls, 1);
});

test('Tauri instrada le entry CBZ ed EPUB nel ponte media locale del Core', async () => {
  let bridgeCalls = 0;
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const entryPath = '/api/reading/21/reader/entry/7';
  const api = loadApi({
    location: { protocol: 'http:', hostname: 'tauri.localhost', port: '' },
    invoke: async (command, args) => {
      if (command === 'baia_core_bootstrap') {
        return { coreVersion: '0.5.0', platform: 'windows', apiBaseUrl: 'http://127.0.0.1:3000', transport: 'direct-local', installationId: 'test-id' };
      }
      if (command === 'baia_core_media_bridge_url') {
        bridgeCalls += 1;
        assert.deepEqual(JSON.parse(JSON.stringify(args)), { path: entryPath });
        assert.equal(Object.hasOwn(args, 'url'), false);
        return `http://127.0.0.1:49155/media/reader-entry-token?_baia_expires=${expires}`;
      }
      if (command === 'baia_core_authorize_media_url') {
        throw new Error('Le entry Reading non devono usare il vecchio URL media firmato diretto.');
      }
      throw new Error(`unexpected command: ${command}`);
    },
  });

  const first = await api.authorizeMediaUrl(entryPath);
  const second = await api.authorizeMediaUrl(entryPath);
  assert.match(first, /^http:\/\/127\.0\.0\.1:49155\/media\//);
  assert.equal(second, first);
  assert.equal(bridgeCalls, 1);
});

test('browser web non richiede firma device dal Core', async () => {
  const api = loadApi({ location: { protocol: 'http:', hostname: '127.0.0.1', port: '3000' } });
  assert.deepEqual(JSON.parse(JSON.stringify(await api.requestAuthHeaders('GET', '/api/movies'))), {});
  assert.equal(await api.authorizeMediaUrl('/api/movies/7/poster'), '/api/movies/7/poster');
});


test('un 403 di sezione viene notificato come accesso negato senza richiedere un nuovo login', async () => {
  const events = [];
  const response = {
    status: 403,
    ok: false,
    headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'application/json' : null },
    clone() {
      return {
        json: async () => ({
          code: 'SECTION_ACCESS_DENIED',
          section: 'music',
          error: 'Il tuo account non può accedere alla sezione Musica.',
        }),
      };
    },
  };
  const api = loadApi({
    location: { protocol: 'http:', hostname: '127.0.0.1', port: '3000', origin: 'http://127.0.0.1:3000' },
    fetchImpl: async () => response,
    events,
  });

  assert.equal(await api.fetchApi('/api/music'), response);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'baia-account-access-denied');
  assert.deepEqual(JSON.parse(JSON.stringify(events[0].detail)), {
    type: 'shell-account-access-denied',
    code: 'SECTION_ACCESS_DENIED',
    section: 'music',
    message: 'Il tuo account non può accedere alla sezione Musica.',
  });
});


test('PASSWORD_CHANGE_REQUIRED viene notificato come accesso negato senza logout', async () => {
  const events = [];
  const response = {
    status: 403,
    ok: false,
    headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'application/json' : null },
    clone() {
      return {
        json: async () => ({
          code: 'PASSWORD_CHANGE_REQUIRED',
          error: 'Devi impostare una nuova password prima di continuare.',
        }),
      };
    },
  };
  const api = loadApi({
    location: { protocol: 'http:', hostname: '127.0.0.1', port: '3000', origin: 'http://127.0.0.1:3000' },
    fetchImpl: async () => response,
    events,
  });

  assert.equal(await api.fetchApi('/api/movies?type=movie'), response);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'baia-account-access-denied');
  assert.deepEqual(JSON.parse(JSON.stringify(events[0].detail)), {
    type: 'shell-account-access-denied',
    code: 'PASSWORD_CHANGE_REQUIRED',
    section: '',
    message: 'Devi impostare una nuova password prima di continuare.',
  });
});

test('upload nativo usa selezioni opache e un Channel Tauri senza accettare URL o path dal JavaScript', async () => {
  const calls = [];
  const progress = [];
  class TestChannel {
    constructor() { this.onmessage = null; }
  }
  const api = loadApi({
    location: { protocol: 'http:', hostname: 'tauri.localhost', port: '' },
    Channel: TestChannel,
    invoke: async (command, args) => {
      calls.push([command, args]);
      if (command === 'baia_core_bootstrap') {
        return { coreVersion: '0.5.0', platform: 'windows', apiBaseUrl: 'http://127.0.0.1:3000', transport: 'direct-local', installationId: 'test-id' };
      }
      if (command === 'baia_core_pick_upload_files') {
        assert.deepEqual(JSON.parse(JSON.stringify(args)), { role: 'movie-video', category: null });
        return [{ token: 'opaque-token', role: 'movie-video', name: 'film.mkv', size: 123, previewDataUrl: null }];
      }
      if (command === 'baia_core_upload_files') {
        assert.ok(args.onProgress instanceof TestChannel);
        assert.deepEqual(JSON.parse(JSON.stringify(args.request)), {
          kind: 'movie',
          fields: { title: 'Film', year: '2026', director: 'Regista', genre: 'Dramma' },
          files: { video: 'opaque-token', poster: 'opaque-poster' },
        });
        assert.equal(Object.hasOwn(args.request, 'url'), false);
        assert.equal(Object.hasOwn(args.request, 'path'), false);
        args.onProgress.onmessage?.({ phase: 'uploading', loaded: 50, total: 100 });
        return { status: 201, ok: true, payload: { movie: { id: 7, title: 'Film' } } };
      }
      if (command === 'baia_core_release_upload_files') {
        assert.deepEqual(JSON.parse(JSON.stringify(args)), { tokens: ['opaque-token'] });
        return null;
      }
      throw new Error(`unexpected command: ${command}`);
    },
  });

  assert.equal(api.nativeUploadsAvailable(), true);
  const selected = await api.pickUploadFiles('movie-video');
  assert.equal(selected[0].token, 'opaque-token');
  const payload = await api.uploadFilesNative({
    kind: 'movie',
    fields: { title: 'Film', year: '2026', director: 'Regista', genre: 'Dramma' },
    files: { video: selected[0].token, poster: 'opaque-poster' },
  }, (event) => progress.push(event));
  await api.releaseUploadFiles(['opaque-token', 'opaque-token', '']);

  assert.equal(payload.movie.id, 7);
  assert.deepEqual(JSON.parse(JSON.stringify(progress)), [{ phase: 'uploading', loaded: 50, total: 100 }]);
  assert.deepEqual(calls.map(([command]) => command), [
    'baia_core_bootstrap',
    'baia_core_pick_upload_files',
    'baia_core_upload_files',
    'baia_core_release_upload_files',
  ]);
});

test('errore autorizzativo dell upload nativo usa gli stessi eventi account delle API fetch', async () => {
  const events = [];
  class TestChannel {}
  const api = loadApi({
    location: { protocol: 'http:', hostname: 'tauri.localhost', port: '' },
    Channel: TestChannel,
    events,
    invoke: async (command) => {
      if (command === 'baia_core_bootstrap') {
        return { coreVersion: '0.5.0', platform: 'windows', apiBaseUrl: 'http://127.0.0.1:3000', transport: 'direct-local', installationId: 'test-id' };
      }
      if (command === 'baia_core_upload_files') {
        return {
          status: 403,
          ok: false,
          payload: { code: 'ADMIN_REQUIRED', error: 'Permesso amministratore richiesto.' },
        };
      }
      throw new Error('unexpected command');
    },
  });

  await assert.rejects(
    api.uploadFilesNative({ kind: 'music', fields: {}, files: { audio: ['opaque'] } }),
    /Permesso amministratore richiesto/,
  );
  assert.equal(events[0].type, 'baia-account-access-denied');
  assert.equal(events[0].detail.code, 'ADMIN_REQUIRED');
});

test('Tauri invia le API JSON al Core usando solo path relativo e header applicativi', async () => {
  const calls = [];
  let webviewFetchCalls = 0;
  const api = loadApi({
    location: { protocol: 'http:', hostname: 'tauri.localhost', port: '' },
    fetchImpl: async () => { webviewFetchCalls += 1; throw new Error('fetch WebView non deve essere usato'); },
    invoke: async (command, args) => {
      calls.push([command, args]);
      if (command === 'baia_core_bootstrap') {
        return { coreVersion: '0.5.0', platform: 'windows', apiBaseUrl: 'http://127.0.0.1:3000', transport: 'direct-local', installationId: 'test-id' };
      }
      if (command === 'baia_core_api_request') {
        assert.deepEqual(JSON.parse(JSON.stringify(args)), {
          request: {
            path: '/api/movies?limit=10',
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: '{"favorite":true}',
          },
        });
        return {
          status: 200,
          ok: true,
          headers: { 'content-type': 'application/json', 'retry-after': '9' },
          body: '{"ok":true}',
        };
      }
      throw new Error(`unexpected command ${command}`);
    },
  });

  const response = await api.fetchApiJson('/api/movies?limit=10', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: '{"favorite":true}',
  });
  assert.equal(response.status, 200);
  assert.equal(response.ok, true);
  assert.equal(response.headers.get('Retry-After'), '9');
  assert.deepEqual(JSON.parse(JSON.stringify(await response.json())), { ok: true });
  assert.equal(webviewFetchCalls, 0);
  assert.deepEqual(calls.map(([command]) => command), ['baia_core_bootstrap', 'baia_core_api_request']);
});

test('Tauri rifiuta URL API esterni e header X-Baia forniti dal JavaScript', async () => {
  const api = loadApi({
    location: { protocol: 'http:', hostname: 'tauri.localhost', port: '' },
    invoke: async (command) => {
      if (command === 'baia_core_bootstrap') {
        return { coreVersion: '0.5.0', platform: 'windows', apiBaseUrl: 'http://127.0.0.1:3000', transport: 'direct-local', installationId: 'test-id' };
      }
      throw new Error(`unexpected command ${command}`);
    },
  });

  await assert.rejects(() => api.fetchApiJson('https://evil.invalid/api/movies'), /soltanto path \/api\//);
  await assert.rejects(() => api.fetchApiJson('/api/movies', {
    headers: { 'X-Baia-Signature': 'forged' },
  }), /generati esclusivamente dal Core/);
});

test('browser web mantiene fetch relativo anche per il percorso JSON condiviso', async () => {
  const calls = [];
  const response = {
    status: 200,
    ok: true,
    headers: { get: () => 'application/json' },
    clone() { return this; },
    json: async () => ({ ok: true }),
  };
  const api = loadApi({
    location: { protocol: 'http:', hostname: '127.0.0.1', port: '3000', origin: 'http://127.0.0.1:3000' },
    fetchImpl: async (target, options) => { calls.push([target, options]); return response; },
  });

  assert.equal(await api.fetchApiJson('/api/movies', { method: 'GET' }), response);
  assert.equal(calls[0][0], '/api/movies');
});
