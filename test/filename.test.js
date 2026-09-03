const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMediaFilename } = require('../src/utils/filename');

test('estrae titolo e anno da un nome comune', () => {
  assert.deepEqual(parseMediaFilename('Interstellar.2014.1080p.mp4'), {
    title: 'Interstellar 1080p',
    year: 2014,
  });
});

test('gestisce un titolo senza anno', () => {
  assert.deepEqual(parseMediaFilename('Il_signore_degli_anelli.mkv'), {
    title: 'Il signore degli anelli',
    year: null,
  });
});
