'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'public/js/music.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/css/music.css'), 'utf8');

test('card artista e playlist e dettaglio playlist usano collage di copertine', () => {
  assert.match(source, /type === 'artist' \|\| type === 'playlist'\) applyCoverCollage\(cover, item\.coverUrls, titleValue\)/);
  assert.match(source, /applyCoverCollage\(elements\.playlistDetailCover, playlist\.coverUrls, playlist\.name\)/);
  assert.match(css, /\.music-cover\.has-collage/);
  assert.match(css, /\.music-detail-cover\.has-collage/);
});

test('collage si adatta a una due tre o quattro copertine', () => {
  assert.match(css, /\.music-search-collage-tile:only-child/);
  assert.match(css, /nth-last-child\(2\):first-child/);
  assert.match(css, /nth-last-child\(3\):first-child/);
  assert.match(css, /grid-template-columns: repeat\(2/);
  assert.match(css, /grid-template-rows: repeat\(2/);
});
