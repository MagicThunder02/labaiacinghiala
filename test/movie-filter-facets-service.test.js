'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMovieFilterFacets } = require('../src/services/movie-filter-facets-service');

const movies = [
  { genres: ['Animazione', 'Avventura'], director: 'Brad Bird', year: 2004 },
  { genres: ['Animazione', 'Commedia'], director: 'Brad Bird', year: 2007 },
  { genres: ['Azione', 'Fantascienza'], director: 'Brad Bird', year: 2015 },
  { genres: ['Animazione', 'Famiglia'], director: 'Pete Docter', year: 2009 },
  { genres: ['Drammatico'], director: 'Christopher Nolan', year: 2023 },
];

test('ogni facet applica gli altri filtri ma ignora il proprio', () => {
  const facets = buildMovieFilterFacets(movies, {
    director: 'Brad Bird',
  });

  assert.deepEqual(facets.genres, [
    'Animazione',
    'Avventura',
    'Azione',
    'Commedia',
    'Fantascienza',
  ]);
  assert.deepEqual(facets.years, [2015, 2007, 2004]);
  assert.deepEqual(facets.directors, [
    'Brad Bird',
    'Christopher Nolan',
    'Pete Docter',
  ]);
});

test('genere e anno restringono insieme i registi disponibili', () => {
  const facets = buildMovieFilterFacets(movies, {
    genre: 'Animazione',
    year: 2009,
  });

  assert.deepEqual(facets.directors, ['Pete Docter']);
  assert.deepEqual(facets.genres, ['Animazione', 'Famiglia']);
  assert.deepEqual(facets.years, [2009, 2007, 2004]);
});

test('il valore selezionato resta visibile anche se la combinazione non produce risultati', () => {
  const facets = buildMovieFilterFacets(movies, {
    genre: 'Drammatico',
    director: 'Brad Bird',
    year: 2004,
  });

  assert.ok(facets.genres.includes('Drammatico'));
  assert.ok(facets.directors.includes('Brad Bird'));
  assert.ok(facets.years.includes(2004));
});

test('confronti e deduplica sono case-insensitive e accent-insensitive', () => {
  const facets = buildMovieFilterFacets([
    { genres: ['Commedia'], director: 'Niccolò Ammaniti', year: 2020 },
    { genres: ['commedia'], director: 'NICCOLO AMMANITI', year: 2021 },
  ], {
    director: 'niccolo ammaniti',
  });

  assert.deepEqual(facets.genres, ['Commedia']);
  assert.deepEqual(facets.years, [2021, 2020]);
});
