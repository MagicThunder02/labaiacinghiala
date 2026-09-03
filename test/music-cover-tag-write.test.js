'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { updateMusicFileCoverArt } = require('../src/services/music-tag-service');

function createAdapter(coverData) {
  return {
    async readTags() { return { title: 'Test', artist: ['Artist'], album: 'Album', track: 1 }; },
    async readProperties() { return { durationMs: 1000, duration: 1, sampleRate: 44100, channels: 2 }; },
    async readPictureMetadata(candidate) {
      return fs.readFileSync(candidate, 'utf8') === 'covered'
        ? [{ type: 'FrontCover', mimeType: 'image/png', description: '', size: coverData.length }]
        : [];
    },
    async readPictures(candidate) {
      return fs.readFileSync(candidate, 'utf8') === 'covered'
        ? [{ type: 'FrontCover', mimeType: 'image/png', description: '', data: coverData }]
        : [];
    },
    async applyCoverArt(_candidate, data, mimeType) {
      assert.equal(mimeType, 'image/png');
      assert.ok(Buffer.from(data).equals(coverData));
      return Buffer.from('covered');
    },
    async clearPictures() { return Buffer.from('cleared'); },
    async applyTagsToFile() {},
  };
}

test('sostituisce tutte le immagini con una sola FrontCover verificata', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-cover-write-'));
  const filePath = path.join(root, 'song.mp3');
  fs.writeFileSync(filePath, 'original');
  const coverData = Buffer.from('png-cover');
  const result = await updateMusicFileCoverArt(filePath, {
    action: 'replace', data: coverData, mimeType: 'image/png',
  }, { adapter: createAdapter(coverData) });
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'covered');
  assert.equal(result.hasCoverArt, true);
  assert.equal(result.pictures.length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('rimuove tutte le immagini incorporate e verifica il risultato', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-cover-remove-'));
  const filePath = path.join(root, 'song.flac');
  fs.writeFileSync(filePath, 'covered');
  const result = await updateMusicFileCoverArt(filePath, { action: 'remove' }, {
    adapter: createAdapter(Buffer.from('png-cover')),
  });
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'cleared');
  assert.equal(result.hasCoverArt, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('un errore nella scrittura lascia intatto il file originale', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-cover-rollback-'));
  const filePath = path.join(root, 'song.wav');
  fs.writeFileSync(filePath, 'original');
  const adapter = createAdapter(Buffer.from('png-cover'));
  adapter.applyCoverArt = async () => { throw new Error('unsupported-wave-picture'); };
  await assert.rejects(
    updateMusicFileCoverArt(filePath, {
      action: 'replace', data: Buffer.from('png-cover'), mimeType: 'image/png',
    }, { adapter }),
    (error) => error.code === 'MUSIC_COVER_WRITE_FAILED',
  );
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'original');
  fs.rmSync(root, { recursive: true, force: true });
});
