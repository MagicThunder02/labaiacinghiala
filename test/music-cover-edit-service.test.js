'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_MUSIC_COVER_EDIT_BYTES,
  MusicCoverEditError,
  detectMusicCoverImage,
  normalizeMusicCoverChange,
  parseMusicCoverDataUrl,
} = require('../src/services/music-cover-edit-service');

function png(width = 1, height = 1) {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function jpeg(width = 1, height = 1) {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xd9,
  ]);
}

function dataUrl(mimeType, buffer) {
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

test('valida JPEG e PNG dai byte reali senza ridimensionarli', () => {
  assert.deepEqual(detectMusicCoverImage(png(1200, 1200)), {
    mimeType: 'image/png', width: 1200, height: 1200,
  });
  assert.deepEqual(detectMusicCoverImage(jpeg(640, 480)), {
    mimeType: 'image/jpeg', width: 640, height: 480,
  });
  const parsed = parseMusicCoverDataUrl(dataUrl('image/png', png(300, 500)));
  assert.equal(parsed.mimeType, 'image/png');
  assert.equal(parsed.width, 300);
  assert.equal(parsed.height, 500);
  assert.equal(parsed.buffer.length, 24);
});

test('normalizza le azioni keep, replace e remove', () => {
  assert.deepEqual(normalizeMusicCoverChange({}), { action: 'keep' });
  assert.deepEqual(normalizeMusicCoverChange({ coverAction: 'remove' }), { action: 'remove' });
  const replacement = normalizeMusicCoverChange({
    coverAction: 'replace',
    coverDataUrl: dataUrl('image/jpeg', jpeg(900, 900)),
  });
  assert.equal(replacement.action, 'replace');
  assert.equal(replacement.mimeType, 'image/jpeg');
  assert.equal(replacement.width, 900);
  assert.equal(replacement.height, 900);
  assert.ok(Buffer.isBuffer(replacement.data));
});

test('rifiuta formati, MIME, dimensioni e dimensione file non consentiti', () => {
  assert.throws(
    () => parseMusicCoverDataUrl('data:image/webp;base64,UklGRg=='),
    (error) => error instanceof MusicCoverEditError && error.code === 'MUSIC_COVER_DATA_INVALID',
  );
  assert.throws(
    () => parseMusicCoverDataUrl(dataUrl('image/jpeg', png(1, 1))),
    (error) => error instanceof MusicCoverEditError && error.code === 'MUSIC_COVER_MIME_MISMATCH',
  );
  assert.throws(
    () => parseMusicCoverDataUrl(dataUrl('image/png', png(8001, 1))),
    (error) => error instanceof MusicCoverEditError && error.code === 'MUSIC_COVER_DIMENSIONS_INVALID',
  );
  const huge = Buffer.alloc(MAX_MUSIC_COVER_EDIT_BYTES + 1);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(huge, 0);
  huge.write('IHDR', 12, 'ascii');
  huge.writeUInt32BE(1, 16);
  huge.writeUInt32BE(1, 20);
  assert.throws(
    () => parseMusicCoverDataUrl(dataUrl('image/png', huge)),
    (error) => error instanceof MusicCoverEditError && error.code === 'MUSIC_COVER_TOO_LARGE',
  );
});
