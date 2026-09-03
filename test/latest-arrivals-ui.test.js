'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('tutte le home espongono una rail Ultimi arrivi', () => {
  for (const page of [
    'public/pages/films.html',
    'public/pages/series.html',
    'public/pages/books.html',
    'public/pages/comics.html',
    'public/pages/manga.html',
    'public/pages/music.html',
  ]) {
    const html = read(page);
    assert.match(html, /<h2>Ultimi arrivi<\/h2>/);
    assert.match(html, /id="latestRail"/);
    assert.match(html, /id="latestEmpty"/);
    assert.ok(html.indexOf('id="recentRail"') < html.indexOf('id="latestRail"'));
    assert.ok(html.indexOf('id="latestRail"') < html.indexOf('id="recommendedRail"'));
  }
});

test('le pagine collegano il payload latest alle card già esistenti', () => {
  const expectations = [
    ['public/js/films.js', /renderRail\(elements\.latestRail, elements\.latestEmpty, payload\.latest \|\| \[\]\)/],
    ['public/js/series.js', /renderRail\(elements\.latestRail, elements\.latestEmpty, payload\.latest \|\| \[\]\)/],
    ['public/js/reading-library.js', /renderRail\(elements\.latestRail, elements\.latestEmpty, payload\.latest \|\| \[\]\)/],
    ['public/js/music.js', /renderRail\(elements\.latestRail, elements\.latestEmpty, state\.home\.latest \|\| \[\], 'album'\)/],
  ];
  for (const [file, pattern] of expectations) assert.match(read(file), pattern);
});

test('gli endpoint home costruiscono Ultimi arrivi dai timestamp di libreria', () => {
  assert.match(read('src/routes/movies.js'), /latest = buildLatestArrivals\(movies, HOME_LATEST_LIMIT\)/);
  assert.match(read('src/services/series-home-service.js'), /latest: buildLatestArrivals\(items, latestLimit\)/);
  assert.match(read('src/services/reading-home-service.js'), /latest: buildLatestArrivals\(items, latestLimit\)/);
  assert.match(read('src/services/music-home-service.js'), /latest: buildLatestArrivals\(albums, latestLimit\)/);
});
