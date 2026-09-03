const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const filmsCss = fs.readFileSync(path.join(root, 'public/css/films.css'), 'utf8');
const seriesCss = fs.readFileSync(path.join(root, 'public/css/series.css'), 'utf8');

const wideFilmStart = filmsCss.lastIndexOf('/* Desktop ampio:');
const veryWideFilmStart = filmsCss.lastIndexOf('/* Desktop molto ampio:');
const wideFilmCss = filmsCss.slice(wideFilmStart, veryWideFilmStart);
const veryWideFilmCss = filmsCss.slice(veryWideFilmStart);

const wideSeriesStart = seriesCss.lastIndexOf('/* Desktop ampio:');
const veryWideSeriesStart = seriesCss.lastIndexOf('/* Desktop molto ampio:');
const wideSeriesCss = seriesCss.slice(wideSeriesStart, veryWideSeriesStart);
const veryWideSeriesCss = seriesCss.slice(veryWideSeriesStart);

test('Film cresce in modo controllato sui desktop ampi senza usare tutta la viewport', () => {
  assert.match(wideFilmCss, /@media \(min-width: 1600px\) and \(min-height: 850px\)/);
  assert.match(wideFilmCss, /--detail-five-card-width:\s*min\(100%, 1220px\)/);
  assert.match(wideFilmCss, /\.detail-content\s*\{[\s\S]*width:\s*min\(2280px, calc\(100% - clamp\(88px, 6vw, 168px\)\)\)/);
  assert.match(wideFilmCss, /grid-template-columns:\s*minmax\(460px, 600px\) minmax\(0, 1fr\)/);
  assert.match(wideFilmCss, /--detail-frame-min-height:\s*clamp\(740px, 72vh, 900px\)/);
});



test('Film centra verticalmente il telaio sui desktop ampi senza perdere lo scroll sicuro', () => {
  assert.match(wideFilmCss, /\.films-page:not\(\.series-page\) \.film-detail-view\s*\{[\s\S]*display:\s*flex[\s\S]*flex-direction:\s*column[\s\S]*padding-block:\s*clamp\(72px, 6vh, 110px\)[\s\S]*box-sizing:\s*border-box/);
  assert.match(wideFilmCss, /\.detail-content\s*\{[\s\S]*margin:\s*auto[\s\S]*padding-bottom:\s*0/);
  assert.match(veryWideFilmCss, /\.detail-content\s*\{[\s\S]*margin:\s*auto[\s\S]*padding-bottom:\s*0/);
  assert.doesNotMatch(wideFilmCss, /margin-top:\s*clamp\(88px, 8vh, 122px\)/);
  assert.doesNotMatch(veryWideFilmCss, /margin-top:\s*clamp\(86px, 6\.5vh, 128px\)/);
});

test('Film conserva l’allineamento inferiore tra poster principale e cover simili sui desktop ampi', () => {
  assert.match(wideFilmCss, /\.detail-content\s*\{[\s\S]*height:\s*auto[\s\S]*min-height:\s*var\(--detail-frame-min-height\)[\s\S]*align-items:\s*stretch/);
  assert.match(wideFilmCss, /\.detail-poster-shell\s*\{[\s\S]*width:\s*auto[\s\S]*height:\s*100%[\s\S]*min-height:\s*var\(--detail-frame-min-height\)[\s\S]*align-self:\s*stretch/);
  assert.match(wideFilmCss, /\.detail-side\s*\{[\s\S]*height:\s*auto[\s\S]*min-height:\s*var\(--detail-frame-min-height\)[\s\S]*align-self:\s*stretch/);
  assert.match(veryWideFilmCss, /--detail-frame-min-height:\s*clamp\(860px, 66vh, 1120px\)/);
  assert.match(veryWideFilmCss, /grid-template-columns:\s*minmax\(570px, 760px\) minmax\(0, 1fr\)/);
});

test('Film aumenta anche spaziature azioni e rail invece di allargare solo il contenitore', () => {
  assert.match(wideFilmCss, /\.detail-side\s*\{[\s\S]*gap:\s*clamp\(24px, 2\.6vh, 40px\)/);
  assert.match(wideFilmCss, /\.detail-action\s*\{[\s\S]*min-height:\s*74px[\s\S]*font-size:\s*21px/);
  assert.match(wideFilmCss, /\.detail-similar-rail\s*\{[\s\S]*grid-auto-columns:\s*calc\(20% - 18px\)[\s\S]*gap:\s*22px/);
});

test('la seconda fascia limita la crescita su 2K 4K e ultrawide alti', () => {
  assert.match(veryWideFilmCss, /@media \(min-width: 2400px\) and \(min-height: 1000px\)/);
  assert.match(veryWideFilmCss, /--detail-five-card-width:\s*min\(100%, 1480px\)/);
  assert.match(veryWideFilmCss, /width:\s*min\(2860px, calc\(100% - clamp\(140px, 7vw, 240px\)\)\)/);
  assert.match(veryWideFilmCss, /\.detail-action\s*\{[\s\S]*min-height:\s*82px/);
});

test('Serie centra verticalmente il telaio principale e mantiene Serie simili sotto il primo viewport', () => {
  assert.match(wideSeriesCss, /\.series-page \.film-detail-view\s*\{[\s\S]*--series-detail-page-padding:\s*clamp\(72px, 6vh, 110px\)[\s\S]*display:\s*grid[\s\S]*grid-template-rows:[\s\S]*calc\(100dvh - var\(--series-detail-page-padding\) - var\(--series-detail-page-padding\)\)[\s\S]*row-gap:\s*var\(--series-detail-page-padding\)[\s\S]*padding-block:\s*var\(--series-detail-page-padding\)[\s\S]*box-sizing:\s*border-box/);
  assert.match(wideSeriesCss, /\.series-detail-content\s*\{[\s\S]*grid-row:\s*1[\s\S]*align-self:\s*safe center[\s\S]*margin:\s*0 auto/);
  assert.match(wideSeriesCss, /\.series-similar-section\s*\{[\s\S]*grid-row:\s*2[\s\S]*margin-top:\s*0[\s\S]*margin-bottom:\s*0/);
  assert.match(veryWideSeriesCss, /\.series-page \.film-detail-view\s*\{[\s\S]*--series-detail-page-padding:\s*clamp\(86px, 6\.5vh, 128px\)/);
});


test('Serie non lascia fuoriuscire il poster sopra il margine della prima viewport', () => {
  assert.match(wideSeriesCss, /\.series-detail-content\s*\{[\s\S]*align-self:\s*safe center/);
  assert.doesNotMatch(wideSeriesCss, /\.series-detail-content\s*\{[\s\S]*align-self:\s*center\s*;/);
  assert.match(wideSeriesCss, /padding-block:\s*var\(--series-detail-page-padding\)/);
});

test('Serie usa lo stesso telaio ampio ma mantiene episodi compatti e rail esterna ampia', () => {
  assert.match(wideSeriesCss, /@media \(min-width: 1600px\) and \(min-height: 850px\)/);
  assert.match(wideSeriesCss, /\.episode-row\s*\{[\s\S]*min-height:\s*58px[\s\S]*padding:\s*9px 16px/);
  assert.match(wideSeriesCss, /\.series-similar-section\s*\{[\s\S]*width:\s*min\(2280px, calc\(100% - clamp\(88px, 6vw, 168px\)\)\)/);
  assert.match(wideSeriesCss, /\.series-similar-rail\s*\{[\s\S]*grid-auto-columns:\s*clamp\(190px, 11\.5vw, 260px\)[\s\S]*gap:\s*24px/);
  assert.match(veryWideSeriesCss, /\.episode-row\s*\{[\s\S]*min-height:\s*64px[\s\S]*padding:\s*10px 18px/);
  assert.match(veryWideSeriesCss, /\.series-similar-section\s*\{[\s\S]*width:\s*min\(2860px, calc\(100% - clamp\(140px, 7vw, 240px\)\)\)/);
});



test('l’elenco episodi non stira poche righe per riempire la colonna', () => {
  assert.match(seriesCss, /\.episode-list\s*\{[^}]*grid-auto-rows:\s*max-content[^}]*align-content:\s*start/);
  assert.match(seriesCss, /\.episode-row\s*\{[^}]*min-height:\s*52px[^}]*padding:\s*8px 14px/);
});

test('Serie usa una cover deterministica indipendente dalle dimensioni intrinseche del file', () => {
  assert.match(seriesCss, /\.series-page \.series-detail-content \.detail-poster-shell\s*\{[\s\S]*width:\s*clamp\(470px, min\(25vw, 66vh\), 560px\)[\s\S]*height:\s*auto[\s\S]*min-height:\s*0[\s\S]*aspect-ratio:\s*2 \/ 3[\s\S]*align-self:\s*start/);
  assert.match(seriesCss, /@media \(min-width: 2400px\) and \(min-height: 1000px\)[\s\S]*\.series-page \.series-detail-content \.detail-poster-shell\s*\{[\s\S]*width:\s*clamp\(600px, min\(22vw, 66vh\), 740px\)[\s\S]*height:\s*auto[\s\S]*min-height:\s*0/);
});

test('le modalità ampie richiedono anche altezza sufficiente e non sostituiscono la modalità desktop bassa', () => {
  assert.match(filmsCss, /@media \(min-width: 761px\) and \(max-height: 780px\)/);
  assert.doesNotMatch(wideFilmCss, /max-height:/);
  assert.doesNotMatch(veryWideFilmCss, /max-height:/);
});
