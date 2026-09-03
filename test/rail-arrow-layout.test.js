'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

const pages = [
  'public/pages/films.html',
  'public/pages/series.html',
  'public/pages/books.html',
  'public/pages/comics.html',
  'public/pages/manga.html',
  'public/pages/music.html',
];

test('tutte le pagine con rail usano le maniglie condivise esterne', () => {
  for (const page of pages) {
    const html = read(page);
    assert.match(html, /href="\/css\/films\.css"/);
    assert.match(html, /class="rail-arrow rail-arrow-left"/);
    assert.match(html, /class="rail-arrow rail-arrow-right"/);
  }
});

test('le maniglie vivono in colonne Grid oltre la linea dei titoli', () => {
  const css = read('public/css/films.css');

  assert.match(
    css,
    /\.showcase-shell\s*\{[\s\S]*?--rail-arrow-width:\s*clamp\(24px,\s*3vw,\s*40px\);[\s\S]*?--rail-arrow-gap:\s*clamp\(8px,\s*1vw,\s*16px\);[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:\s*var\(--rail-arrow-width\) minmax\(0,\s*1fr\) var\(--rail-arrow-width\);[\s\S]*?margin-inline:\s*calc\(0px - var\(--rail-outer-gutter\)\);/,
  );
  assert.match(css, /\.poster-rail\s*\{\s*grid-column:\s*2;\s*min-width:\s*0;/);
  assert.match(css, /\.rail-arrow\s*\{[\s\S]*?position:\s*static;[\s\S]*?grid-row:\s*1;[\s\S]*?width:\s*100%;/);
  assert.match(css, /\.rail-arrow-left\s*\{\s*grid-column:\s*1;\s*border-radius:\s*8px 0 0 8px;\s*\}/);
  assert.match(css, /\.rail-arrow-right\s*\{\s*grid-column:\s*3;\s*border-radius:\s*0 8px 8px 0;\s*\}/);
});

test('le maniglie non dipendono da coordinate assolute della pagina', () => {
  const css = read('public/css/films.css');
  const arrowRule = css.match(/\.rail-arrow\s*\{([\s\S]*?)\}/)?.[1] || '';

  assert.match(arrowRule, /position:\s*static;/);
  assert.doesNotMatch(arrowRule, /\b(?:left|right|top|bottom):/);
});

test('la rail Film simili lascia visibili le colonne esterne senza uscire dal dettaglio', () => {
  const css = read('public/css/films.css');

  assert.match(css, /\.detail-similar-section\s*\{[\s\S]*?overflow:\s*visible;/);
  assert.match(
    css,
    /\.detail-similar-shell\s*\{[\s\S]*?--rail-arrow-width:\s*clamp\(24px,\s*2vw,\s*32px\);[\s\S]*?--rail-arrow-gap:\s*clamp\(8px,\s*\.75vw,\s*12px\);/,
  );
  assert.match(
    css,
    /@media \(max-width:\s*1050px\)[\s\S]*?\.detail-similar-shell\s*\{\s*--rail-arrow-width:\s*18px;\s*--rail-arrow-gap:\s*6px;\s*\}/,
  );
});

test('su viewport stretti o touch la Grid laterale scompare senza lasciare margini', () => {
  const css = read('public/css/films.css');

  assert.match(
    css,
    /@media \(max-width:\s*800px\)[\s\S]*?\.showcase-shell\s*\{\s*display:\s*block;\s*margin-inline:\s*0;\s*\}[\s\S]*?\.rail-arrow\s*\{\s*display:\s*none;\s*\}/,
  );
  assert.match(
    css,
    /@media \(hover:\s*none\) and \(pointer:\s*coarse\)[\s\S]*?\.showcase-shell\s*\{\s*display:\s*block;\s*margin-inline:\s*0;\s*\}[\s\S]*?\.rail-arrow\s*\{\s*display:\s*none !important;\s*\}/,
  );
});
