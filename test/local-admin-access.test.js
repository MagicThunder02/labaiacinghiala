'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isAllowedLocalAdminHost,
  isAllowedLocalAdminOrigin,
  isAllowedLocalAdminReferer,
  isLocalAdminBrowserRequest,
  isLoopbackAddress,
} = require('../src/middleware/local-admin-access');
const { deviceAuth } = require('../src/middleware/device-auth');

function mockRequest({
  method = 'GET',
  remoteAddress = '127.0.0.1',
  localPort = 3000,
  headers = {},
} = {}) {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    method,
    originalUrl: '/api/admin/accounts',
    url: '/api/admin/accounts',
    query: {},
    headers: normalizedHeaders,
    socket: { remoteAddress, localPort },
    get(name) {
      return normalizedHeaders[String(name).toLowerCase()];
    },
  };
}

function invokeDeviceAuth(req) {
  let nextCalled = false;
  let response = null;
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      response = { status: this.statusCode, payload };
      return this;
    },
  };
  deviceAuth(req, res, () => { nextCalled = true; });
  return { nextCalled, response };
}

test('riconosce esclusivamente indirizzi IP di loopback', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('127.10.20.30'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('192.168.1.20'), false);
  assert.equal(isLoopbackAddress('::ffff:192.168.1.20'), false);
});

test('Host, Origin e Referer amministrativi devono usare loopback e la porta reale del listener', () => {
  assert.equal(isAllowedLocalAdminHost('localhost:3000', 3000), true);
  assert.equal(isAllowedLocalAdminHost('127.0.0.1:3000', 3000), true);
  assert.equal(isAllowedLocalAdminHost('[::1]:3000', 3000), true);
  assert.equal(isAllowedLocalAdminHost('localhost:3001', 3000), false);
  assert.equal(isAllowedLocalAdminHost('attacker.example:3000', 3000), false);
  assert.equal(isAllowedLocalAdminHost('attacker.example@localhost:3000', 3000), false);

  assert.equal(isAllowedLocalAdminOrigin('http://localhost:3000', 3000), true);
  assert.equal(isAllowedLocalAdminOrigin('http://127.0.0.1:3000', 3000), true);
  assert.equal(isAllowedLocalAdminOrigin('http://attacker.example:3000', 3000), false);
  assert.equal(isAllowedLocalAdminOrigin('https://localhost:3000', 3000), false);

  assert.equal(isAllowedLocalAdminReferer('http://localhost:3000/pages/profile.html', 3000), true);
  assert.equal(isAllowedLocalAdminReferer('http://attacker.example:3000/app', 3000), false);
});

test('il browser locale è amministrativo solo con socket, Host e contesto same-origin locali', () => {
  assert.equal(isLocalAdminBrowserRequest(mockRequest({
    headers: {
      Host: 'localhost:3000',
      Referer: 'http://localhost:3000/',
      'Sec-Fetch-Site': 'same-origin',
    },
  })), true);

  assert.equal(isLocalAdminBrowserRequest(mockRequest({
    method: 'POST',
    headers: {
      Host: 'localhost:3000',
      Origin: 'http://localhost:3000',
      Referer: 'http://localhost:3000/',
      'Sec-Fetch-Site': 'same-origin',
    },
  })), true);
});

test('blocca DNS rebinding, origini Tauri non firmate, LAN e richieste inoltrate da proxy', () => {
  const cases = [
    mockRequest({
      headers: {
        Host: 'attacker.example:3000',
        Origin: 'http://attacker.example:3000',
        Referer: 'http://attacker.example:3000/',
        'Sec-Fetch-Site': 'same-origin',
      },
    }),
    mockRequest({
      method: 'POST',
      headers: {
        Host: 'localhost:3000',
        Origin: 'http://attacker.example:3000',
        'Sec-Fetch-Site': 'cross-site',
      },
    }),
    mockRequest({
      remoteAddress: '192.168.1.20',
      headers: {
        Host: 'localhost:3000',
        Referer: 'http://localhost:3000/',
      },
    }),
    mockRequest({
      headers: {
        Host: 'localhost:3000',
        Origin: 'http://tauri.localhost',
        'Sec-Fetch-Site': 'cross-site',
      },
    }),
    mockRequest({
      headers: {
        Host: 'localhost:3000',
        Referer: 'http://localhost:3000/',
        'X-Forwarded-For': '203.0.113.10',
      },
    }),
    mockRequest({
      method: 'PUT',
      headers: {
        Host: 'localhost:3000',
        Referer: 'http://localhost:3000/',
      },
    }),
  ];

  for (const req of cases) assert.equal(isLocalAdminBrowserRequest(req), false);
});

test('deviceAuth concede il principal locale soltanto al browser loopback verificato', () => {
  const valid = mockRequest({
    headers: {
      Host: 'localhost:3000',
      Referer: 'http://localhost:3000/',
      'Sec-Fetch-Site': 'same-origin',
    },
  });
  const accepted = invokeDeviceAuth(valid);
  assert.equal(accepted.nextCalled, true);
  assert.equal(valid.baiaLocalAccess, true);

  const rebound = mockRequest({
    headers: {
      Host: 'attacker.example:3000',
      Origin: 'http://attacker.example:3000',
      Referer: 'http://attacker.example:3000/',
      'Sec-Fetch-Site': 'same-origin',
    },
  });
  const denied = invokeDeviceAuth(rebound);
  assert.equal(denied.nextCalled, false);
  assert.equal(denied.response.status, 401);
  assert.equal(denied.response.payload.code, 'AUTH_REQUIRED');
  assert.equal(rebound.baiaLocalAccess, undefined);
});
