const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const filmsHtml = fs.readFileSync(path.join(root, 'public/pages/films.html'), 'utf8');
const seriesHtml = fs.readFileSync(path.join(root, 'public/pages/series.html'), 'utf8');
const filmsJs = fs.readFileSync(path.join(root, 'public/js/films.js'), 'utf8');
const seriesJs = fs.readFileSync(path.join(root, 'public/js/series.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/css/films.css'), 'utf8');

for (const [name, html, script] of [
  ['Film', filmsHtml, filmsJs],
  ['Serie', seriesHtml, seriesJs],
]) {
  test(`${name}: il player conserva soltanto il controllo laterale del volume`, () => {
    assert.match(html, /class="player-side-controls"[^>]*aria-label="Volume video"/);
    assert.match(html, /id="playerVolume"[^>]*aria-label="Volume"/);
    assert.doesNotMatch(html, /playerBrightness|playerDimmingOverlay|Luminosità video|brightness-icon/);
    assert.doesNotMatch(script, /PLAYER_BRIGHTNESS_STORAGE_KEY|playerBrightness|playerDimmingOverlay|setPlayerBrightness|baia-player-brightness/);
  });

  test(`${name}: il pallino del volume compare soltanto mentre il valore cambia`, () => {
    assert.match(script, /function showPlayerVolumeThumb\(\)/);
    assert.match(script, /elements\.playerVolume\.classList\.add\('is-interacting'\)/);
    assert.match(script, /elements\.playerVolume\.classList\.remove\('is-interacting'\)/);
    assert.match(script, /elements\.playerVolume\.addEventListener\('input',[\s\S]*showPlayerVolumeThumb\(\)/);
  });
}

test('il volume riprende lo stile bianco del player musicale, in verticale e più lungo', () => {
  assert.match(css, /\.player-side-controls\s*\{[\s\S]*top:\s*50%;[\s\S]*transform:\s*translateY\(-50%\)/);
  assert.match(css, /\.player-side-control\s*\{[\s\S]*height:\s*clamp\(270px, 38vh, 344px\)/);
  assert.match(css, /\.player-side-slider\s*\{[\s\S]*top:\s*50%;[\s\S]*width:\s*clamp\(168px, 24vh, 224px\)/);
  assert.match(css, /#fff var\(--side-progress\),[\s\S]*rgba\(255, 255, 255, \.24\) var\(--side-progress\)/);
  assert.match(css, /\.player-side-slider::-webkit-slider-runnable-track\s*\{[\s\S]*height:\s*4px/);
  assert.match(css, /\.player-side-slider::-moz-range-progress\s*\{[\s\S]*background:\s*#fff/);
  assert.doesNotMatch(css, /\.player-side-slider[\s\S]{0,600}var\(--film-accent\)/);
});

test('il thumb del volume è bianco, senza ombra e visibile soltanto durante il movimento', () => {
  assert.match(css, /\.player-side-slider::-webkit-slider-thumb\s*\{[\s\S]*width:\s*13px;[\s\S]*border:\s*0;[\s\S]*background:\s*#fff;[\s\S]*box-shadow:\s*none;[\s\S]*opacity:\s*0/);
  assert.match(css, /\.player-side-slider\.is-interacting::-webkit-slider-thumb\s*\{[\s\S]*opacity:\s*1;[\s\S]*transform:\s*scale\(1\)/);
  assert.match(css, /\.player-side-slider::-moz-range-thumb\s*\{[\s\S]*width:\s*13px;[\s\S]*border:\s*0;[\s\S]*background:\s*#fff;[\s\S]*box-shadow:\s*none;[\s\S]*opacity:\s*0/);
  assert.match(css, /\.player-side-slider\.is-interacting::-moz-range-thumb\s*\{[\s\S]*opacity:\s*1;[\s\S]*transform:\s*scale\(1\)/);
  assert.match(css, /\.player-side-slider:focus-visible\s*\{\s*filter:\s*none;/);
  assert.doesNotMatch(css, /player-dimming-overlay|brightness-icon|brightness\.svg/);
});

test('l’icona della luminosità non fa più parte degli asset del player', () => {
  assert.equal(fs.existsSync(path.join(root, 'public/icons/brightness.svg')), false);
});
