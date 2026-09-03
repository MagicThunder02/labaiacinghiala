'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const html = read('public/pages/music.html');
const source = read('public/js/music.js');
const css = read('public/css/music.css');

test('barra di ricerca Musica resta visibile insieme ai pulsanti Home Album Artisti e Generi', () => {
  assert.match(html, /class="music-global-search"/);
  assert.match(html, /id="searchInput"/);
  assert.match(html, /<label class="sr-only" for="searchInput">Cerca brani, album, artisti e generi<\/label>/);
  assert.doesNotMatch(html, /id="searchInput"[^>]*placeholder=/);
  assert.match(html, /id="searchClearButton"/);
  assert.match(html, /id="homeButton"/);
  assert.match(html, /id="albumsButton"/);
  assert.match(html, /id="artistsButton"/);
  assert.match(html, /id="genreButton"/);
  assert.doesNotMatch(html, /id="searchModeButton"/);
  assert.match(css, /\.music-global-search/);
  assert.match(css, /border-radius:\s*999px/);
  assert.match(css, /background:\s*linear-gradient\(135deg, rgba\(255,255,255,\.075\), rgba\(255,255,255,\.035\)\)/);
  assert.doesNotMatch(css, /\.music-global-search[\s\S]{0,500}background:\s*#f2f2f2/);
  assert.match(css, /\.music-global-search\s*\{[\s\S]*box-shadow:\s*none/);
  assert.match(css, /\.music-global-search:focus-within\s*\{[\s\S]*box-shadow:\s*none;[\s\S]*transform:\s*none/);
});

test('ricerca unificata usa endpoint autenticato, due caratteri e risultati raggruppati in stile Spotify', () => {
  assert.match(source, /\/api\/music\/search\?/);
  assert.match(source, /search\.length < 2/);
  assert.match(source, /Risultato principale/);
  assert.match(source, /createSearchTrackSection/);
  assert.match(source, /createSearchMediaSection\('Album'/);
  assert.match(source, /createSearchMediaSection\('Artisti'/);
  assert.match(source, /createSearchMediaSection\('Generi'/);
  assert.match(source, /music-search-play-button/);
  assert.doesNotMatch(source, /https?:\/\/(?:127\.0\.0\.1|localhost)/i);
});

test('card di ricerca mostrano copertine, collage artista e genere e segnaposto locale', () => {
  assert.match(source, /applyMusicCover\(cover, item\.coverUrl\)/);
  assert.match(source, /applyCoverCollage\(cover, item\.coverUrls, item\.name\)/);
  assert.match(source, /slice\(0, 4\)/);
  assert.match(source, /artistInitials/);
  assert.match(css, /\.music-search-cover-artist/);
  assert.match(css, /\.music-search-cover-genre/);
  assert.match(css, /\.music-search-collage-tile/);
});

test('chiudendo ricerca o tornando da album e artista viene ripristinata la vista precedente', () => {
  assert.match(source, /searchReturnMode/);
  assert.match(source, /searchReturnScrollY/);
  assert.match(source, /restoreSearchReturnMode/);
  assert.match(source, /detailReturnScrollY/);
  assert.match(source, /function returnFromDetail/);
  assert.match(source, /window\.scrollTo\(\{ top: state\.detailReturnScrollY/);
});
