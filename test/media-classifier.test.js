const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyMedia } = require('../src/utils/media-classifier');

test('classifica un film normale', () => {
  assert.deepEqual(classifyMedia('Film/Interstellar (2014).mp4', 'Interstellar (2014).mp4'), {
    mediaType: 'movie', seriesTitle: null, seasonNumber: null, episodeNumber: null,
  });
});

test('classifica un episodio dalla cartella e dal token SxxExx', () => {
  assert.deepEqual(
    classifyMedia('Serie/Breaking Bad/Stagione 1/Breaking.Bad.S01E02.mkv', 'Breaking.Bad.S01E02.mkv'),
    { mediaType: 'series', seriesTitle: 'Breaking Bad', seasonNumber: 1, episodeNumber: 2 },
  );
});
