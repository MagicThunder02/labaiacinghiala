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
const listeningState = read('public/js/music-listening-state.js');
const css = read('public/css/app-shell.css');

test('motore audio e mini-player vivono nella shell globale, non negli iframe', () => {
  assert.match(index, /src="\/js\/music-player-state\.js"/);
  assert.match(index, /src="\/js\/music-listening-state\.js"/);
  assert.match(index, /src="\/js\/music-player-visibility\.js"/);
  assert.match(index, /id="musicMiniPlayer"/);
  assert.match(index, /id="musicMiniCover"/);
  assert.match(index, /id="musicMiniTitle"/);
  assert.match(index, /id="musicMiniArtist"/);
  assert.match(index, /id="musicMiniCollapseButton"/);
  assert.match(index, /id="musicMiniRestoreButton"/);
  assert.match(index, /id="musicMiniProgress"/);
  assert.match(index, /id="musicPreviousButton"/);
  assert.match(index, /id="musicPlayPauseButton"/);
  assert.match(index, /id="musicNextButton"/);
  assert.match(index, /id="musicModeButton"/);
  assert.match(index, /id="musicMiniVolumeButton"/);
  assert.match(index, /id="musicMiniVolume"/);
  assert.match(index, /<audio id="musicAudio"/);
  assert.match(css, /\.music-mini-player\s*\{/);
  assert.match(css, /body\.has-music-player \.shell-main/);
  assert.match(css, /position:\s*fixed/);
});

test('shell firma solo lo stream logico e mantiene comandi musicali limitati', () => {
  assert.match(shell, /BaiaApi\.authorizeMediaUrl\(track\.streamUrl\)/);
  assert.match(shell, /shell-music-play-queue/);
  assert.match(shell, /shell-music-command/);
  assert.match(shell, /elements\.musicAudio\.addEventListener\('ended'/);
  assert.match(shell, /elements\.musicAudio\.currentTime > 3/);
  assert.match(shell, /normal:\s*'Normale'/);
  assert.match(shell, /shuffle:\s*'Shuffle'/);
  assert.match(shell, /repeat:\s*'Ripeti'/);
  assert.match(shell, /'repeat-one':\s*'Ripeti 1'/);
  assert.match(bridge, /shellMusicPlayQueue/);
  assert.match(bridge, /shellMusicCommand/);
  assert.match(bridge, /shellMusicRequestState/);
  assert.doesNotMatch(shell + bridge, /privateKey|sign\s*\(/i);
  assert.doesNotMatch(shell, /visibilitychange[\s\S]{0,180}musicAudio\.pause/);
});

test('player grande vive nella shell con copertina, sfondo sfocato, menu e coda', () => {
  for (const id of [
    'musicFullPlayer',
    'musicFullBackdrop',
    'musicFullBackButton',
    'musicFullMenuButton',
    'musicGoArtistButton',
    'musicGoAlbumButton',
    'musicShowQueueButton',
    'musicFullArtwork',
    'musicFullTitle',
    'musicFullSubtitle',
    'musicFullProgress',
    'musicFullVolumeButton',
    'musicFullVolume',
    'musicQueuePanel',
    'musicQueueList',
  ]) assert.match(index, new RegExp(`id="${id}"`));

  assert.match(css, /\.music-full-player\s*\{/);
  assert.match(index, /class="music-full-visual"/);
  assert.match(index, /<img id="musicFullBackdrop" class="music-full-backdrop-image"/);
  assert.match(css, /\.music-full-backdrop-image\s*\{/);
  assert.match(css, /filter:\s*blur\(/);
  assert.match(index, /class="music-full-color-wash"/);
  assert.match(index, /class="music-full-shade"/);
  assert.match(css, /\.music-full-color-wash\s*\{/);
  assert.match(css, /\.music-full-shade\s*\{/);
  assert.match(css, /\.music-full-artwork\s*\{/);
  assert.match(css, /\.music-queue-panel\s*\{/);
  assert.match(shell, /function setMusicFullPlayerOpen/);
  assert.match(shell, /function renderMusicQueue/);
  assert.match(shell, /navigateMusicDetail\('artist'/);
  assert.match(shell, /navigateMusicDetail\('album'/);
  assert.match(shell, /shell-music-navigate/);
  assert.match(shell, /musicPlayerState\.selectTrack/);
});


test('shell registra ascolti con PUT autenticato senza fermarsi quando perde visibilità', () => {
  assert.match(shell, /\/api\/music\/tracks\/\$\{encodeURIComponent\(normalizedTrackId\)\}\/listening/);
  assert.match(shell, /method:\s*'PUT'/);
  assert.match(shell, /listenedSeconds/);
  assert.match(shell, /reportMusicListening\('checkpoint'\)/);
  assert.match(shell, /reportMusicListening\('ended'/);
  assert.match(shell, /15000/);
  assert.match(shell, /shell-music-history-updated/);
  assert.match(listeningState, /maximumCredibleDelta/);
  assert.match(listeningState, /mediaDelta > 0/);
  assert.doesNotMatch(shell, /visibilitychange[\s\S]{0,180}musicAudio\.pause/);
});


test('Film e Serie mettono in pausa senza cancellare la coda e il mini-player non copre la sidebar', () => {
  const visibility = read('public/js/music-player-visibility.js');
  assert.match(visibility, /\['films', 'series'\]/);
  assert.match(shell, /function applyMusicPagePolicy/);
  assert.match(shell, /if \(!elements\.musicAudio\.paused\) elements\.musicAudio\.pause\(\)/);
  assert.match(shell, /applyMusicPagePolicy\(pageId\)/);
  assert.match(shell, /musicMiniPlayer\.classList\.toggle\('is-collapsed'/);
  assert.match(shell, /musicMiniRestoreButton\.hidden/);
  assert.doesNotMatch(shell, /applyMusicPagePolicy[\s\S]{0,500}(?:setQueue\(\[\]|clearQueue|musicPlayerState\.clear)/);
  assert.match(css, /\.sidebar:hover ~ \.music-mini-player/);
  assert.match(
    css,
    /\.sidebar:hover ~ \.music-mini-player[\s\S]*?left:\s*calc\(var\(--sidebar-width\) \+ var\(--sidebar-tab-width\)\)/,
  );
  assert.doesNotMatch(
    css,
    /\.sidebar:hover ~ \.music-mini-player[\s\S]*?\{[\s\S]*?left:\s*var\(--sidebar-width\)\s*;/,
  );
  assert.match(css, /\.music-mini-player\.is-collapsed/);
  assert.match(css, /\.music-mini-restore/);
});
