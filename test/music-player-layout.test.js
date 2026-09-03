'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const index = read('public/index.html');
const shell = read('public/js/app-shell.js');
const css = read('public/css/app-shell.css');

test('player grande allinea modalità, trasporto e volume alla barra di avanzamento', () => {
  assert.match(index, /class="music-full-controls"[\s\S]*id="musicFullModeButton"[\s\S]*class="music-full-transport"[\s\S]*id="musicFullPlayPauseButton"[\s\S]*class="music-full-volume"/);
  assert.match(index, /id="musicFullVolumeButton"/);
  assert.match(index, /id="musicFullVolume"[^>]*type="range"[^>]*max="1"/);
  assert.match(css, /\.music-full-timeline\s*\{[\s\S]*grid-template-columns:\s*48px minmax\(100px, 1fr\) 48px/);
  assert.match(css, /\.music-full-controls\s*\{[\s\S]*grid-template-columns:\s*var\(--music-full-side-column\)/);
  assert.match(css, /\.music-full-transport\s*\{[\s\S]*justify-self:\s*center/);
  assert.match(css, /\.music-full-volume\s*\{[\s\S]*justify-self:\s*end/);
  assert.match(css, /\.music-full-volume-range\s*\{?[\s\S]*width:/);
});

test('titolo e mini-player seguono la rifinitura grafica concordata', () => {
  assert.match(index, /id="musicMiniTitle"/);
  assert.match(index, /id="musicMiniArtist"/);
  assert.match(css, /:root\s*\{\s*--music-mini-player-height:\s*78px/);
  assert.match(css, /\.music-mini-player\s*\{[\s\S]*background:\s*#000/);
  assert.match(css, /\.music-mini-player\s*\{[\s\S]*box-shadow:\s*none/);
  assert.match(css, /\.music-mini-cover\s*\{[\s\S]*width:\s*66px;[\s\S]*height:\s*66px/);
  assert.match(css, /\.music-mini-player\s*\{[\s\S]*--music-mini-inset:\s*6px;[\s\S]*padding:[^;]*var\(--music-mini-inset\)[^;]*var\(--music-mini-inset\);/);
  assert.match(css, /\.music-mini-track\s*\{[\s\S]*grid-template-rows:\s*auto auto minmax\(0, 1fr\);[\s\S]*padding:\s*5px 0/);
  assert.match(css, /\.music-mini-title\s*\{[\s\S]*font-size:\s*15px/);
  assert.match(css, /\.music-mini-artist\s*\{[\s\S]*color:\s*rgba\(255, 255, 255, \.56\);[\s\S]*font-size:\s*11\.5px/);
  assert.match(css, /\.music-mini-progress-wrap\s*\{[\s\S]*align-self:\s*end/);
  assert.match(shell, /musicMiniArtist:\s*document\.querySelector\('#musicMiniArtist'\)/);
  assert.match(shell, /elements\.musicMiniArtist\.textContent = artist \|\| 'Artista sconosciuto'/);
  assert.match(css, /\.music-full-copy h1\s*\{[^}]*font-weight:\s*650;[^}]*text-transform:\s*none/);
  assert.match(css, /\.music-full-copy h1\s*\{[^}]*line-height:\s*1\.16;[^}]*padding-block:\s*\.08em \.12em;/);
  assert.doesNotMatch(css, /\.music-full-copy h1\s*\{[^}]*text-transform:\s*uppercase/);
  assert.match(css, /\.music-full-copy,\s*\.music-full-copy h1\s*\{[\s\S]*background:\s*transparent/);
  assert.match(index, /class="music-full-visual"[\s\S]*<img id="musicFullBackdrop" class="music-full-backdrop-image"/);
  assert.match(index, /class="music-full-color-wash"/);
  assert.match(index, /class="music-full-shade"/);
  assert.match(css, /\.music-full-visual\s*\{[\s\S]*z-index:\s*0;[\s\S]*overflow:\s*hidden/);
  assert.match(css, /\.music-full-backdrop-image\s*\{[\s\S]*object-fit:\s*cover;[\s\S]*opacity:\s*\.3/);
  assert.doesNotMatch(css, /background-size:\s*150% 150%/);
  assert.doesNotMatch(css, /\.music-full-(?:backdrop-image|color-wash|shade)\s*\{[\s\S]*?z-index:\s*-/);
  assert.doesNotMatch(css, /mix-blend-mode\s*:/);
  assert.match(css, /\.music-full-color-wash\s*\{[\s\S]*--music-color-a/);
  assert.match(css, /\.music-full-shade\s*\{[\s\S]*linear-gradient/);
  assert.match(shell, /async function extractMusicCoverPalette/);
  assert.match(shell, /function applyMusicPlayerPalette/);
  assert.match(shell, /elements\.musicFullBackdrop\.removeAttribute\('src'\)/);
  assert.match(shell, /elements\.musicFullBackdrop\.src = objectUrl/);
  assert.match(shell, /elements\.musicFullBackdrop\.hidden = false/);
  assert.match(shell, /void updateMusicPlayerPalette\(musicCoverObjectUrl, token, track\.trackId\)/);
});

test('pallino delle barre di avanzamento compare solo durante l interazione', () => {
  assert.match(css, /\.music-mini-progress::-webkit-slider-thumb,\s*\.music-full-progress::-webkit-slider-thumb\s*\{[\s\S]*opacity:\s*0/);
  assert.match(css, /\.music-mini-progress\.is-interacting::-webkit-slider-thumb,\s*\.music-full-progress\.is-interacting::-webkit-slider-thumb\s*\{[\s\S]*opacity:\s*1/);
  assert.match(shell, /function bindTransientMusicSliderThumb/);
  assert.match(shell, /setMusicProgressThumbVisible\(control, false, 500\)/);
  assert.match(shell, /bindTransientMusicSliderThumb\(elements\.musicFullProgress\)/);
  assert.match(shell, /bindTransientMusicSliderThumb\(elements\.musicMiniProgress\)/);
});

test('volume e mute del mini-player sono permanenti e orizzontali', () => {
  assert.match(index, /id="musicMiniVolumeButton"[^>]*aria-label="Disattiva audio"/);
  assert.match(index, /id="musicMiniVolume"[^>]*type="range"/);
  assert.doesNotMatch(index, /id="musicMiniVolumePopover"/);
  assert.match(shell, /function setMusicVolume/);
  assert.match(shell, /function toggleMusicMute/);
  assert.match(shell, /musicLastAudibleVolume/);
  assert.match(shell, /elements\.musicMiniVolumeButton\.addEventListener\('click', toggleMusicMute\)/);
  assert.match(shell, /elements\.musicMiniVolume\.addEventListener\('input', \(\) => setMusicVolume/);
  assert.match(css, /\.music-mini-volume-range\s*\{[\s\S]*position:\s*static;[\s\S]*transform:\s*none/);
  assert.match(css, /\.music-mini-player \.music-mini-volume-range\s*\{[\s\S]*position:\s*static;[\s\S]*width:\s*var\(--music-mini-volume-width\);[\s\S]*transform:\s*none/);
  assert.match(shell, /elements\.musicAudio\.addEventListener\('volumechange', syncMusicVolumeUi\)/);
  assert.match(shell, /volume:\s*Number\(elements\.musicAudio\?\.volume/);
  assert.match(shell, /muted:\s*Boolean\(elements\.musicAudio\?\.muted\)/);
  assert.doesNotMatch(shell, /localStorage\.(?:setItem|getItem)\([^\n]*volume/i);
});


test('un nuovo brano apre il player grande solo alla prima sessione audio', () => {
  assert.match(shell, /const hadTrackBeforeQueue = Boolean\(musicPlayerState\.currentTrack\(\)\)/);
  assert.match(shell, /const fullPlayerWasOpen = Boolean\(musicFullPlayerOpen\)/);
  assert.match(shell, /if \(fullPlayerWasOpen \|\| \(!hadTrackBeforeQueue && payload\.openPlayer !== false\)\) \{\s*setMusicFullPlayerOpen\(true\)/);
  assert.doesNotMatch(shell, /playCurrentMusicTrack\(\{ autoplay: payload\.autoplay !== false \}\);\s*if \(payload\.openPlayer !== false\) setMusicFullPlayerOpen\(true\)/);
});

test('mini-player è più basso e allinea controlli, progresso e comandi laterali senza alterare il player grande', () => {
  assert.match(index, /id="musicMiniCover"[\s\S]*id="musicModeButton"[\s\S]*id="musicPreviousButton"[\s\S]*id="musicPlayPauseButton"[\s\S]*id="musicNextButton"[\s\S]*id="musicMiniVolumeButton"[\s\S]*id="musicMiniVolume"[\s\S]*id="musicMiniCollapseButton"/);
  assert.match(css, /:root\s*\{\s*--music-mini-player-height:\s*clamp\(92px, 5\.566vw, 114px\)/);
  assert.match(css, /--music-mini-cover-size:\s*clamp\(62px, 3\.613vw, 74px\)/);
  assert.match(css, /--music-mini-progress-side:\s*clamp\(250px, 21\.973vw, 450px\)/);
  assert.match(css, /\.music-mini-player \.music-play-control\s*\{[\s\S]*left:\s*50%;[\s\S]*width:\s*42px;[\s\S]*height:\s*42px/);
  assert.match(css, /\.music-mini-player \.music-previous-control,[\s\S]*\.music-mini-player \.music-next-control\s*\{[\s\S]*width:\s*36px;[\s\S]*height:\s*36px/);
  assert.match(css, /\.music-mini-player \.music-mini-progress-wrap\s*\{[\s\S]*left:\s*var\(--music-mini-progress-side\);[\s\S]*right:\s*var\(--music-mini-progress-side\);[\s\S]*width:\s*auto/);
  assert.match(css, /\.music-mini-player \.music-mini-volume-wrap\s*\{[\s\S]*top:\s*50%;[\s\S]*transform:\s*translateY\(-50%\)/);
  assert.match(css, /\.music-mini-player \.music-mini-collapse\s*\{[\s\S]*top:\s*40%;[\s\S]*left:\s*calc\(50% \+ 118px\);[\s\S]*transform:\s*translate\(-50%, -50%\)/);
  assert.match(css, /\.music-mini-player \.music-mini-volume-range\s*\{[\s\S]*width:\s*var\(--music-mini-volume-width\)/);
  assert.doesNotMatch(css, /\n\s*\.music-mode-control\s*\{\s*(?:left|top|position):/);
  assert.doesNotMatch(css, /\n\s*\.music-previous-control\s*\{\s*(?:left|top|position):/);
  assert.doesNotMatch(css, /\n\s*\.music-play-control\s*\{\s*(?:left|top|position):/);
  assert.doesNotMatch(css, /\n\s*\.music-next-control\s*\{\s*(?:left|top|position):/);
});


test('collasso è simmetrico alla modalità e i pallini volume sono visibili solo durante l uso', () => {
  assert.match(css, /\.music-mini-player \.music-mode-control\s*\{\s*left:\s*calc\(50% - 118px\)/);
  assert.match(css, /\.music-mini-player \.music-mini-collapse\s*\{[\s\S]*left:\s*calc\(50% \+ 118px\)/);
  assert.match(css, /\.music-volume-range::-webkit-slider-thumb\s*\{[\s\S]*opacity:\s*0/);
  assert.match(css, /\.music-volume-range\.is-interacting::-webkit-slider-thumb\s*\{[\s\S]*opacity:\s*1/);
  assert.match(css, /\.music-volume-range::-moz-range-thumb\s*\{[\s\S]*opacity:\s*0/);
  assert.match(css, /\.music-volume-range\.is-interacting::-moz-range-thumb\s*\{[\s\S]*opacity:\s*1/);
  assert.match(shell, /bindTransientMusicSliderThumb\(elements\.musicFullVolume\)/);
  assert.match(shell, /bindTransientMusicSliderThumb\(elements\.musicMiniVolume\)/);
  assert.match(shell, /const finish = \(\) => \{[\s\S]*setMusicProgressThumbVisible\(control, false\);/);
});
