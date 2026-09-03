'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEFAULT_PALETTE,
  analyzePixels,
  applyCssVariables,
  oklabDistance,
} = require('../public/js/media-palette');

function pixelsFromGroups(groups) {
  const pixels = [];
  for (const { rgb, count } of groups) {
    for (let index = 0; index < count; index += 1) pixels.push(...rgb, 255);
  }
  return Uint8ClampedArray.from(pixels);
}

test('la palette conserva accenti vivaci anche quando occupano meno pixel', () => {
  const palette = analyzePixels(pixelsFromGroups([
    { rgb: [78, 75, 70], count: 900 },
    { rgb: [224, 52, 42], count: 95 },
    { rgb: [26, 118, 225], count: 85 },
    { rgb: [222, 166, 34], count: 70 },
    { rgb: [75, 176, 92], count: 60 },
  ]));

  const colors = [palette.primary, palette.secondary, palette.accentA, palette.accentB];
  assert.equal(colors.length, 4);
  assert.ok(colors.some((color) => color[0] > 170 && color[1] < 110));
  assert.ok(colors.some((color) => color[2] > 150 || color[1] > 145));
});

test('i quattro colori visivi restano percettivamente distinti', () => {
  const palette = analyzePixels(pixelsFromGroups([
    { rgb: [206, 56, 48], count: 150 },
    { rgb: [34, 112, 214], count: 140 },
    { rgb: [224, 164, 36], count: 130 },
    { rgb: [80, 178, 92], count: 120 },
    { rgb: [132, 70, 190], count: 110 },
  ]));
  const colors = [palette.primary, palette.secondary, palette.accentA, palette.accentB];
  const distances = [];
  for (let first = 0; first < colors.length; first += 1) {
    for (let second = first + 1; second < colors.length; second += 1) {
      distances.push(oklabDistance(colors[first], colors[second]));
    }
  }
  assert.ok(Math.max(...distances) > 0.2);
  assert.ok(distances.filter((distance) => distance > 0.08).length >= 4);
});

test('la palette di fallback è completa e il colore base resta scuro', () => {
  const palette = analyzePixels(new Uint8ClampedArray());
  assert.deepEqual(palette, DEFAULT_PALETTE);
  const generated = analyzePixels(pixelsFromGroups([{ rgb: [180, 80, 45], count: 50 }]));
  assert.ok(Math.max(...generated.base) < 90);
});

test('le cinque variabili CSS vengono applicate con un prefisso condiviso', () => {
  const values = new Map();
  const target = { style: { setProperty: (name, value) => values.set(name, value) } };
  applyCssVariables(target, DEFAULT_PALETTE, 'detail-color');
  assert.deepEqual([...values.keys()], [
    '--detail-color-base',
    '--detail-color-a',
    '--detail-color-b',
    '--detail-color-c',
    '--detail-color-d',
  ]);
});
