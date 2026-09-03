'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const index = read('public/index.html');
const shell = read('public/js/app-shell.js');
const bridge = read('public/js/shell-bridge.js');
const css = read('public/css/app-shell.css');

test('coda offre trascinamento, controlli accessibili, rimozione e svuotamento manuale', () => {
  assert.match(index, /id="musicQueueClearButton"/);
  assert.match(shell, /row\.draggable = true/);
  assert.match(shell, /addEventListener\('dragstart'/);
  assert.match(shell, /addEventListener\('drop'/);
  assert.match(shell, /moveMusicQueueTrack/);
  assert.match(shell, /removeMusicQueueTrack/);
  assert.match(shell, /clearMusicQueue/);
  assert.match(shell, /music-queue-up/);
  assert.match(shell, /music-queue-down/);
  assert.match(shell, /music-queue-remove/);
  assert.match(css, /\.music-queue-drag-handle/);
  assert.match(css, /\.music-queue-action/);
  assert.match(css, /\.music-queue-panel\s*\{[\s\S]*?position:\s*fixed/);
  assert.ok(index.indexOf('id="musicQueuePanel"') > index.indexOf('</section>'), 'La coda deve poter restare visibile anche quando il player grande si chiude.');
});


test('la coda usa Brani in coda come unica intestazione', () => {
  assert.match(index, /id="musicQueueTitle" class="music-queue-eyebrow" role="heading" aria-level="2">Brani in coda<\/span>/);
  assert.doesNotMatch(index, /<span class="music-queue-eyebrow">Coda<\/span>/);
  assert.doesNotMatch(index, /<h2 id="musicQueueTitle">/);
  assert.match(shell, /musicQueueTitle\.textContent = 'Brani in coda'/);
  assert.doesNotMatch(shell, /musicQueueTitle\.textContent = snapshot\?\.context\?\.title/);
});

test('aggiunta alla coda passa soltanto dal bridge della shell e non accede a file locali', () => {
  assert.match(bridge, /function shellMusicAddToQueue/);
  assert.match(bridge, /append-tracks/);
  assert.match(shell, /case 'append-tracks': return appendMusicQueue\(payload\)/);
  assert.doesNotMatch(shell + bridge, /filePath|directoryPath|relativePath|privateKey|sign\s*\(/i);
});

test('riordino manuale comunica il ritorno alla modalità Normale', () => {
  assert.match(shell, /Modalità Normale attivata/);
  assert.match(shell, /musicPlayerState\?\.moveTrack/);
  assert.match(shell, /broadcastMusicState\(\{ immediate: true \}\)/);
});
