const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'node_modules', 'pdfjs-dist', 'build');
const destination = path.join(root, 'public', 'vendor', 'pdfjs');
const files = ['pdf.min.mjs', 'pdf.worker.min.mjs'];

if (!fs.existsSync(source)) {
  console.error('pdfjs-dist non trovato. Esegui npm.cmd install dalla root del progetto.');
  process.exitCode = 1;
  return;
}

fs.mkdirSync(destination, { recursive: true });
for (const file of files) {
  fs.copyFileSync(path.join(source, file), path.join(destination, file));
}
console.log(`PDF.js copiato in ${path.relative(root, destination)}`);
