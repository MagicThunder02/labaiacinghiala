const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const filmsCss = fs.readFileSync(path.join(root, 'public/css/films.css'), 'utf8');
const filmsHtml = fs.readFileSync(path.join(root, 'public/pages/films.html'), 'utf8');
const seriesHtml = fs.readFileSync(path.join(root, 'public/pages/series.html'), 'utf8');

test('Film e Serie condividono copertine rettangolari senza contorno a riposo', () => {
  assert.match(filmsHtml, /href="\/css\/films\.css"/);
  assert.match(seriesHtml, /href="\/css\/films\.css"/);

  assert.match(filmsCss, /\.poster-card-button\s*\{[\s\S]*?border-radius:\s*0;/);
  assert.match(filmsCss, /\.poster-frame\s*\{[\s\S]*?border:\s*1px solid transparent;[\s\S]*?border-radius:\s*0;/);
  assert.match(filmsCss, /\.detail-poster-shell\s*\{[\s\S]*?border:\s*1px solid transparent;[\s\S]*?border-radius:\s*0;/);
});

test('il contorno delle copertine compare soltanto durante interazione', () => {
  assert.match(
    filmsCss,
    /\.poster-card-button:hover \.poster-frame,\s*\.poster-card-button:focus-visible \.poster-frame\s*\{[\s\S]*?border-color:\s*rgba\(255, 255, 255, \.56\);/,
  );
  assert.match(filmsCss, /\.detail-poster-shell:hover\s*\{\s*border-color:\s*rgba\(255, 255, 255, \.56\);\s*\}/);
  assert.match(
    filmsCss,
    /@media[\s\S]*?\.poster-card-button:hover \.poster-frame,\s*\.poster-card-button:focus-visible \.poster-frame\s*\{[\s\S]*?border-color:\s*transparent;/,
  );
});
