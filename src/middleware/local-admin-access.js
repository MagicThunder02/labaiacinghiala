'use strict';

const net = require('node:net');

const LOCAL_ADMIN_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const SAFE_METHODS = new Set(['GET', 'HEAD']);
const FORWARDED_HEADERS = Object.freeze([
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
  'x-real-ip',
]);

function normalizeAddress(address) {
  const value = String(address || '').trim().toLowerCase();
  if (value.startsWith('::ffff:')) return value.slice(7);
  return value;
}

function isLoopbackAddress(address) {
  const value = normalizeAddress(address);
  if (value === '::1') return true;
  if (net.isIP(value) !== 4) return false;
  const firstOctet = Number.parseInt(value.split('.', 1)[0], 10);
  return firstOctet === 127;
}

function normalizeHostname(hostname) {
  const value = String(hostname || '').trim().toLowerCase();
  if (value.startsWith('[') && value.endsWith(']')) return value.slice(1, -1);
  return value;
}

function parseAuthority(authority) {
  const value = String(authority || '').trim();
  if (!value || value.length > 255 || /[\s/@\\?#]/.test(value)) return null;

  try {
    const parsed = new URL(`http://${value}`);
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      return null;
    }
    return {
      hostname: normalizeHostname(parsed.hostname),
      port: parsed.port ? Number.parseInt(parsed.port, 10) : 80,
    };
  } catch {
    return null;
  }
}

function normalizeLocalPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function isAllowedLocalAdminHost(hostHeader, localPort) {
  const authority = parseAuthority(hostHeader);
  const expectedPort = normalizeLocalPort(localPort);
  return Boolean(
    authority
      && expectedPort
      && LOCAL_ADMIN_HOSTS.has(authority.hostname)
      && authority.port === expectedPort,
  );
}

function parseHttpUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (parsed.protocol !== 'http:' || parsed.username || parsed.password) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isAllowedLocalAdminOrigin(origin, localPort) {
  const parsed = parseHttpUrl(origin);
  const expectedPort = normalizeLocalPort(localPort);
  if (!parsed || !expectedPort || parsed.pathname !== '/' || parsed.search || parsed.hash) return false;
  const effectivePort = parsed.port ? Number.parseInt(parsed.port, 10) : 80;
  return LOCAL_ADMIN_HOSTS.has(normalizeHostname(parsed.hostname)) && effectivePort === expectedPort;
}

function isAllowedLocalAdminReferer(referer, localPort) {
  const parsed = parseHttpUrl(referer);
  const expectedPort = normalizeLocalPort(localPort);
  if (!parsed || !expectedPort) return false;
  const effectivePort = parsed.port ? Number.parseInt(parsed.port, 10) : 80;
  return LOCAL_ADMIN_HOSTS.has(normalizeHostname(parsed.hostname)) && effectivePort === expectedPort;
}

function headerValue(req, name) {
  if (typeof req?.get === 'function') return req.get(name);
  return req?.headers?.[String(name).toLowerCase()];
}

function hasForwardingHeaders(req) {
  const headers = req?.headers || {};
  return FORWARDED_HEADERS.some((name) => Object.hasOwn(headers, name)
    || headerValue(req, name) !== undefined);
}

function isLocalAdminBrowserRequest(req) {
  if (!isLoopbackAddress(req?.socket?.remoteAddress)) return false;
  if (hasForwardingHeaders(req)) return false;

  const localPort = req?.socket?.localPort;
  if (!isAllowedLocalAdminHost(headerValue(req, 'Host'), localPort)) return false;

  const fetchSite = String(headerValue(req, 'Sec-Fetch-Site') || '').trim().toLowerCase();
  if (fetchSite && fetchSite !== 'same-origin') return false;

  const origin = headerValue(req, 'Origin');
  if (origin) return isAllowedLocalAdminOrigin(origin, localPort);

  if (!SAFE_METHODS.has(String(req?.method || '').toUpperCase())) return false;
  return isAllowedLocalAdminReferer(headerValue(req, 'Referer'), localPort);
}

module.exports = {
  FORWARDED_HEADERS,
  LOCAL_ADMIN_HOSTS,
  hasForwardingHeaders,
  isAllowedLocalAdminHost,
  isAllowedLocalAdminOrigin,
  isAllowedLocalAdminReferer,
  isLocalAdminBrowserRequest,
  isLoopbackAddress,
  normalizeAddress,
};
