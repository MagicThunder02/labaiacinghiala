'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  cargoVersion,
  normalizeTag,
  readProjectVersions,
  releaseVersionReport,
} = require('../scripts/check-release-version');

test('il tag di release viene normalizzato e validato come semver', () => {
  assert.equal(normalizeTag('v1.2.3'), '1.2.3');
  assert.equal(normalizeTag(' 1.2.3 '), '1.2.3');
  assert.deepEqual(releaseVersionReport('v1.2', {}).problems.length, 1);
  assert.match(releaseVersionReport('release-1', {}).problems[0], /non è una versione semver/);
});

test('la release si ferma se una versione dichiarata non combacia con il tag', () => {
  const allineate = releaseVersionReport('v0.6.0', {
    'package.json': '0.6.0',
    'src-tauri/Cargo.toml': '0.6.0',
    'src-tauri/tauri.conf.json': '0.6.0',
  });
  assert.deepEqual(allineate.problems, []);
  assert.equal(allineate.expected, '0.6.0');

  const disallineate = releaseVersionReport('v0.6.0', {
    'package.json': '0.6.0',
    'src-tauri/Cargo.toml': '0.5.0',
    'src-tauri/tauri.conf.json': null,
  });
  assert.equal(disallineate.problems.length, 2);
  assert.match(disallineate.problems[0], /Cargo\.toml dichiara 0\.5\.0/);
  assert.match(disallineate.problems[1], /nessuna versione/);
});

test('la versione Cargo viene letta dalla sezione package e non dalle dipendenze', () => {
  const manifest = [
    '[package]',
    'name = "baia-cinghiala"',
    'version = "0.5.0"',
    '',
    '[dependencies]',
    'tauri = { version = "2", features = [] }',
  ].join('\n');
  assert.equal(cargoVersion(manifest), '0.5.0');
});

test('le versioni del progetto sono allineate tra loro', () => {
  const versions = readProjectVersions(path.join(__dirname, '..'));
  const dichiarate = new Set(Object.values(versions));
  assert.equal(dichiarate.size, 1, `versioni non allineate: ${JSON.stringify(versions)}`);
});
