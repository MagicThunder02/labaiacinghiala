'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  readMusicFileMetadata,
  readMusicCoverArt,
  updateMusicFileTags,
} = require('../src/services/music-tag-service');

const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
const fixturesDirectory = path.join(__dirname, 'fixtures', 'music');

for (const extension of ['mp3', 'flac', 'wav']) {
  test(`taglib-wasm legge e riscrive realmente i tag ${extension.toUpperCase()}`, {
    skip: nodeMajor < 24 ? 'taglib-wasm 1.6.1 richiede Node 24 o successivo.' : false,
  }, async (t) => {
    try {
      await import('taglib-wasm/simple');
    } catch (error) {
      t.skip(`taglib-wasm non installato: ${error.message}`);
      return;
    }

    const directory = await fs.mkdtemp(path.join(os.tmpdir(), `baia-${extension}-integration-`));
    try {
      const source = path.join(fixturesDirectory, `fixture.${extension}`);
      const workingCopy = path.join(directory, `track.${extension}`);
      await fs.copyFile(source, workingCopy);

      const before = await readMusicFileMetadata(workingCopy);
      assert.equal(before.format, extension);
      assert.ok(before.properties.durationMs > 0);
      assert.ok(before.properties.durationSeconds > 0);

      const uniqueTitle = `Baia ${extension.toUpperCase()} ${Date.now()}`;
      const after = await updateMusicFileTags(workingCopy, {
        title: uniqueTitle,
        artist: 'Baia Integration Artist',
        album: 'Baia Integration Album',
        genre: ['Test'],
        trackNumber: 2,
        year: 2026,
      });

      assert.equal(after.tags.title, uniqueTitle);
      assert.equal(after.tags.artist, 'Baia Integration Artist');
      assert.equal(after.tags.album, 'Baia Integration Album');
      assert.equal(after.tags.trackNumber, 2);
      assert.equal(after.tags.year, 2026);

      const reread = await readMusicFileMetadata(workingCopy);
      assert.equal(reread.tags.title, uniqueTitle);
      assert.equal(reread.tags.artist, 'Baia Integration Artist');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
}

test('taglib-wasm legge realmente una copertina incorporata MP3', {
  skip: nodeMajor < 24 ? 'taglib-wasm 1.6.1 richiede Node 24 o successivo.' : false,
}, async (t) => {
  let taglib;
  try {
    taglib = await import('taglib-wasm/simple');
  } catch (error) {
    t.skip(`taglib-wasm non installato: ${error.message}`);
    return;
  }

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'baia-cover-integration-'));
  try {
    const source = path.join(fixturesDirectory, 'fixture.mp3');
    const workingCopy = path.join(directory, 'track.mp3');
    const audioData = new Uint8Array(await fs.readFile(source));
    const coverData = new Uint8Array(Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=',
      'base64',
    ));
    const modified = await taglib.applyCoverArt(audioData, coverData, 'image/png');
    await fs.writeFile(workingCopy, modified);

    const artwork = await readMusicCoverArt(workingCopy);
    assert.ok(artwork);
    assert.equal(artwork.mimeType, 'image/png');
    assert.deepEqual([...artwork.data], [...coverData]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

