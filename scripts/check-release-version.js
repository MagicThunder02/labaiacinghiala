'use strict';

// Il tag di release diventa il numero di versione che i client già installati
// confrontano con il proprio. Se package.json, Cargo.toml e tauri.conf.json non
// concordano con il tag, l'updater annuncerebbe una versione diversa da quella
// che installa: meglio fermare la pubblicazione prima della build.

const fs = require('node:fs');
const path = require('node:path');

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function normalizeTag(tag) {
  const value = String(tag || '').trim();
  return value.startsWith('v') ? value.slice(1) : value;
}

function cargoVersion(manifest) {
  const packageSection = String(manifest).split(/^\[/m).find((section) => section.startsWith('package]'));
  const match = packageSection?.match(/^\s*version\s*=\s*"([^"]+)"/m);
  return match ? match[1] : null;
}

/**
 * Confronta il tag con le versioni dichiarate. Restituisce l'elenco delle
 * incoerenze: vuoto significa che la release può partire.
 */
function releaseVersionReport(tag, versions) {
  const expected = normalizeTag(tag);
  const problems = [];
  if (!SEMVER.test(expected)) {
    problems.push(`Tag "${tag}" non è una versione semver (atteso vX.Y.Z).`);
    return { expected, problems };
  }
  for (const [source, value] of Object.entries(versions)) {
    if (value !== expected) {
      problems.push(`${source} dichiara ${value || 'nessuna versione'}, il tag dichiara ${expected}.`);
    }
  }
  return { expected, problems };
}

function readProjectVersions(root) {
  const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
  return {
    'package.json': JSON.parse(read('package.json')).version,
    'src-tauri/Cargo.toml': cargoVersion(read('src-tauri/Cargo.toml')),
    'src-tauri/tauri.conf.json': JSON.parse(read('src-tauri/tauri.conf.json')).version,
  };
}

function main(argv) {
  const tag = argv[2] || process.env.GITHUB_REF_NAME || '';
  const root = path.join(__dirname, '..');
  const { expected, problems } = releaseVersionReport(tag, readProjectVersions(root));
  if (problems.length) {
    for (const problem of problems) console.error(`ERRORE: ${problem}`);
    console.error('Allinea le versioni oppure correggi il tag prima di pubblicare.');
    process.exitCode = 1;
    return;
  }
  console.log(`Versione di release coerente: ${expected}`);
}

if (require.main === module) main(process.argv);

module.exports = { cargoVersion, normalizeTag, readProjectVersions, releaseVersionReport };
