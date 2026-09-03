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

test('pagina Musica usa il catalogo API autenticato senza URL locali hardcoded', () => {
  assert.match(html, /src="\/js\/api-config\.js"/);
  assert.match(html, /src="\/js\/shell-bridge\.js"/);
  assert.match(html, /src="\/js\/music\.js"/);
  assert.match(html, /href="\/css\/music\.css"/);
  assert.match(source, /BaiaPage\.apiRequest\('\/api\/music\/home'\)/);
  assert.match(source, /BaiaPage\.apiRequest\('\/api\/music\/filters'\)/);
  assert.match(source, /\/api\/music\/albums/);
  assert.match(source, /\/api\/music\/artists/);
  assert.match(source, /\/api\/music\/tracks/);
  assert.doesNotMatch(html + source, /https?:\/\/(?:127\.0\.0\.1|localhost)/i);
  assert.doesNotMatch(source, /filePath|directoryPath|relativePath/);
});

test('home Musica mantiene solo le card Playlist e Preferiti, centrate e senza sottotitoli', () => {
  assert.match(html, /data-music-section="playlists"/);
  assert.match(html, /data-music-section="favorites"/);
  assert.doesNotMatch(html, /data-music-section="genres"/);
  assert.doesNotMatch(html, /data-music-section="recent"/);
  assert.doesNotMatch(html, /<section class="music-shortcuts"[\s\S]*?<small>/);
  assert.match(css, /\.music-shortcut\s*\{[\s\S]*flex-direction:\s*column;[\s\S]*align-items:\s*center;[\s\S]*justify-content:\s*center;[\s\S]*text-align:\s*center/);
  assert.match(css, /\.music-shortcut strong\s*\{[\s\S]*font-size:\s*18px/);
  assert.match(css, /\.music-shortcut-icon\s*\{[\s\S]*width:\s*40px;[\s\S]*height:\s*40px/);
  assert.match(html, /<h2>Riprodotti di recente<\/h2>/);
  assert.match(html, /<h2>Per te<\/h2>/);
  assert.match(source, /home\.recent/);
  assert.match(source, /home\.recommended/);
  assert.match(source, /favoritesOnly/);
});

test('le copertine Musica non hanno contorno chiaro a riposo', () => {
  assert.match(css, /\.music-cover\s*\{[\s\S]*?border:\s*1px solid transparent;/);
  assert.match(css, /\.music-card-button:hover \.music-cover,[\s\S]*?border-color:\s*rgba\(255,255,255,\.55\)/);
  assert.match(css, /\.music-search-cover\s*\{[\s\S]*?border:\s*1px solid transparent;/);
  assert.match(css, /\.music-search-top-main:hover \.music-search-cover,[\s\S]*?border-color:\s*rgba\(255,255,255,\.55\)/);
});

test('catalogo Musica delega la riproduzione al player globale senza creare audio nell iframe', () => {
  assert.match(html, /id="albumsButton"/);
  assert.match(html, /id="artistsButton"/);
  assert.match(html, /id="genreButton"/);
  assert.doesNotMatch(html, /id="genreMenu"/);
  assert.match(source, /genreButton\.addEventListener\('click', \(\) => runNavigation\(showGenres\)\)/);
  assert.doesNotMatch(source, /renderGenreMenu|closeGenreMenu|genreMenu/);
  assert.match(html, /id="albumDetailView"/);
  assert.match(html, /id="artistDetailView"/);
  assert.match(source, /async function openAlbum/);
  assert.match(source, /async function openArtist/);
  assert.match(source, /async function searchMusic/);
  assert.match(css, /\.music-shortcuts/);
  assert.match(css, /\.music-cover/);
  assert.match(css, /\.music-track-row/);
  assert.doesNotMatch(html, /<audio\b|musicMiniPlayer/i);
  assert.match(source, /shellMusicPlayQueue/);
  assert.match(source, /shellMusicCommand\('play-pause'\)/);
  assert.match(source, /shellMusicRequestState/);
  assert.match(source, /music-track-play/);
  assert.match(source, /BaiaPage\.apiFetch\(url\)/);
  assert.match(source, /response\.blob\(\)/);
  assert.match(source, /applyMusicCover/);
  assert.doesNotMatch(source, /authorizeMediaUrl|setMediaSrc/);
});


test('preferiti Musica modificano brani e album tramite PUT e il dettaglio Preferiti filtra i brani', () => {
  assert.match(html, /id="albumFavoriteButton"/);
  assert.match(source, /\/api\/music\/tracks\/\$\{encodeURIComponent\(track\.trackId\)\}\/favorite/);
  assert.match(source, /\/api\/music\/albums\/\$\{encodeURIComponent\(album\.albumId\)\}\/favorite/);
  assert.match(source, /method: 'PUT'/);
  assert.match(source, /favoritesOnly=1/);
  assert.match(source, /state\.detailFavoritesOnly = state\.mode === 'favorites'/);
  assert.match(css, /\.music-favorite-button/);
  assert.match(css, /\.music-favorite-action/);
});

test('pagina Musica accetta dalla shell la navigazione logica verso album e artista', () => {
  assert.match(source, /shell-music-navigate/);
  assert.match(source, /event\.data\.target === 'album'/);
  assert.match(source, /event\.data\.target === 'artist'/);
  assert.doesNotMatch(source, /filePath|directoryPath|relativePath/);
});


test('Recenti e Per te si aggiornano senza chiudere il dettaglio musicale corrente', () => {
  assert.match(source, /shell-music-history-updated/);
  assert.match(source, /scheduleMusicHistoryRefresh/);
  assert.match(source, /async function refreshMusicHistory/);
  assert.match(source, /applyMusicHome\(home\)/);
  assert.match(source, /state\.mode === 'recent' && !elements\.browseView\.hidden/);
});


test('ogni vista con brani può aggiungerli alla coda globale', () => {
  assert.match(source, /function addTrackToQueue/);
  assert.match(source, /shellMusicAddToQueue/);
  assert.match(source, /music-track-add-queue/);
  assert.match(source, /music-card-queue-button/);
  assert.match(source, /music-search-track-card/);
  assert.match(css, /\.music-track-add-queue/);
  assert.match(css, /\.music-card-queue-button/);
});
