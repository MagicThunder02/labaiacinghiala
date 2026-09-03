'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  readMusicCoverArt,
  readMusicFileMetadata,
  updateMusicFileCoverArt,
} = require('../src/services/music-tag-service');

const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
const cover = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=',
  'base64',
);

for (const extension of ['mp3', 'flac']) {
  test(`TagLib sostituisce e rimuove realmente la copertina ${extension.toUpperCase()}`, {
    skip: nodeMajor < 24 ? 'taglib-wasm 1.6.1 richiede Node 24 o successivo.' : false,
  }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `baia-cover-real-${extension}-`));
    const filePath = path.join(root, `fixture.${extension}`);
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'music', `fixture.${extension}`), filePath);

    const replaced = await updateMusicFileCoverArt(filePath, {
      action: 'replace', data: cover, mimeType: 'image/png',
    });
    assert.equal(replaced.hasCoverArt, true);
    assert.equal(replaced.pictures.length, 1);
    const reread = await readMusicCoverArt(filePath);
    assert.ok(reread?.data.equals(cover));

    const removed = await updateMusicFileCoverArt(filePath, { action: 'remove' });
    assert.equal(removed.hasCoverArt, false);
    assert.equal(await readMusicCoverArt(filePath), null);
    fs.rmSync(root, { recursive: true, force: true });
  });
}

test('WAV salva la copertina quando supportato e preserva il file quando TagLib la rifiuta', {
  skip: nodeMajor < 24 ? 'taglib-wasm 1.6.1 richiede Node 24 o successivo.' : false,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-cover-real-wav-'));
  const filePath = path.join(root, 'fixture.wav');
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'music', 'fixture.wav'), filePath);
  const before = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  try {
    const replaced = await updateMusicFileCoverArt(filePath, {
      action: 'replace', data: cover, mimeType: 'image/png',
    });
    assert.equal(replaced.hasCoverArt, true);
    const reread = await readMusicCoverArt(filePath);
    assert.ok(reread?.data.equals(cover));
    const removed = await updateMusicFileCoverArt(filePath, { action: 'remove' });
    assert.equal(removed.hasCoverArt, false);
  } catch (error) {
    assert.ok(['MUSIC_COVER_WRITE_FAILED', 'MUSIC_COVER_REPLACE_VERIFY_FAILED'].includes(error.code));
    const after = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    assert.equal(after, before);
    const metadata = await readMusicFileMetadata(filePath);
    assert.ok(metadata);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
