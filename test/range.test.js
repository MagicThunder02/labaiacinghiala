const test = require('node:test');
const assert = require('node:assert/strict');
const { parseByteRange } = require('../src/utils/range');

test('interpreta un intervallo esplicito', () => {
  assert.deepEqual(parseByteRange('bytes=10-19', 100), { start: 10, end: 19, length: 10 });
});

test('interpreta un intervallo aperto', () => {
  assert.deepEqual(parseByteRange('bytes=90-', 100), { start: 90, end: 99, length: 10 });
});

test('rifiuta un intervallo oltre il file', () => {
  assert.deepEqual(parseByteRange('bytes=100-120', 100), { invalid: true });
});
