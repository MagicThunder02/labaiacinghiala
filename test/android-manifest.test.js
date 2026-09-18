'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  androidManifest,
  normalizeUrl,
  normalizeVersion,
  parseArguments,
} = require('../scripts/build-android-manifest');

test('il manifesto Android riporta versione, URL e firma della release', () => {
  const manifest = androidManifest({
    version: 'v0.7.0',
    url: 'https://github.com/MagicThunder02/labaiacinghiala/releases/download/v0.7.0/baia.apk',
    signature: '  firma-minisign\n',
    notes: '  Correzioni  ',
    publishedAt: '2026-09-18T10:00:00.000Z',
  });

  assert.deepEqual(manifest, {
    version: '0.7.0',
    notes: 'Correzioni',
    pub_date: '2026-09-18T10:00:00.000Z',
    url: 'https://github.com/MagicThunder02/labaiacinghiala/releases/download/v0.7.0/baia.apk',
    signature: 'firma-minisign',
  });
});

test('un manifesto senza firma o con URL non HTTPS viene rifiutato', () => {
  const base = {
    version: '0.7.0',
    url: 'https://example.invalid/baia.apk',
    signature: 'firma',
  };
  assert.throws(() => androidManifest({ ...base, signature: '   ' }), /Firma/);
  assert.throws(() => androidManifest({ ...base, url: 'http://example.invalid/baia.apk' }), /HTTPS/);
  assert.throws(() => androidManifest({ ...base, version: 'ultima' }), /Versione non valida/);
});

test('versione e URL vengono normalizzati come li legge il client', () => {
  assert.equal(normalizeVersion('v1.2.3'), '1.2.3');
  assert.equal(normalizeVersion(' 1.2.3 '), '1.2.3');
  assert.equal(normalizeUrl('https://example.invalid/a.apk'), 'https://example.invalid/a.apk');
  assert.throws(() => normalizeUrl('ftp://example.invalid/a.apk'), /HTTPS/);
});

test('gli argomenti da riga di comando arrivano interi allo script', () => {
  const values = parseArguments(['--version', 'v0.7.0', '--notes', 'due parole', '--dry-run']);
  assert.equal(values.get('version'), 'v0.7.0');
  assert.equal(values.get('notes'), 'due parole');
  assert.equal(values.get('dry-run'), 'true');
});
