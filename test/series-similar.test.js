'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildSimilarSeriesRows } = require('../src/services/series-similar-service');

const root = path.resolve(__dirname, '..');

function row(seriesUuid, genresJson) {
  return { seriesUuid, genresJson };
}

test('Serie simili esclude la serie corrente e conserva soltanto generi condivisi', () => {
  const current = row('current', JSON.stringify(['Drammatico', 'Fantascienza']));
  const result = buildSimilarSeriesRows(current, [
    current,
    row('shared-drama', JSON.stringify(['drammatico'])),
    row('shared-scifi', JSON.stringify(['Fantascienza', 'Avventura'])),
    row('unrelated', JSON.stringify(['Commedia'])),
  ], { limit: 10, random: () => 0.5 });

  assert.deepEqual(new Set(result.map((item) => item.seriesUuid)), new Set(['shared-drama', 'shared-scifi']));
});

test('Serie simili restituisce al massimo dieci risultati e nessun risultato senza generi', () => {
  const candidates = Array.from({ length: 15 }, (_, index) => row(`series-${index}`, JSON.stringify(['Crime'])));
  const result = buildSimilarSeriesRows(row('current', JSON.stringify(['crime'])), candidates, {
    limit: 10,
    random: () => 0.25,
  });

  assert.equal(result.length, 10);
  assert.deepEqual(buildSimilarSeriesRows(row('empty', '[]'), candidates), []);
});

test('la nuova API Serie simili è additiva e resta sotto il router Serie autenticato', () => {
  const routeSource = fs.readFileSync(path.join(root, 'src/routes/series.js'), 'utf8');
  const serverSource = fs.readFileSync(path.join(root, 'src/server.js'), 'utf8');

  assert.match(routeSource, /router\.get\('\/:seriesUuid\/similar'/);
  assert.match(routeSource, /buildSimilarSeriesRows\(currentRow, listSeries\.all\(\), \{ limit: 10 \}\)/);
  assert.match(routeSource, /res\.set\('Cache-Control', 'no-store'\)/);
  assert.match(serverSource, /app\.use\('\/api\/series', requireSection\('series'\), seriesRouter\)/);
});
