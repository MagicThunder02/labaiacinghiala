const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const filmsCss = fs.readFileSync(path.join(root, 'public/css/films.css'), 'utf8');
const filmsHtml = fs.readFileSync(path.join(root, 'public/pages/films.html'), 'utf8');
const seriesHtml = fs.readFileSync(path.join(root, 'public/pages/series.html'), 'utf8');

// Le copertine non portano piu un bordo 1px squadrato: il decoro a riposo e assente
// e la geometria arriva dal token condiviso --cover-radius di common-page.css.
test('Film e Serie condividono copertine arrotondate senza decoro a riposo', () => {
  assert.match(filmsHtml, /href="\/css\/films\.css"/);
  assert.match(seriesHtml, /href="\/css\/films\.css"/);

  assert.match(filmsCss, /\.poster-card-button\s*\{[\s\S]*?border-radius:\s*0;/);
  assert.match(filmsCss, /\.poster-frame\s*\{[^}]*?border:\s*0;[^}]*?border-radius:\s*var\(--cover-radius\);[^}]*?box-shadow:\s*none;/);
  assert.match(filmsCss, /\.detail-poster-shell\s*\{[^}]*?border:\s*0;[^}]*?border-radius:\s*var\(--cover-radius\);[^}]*?box-shadow:\s*none;/);
});

// Stesso intento di prima (nessun decoro a riposo, decoro solo in interazione), ma
// il meccanismo e il glow --cover-hover-glow al posto del border-color.
test('il glow delle copertine compare soltanto durante interazione', () => {
  assert.match(
    filmsCss,
    /\.poster-card-button:hover \.poster-frame,\s*\.poster-card-button:focus-visible \.poster-frame\s*\{[^}]*?box-shadow:\s*var\(--cover-hover-glow\);/,
  );
  assert.match(filmsCss, /\.detail-poster-shell:hover\s*\{\s*box-shadow:\s*var\(--cover-hover-glow\);\s*\}/);
  // Su touch il glow non deve restare acceso dopo il tap.
  assert.match(
    filmsCss,
    /@media[\s\S]*?\.poster-card-button:hover \.poster-frame,\s*\.poster-card-button:focus-visible \.poster-frame\s*\{[^}]*?box-shadow:\s*none;/,
  );
});
