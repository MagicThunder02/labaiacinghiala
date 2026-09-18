'use strict';

// Costruisce latest-android.json, il manifesto che il client Android legge per
// sapere se esiste una versione più recente. Il formato è volutamente minimo e
// parallelo a quello desktop di Tauri: versione, note, data, URL e firma
// minisign dell'APK. La firma è la stessa catena di fiducia del desktop.

const fs = require('node:fs');
const path = require('node:path');

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith('--')) continue;
    const name = current.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      values.set(name, 'true');
      continue;
    }
    values.set(name, next);
    index += 1;
  }
  return values;
}

function normalizeVersion(value) {
  const version = String(value || '').trim().replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Versione non valida per il manifesto Android: "${value}".`);
  }
  return version;
}

/**
 * Il client rifiuta tutto ciò che non è HTTPS: inutile pubblicare un manifesto
 * che non potrebbe funzionare.
 */
function normalizeUrl(value) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'https:') throw new Error('L’URL dell’APK deve essere HTTPS.');
  return url.toString();
}

function androidManifest({ version, url, signature, notes = '', publishedAt }) {
  const trimmedSignature = String(signature || '').trim();
  if (!trimmedSignature) throw new Error('Firma dell’APK mancante.');
  return {
    version: normalizeVersion(version),
    notes: String(notes || '').trim(),
    pub_date: publishedAt || new Date().toISOString(),
    url: normalizeUrl(url),
    signature: trimmedSignature,
  };
}

function main(argv) {
  const options = parseArguments(argv.slice(2));
  const signaturePath = options.get('signature');
  if (!signaturePath) throw new Error('Serve --signature con il percorso del file .sig.');

  const manifest = androidManifest({
    version: options.get('version'),
    url: options.get('url'),
    signature: fs.readFileSync(signaturePath, 'utf8'),
    notes: options.get('notes'),
    publishedAt: options.get('published-at'),
  });

  const output = options.get('output') || 'latest-android.json';
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`Manifesto Android scritto in ${output} per la versione ${manifest.version}.`);
}

if (require.main === module) main(process.argv);

module.exports = { androidManifest, normalizeUrl, normalizeVersion, parseArguments };
