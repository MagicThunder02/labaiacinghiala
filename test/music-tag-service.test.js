'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  getMusicFormat,
  isMusicExtensionAllowed,
  supportedMusicExtensions,
} = require('../src/music-formats');
const {
  MusicTagError,
  buildTagLibPatch,
  normalizeAudioProperties,
  normalizeMusicTags,
  readMusicFileMetadata,
  readMusicCoverArt,
  selectMusicCoverPicture,
  updateMusicFileTags,
} = require('../src/services/music-tag-service');

async function withTempDirectory(callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'baia-music-tags-'));
  try {
    return await callback(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function fakeAdapter({ failWrite = false } = {}) {
  async function readDocument(filePath) {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  }

  return {
    async readTags(filePath) {
      return (await readDocument(filePath)).tags || {};
    },
    async readProperties(filePath) {
      return (await readDocument(filePath)).properties || {};
    },
    async readPictureMetadata(filePath) {
      return (await readDocument(filePath)).pictures || [];
    },
    async applyTagsToFile(filePath, patch) {
      if (failWrite) throw new Error('write failed');
      const document = await readDocument(filePath);
      document.tags = { ...document.tags, ...patch };
      await fs.writeFile(filePath, `${JSON.stringify(document)}\n`);
    },
  };
}

test('la whitelist musicale ammette soltanto MP3, FLAC e WAV', () => {
  assert.deepEqual(supportedMusicExtensions(), ['.mp3', '.flac', '.wav']);
  assert.equal(isMusicExtensionAllowed('track.MP3'), true);
  assert.equal(isMusicExtensionAllowed('.flac'), true);
  assert.equal(isMusicExtensionAllowed('audio.wav'), true);
  assert.equal(isMusicExtensionAllowed('audio.m4a'), false);
  assert.equal(getMusicFormat('audio.FLAC').id, 'flac');
});

test('i tag e le proprietà vengono normalizzati in un contratto stabile per Baia', () => {
  assert.deepEqual(normalizeMusicTags({
    title: ['  Iron   Man  '],
    artist: ['Black Sabbath', ' black sabbath ', 'Guest'],
    album: ['Paranoid'],
    albumArtist: ['Black Sabbath'],
    genre: ['Heavy Metal', 'heavy metal', 'Rock'],
    composer: ['Tony Iommi'],
    track: 4,
    totalTracks: 8,
    discNumber: 1,
    totalDiscs: 1,
    year: 1970,
    date: ['1970-09-18'],
    compilation: false,
  }), {
    title: 'Iron Man',
    artists: ['Black Sabbath', 'Guest'],
    artist: 'Black Sabbath',
    album: 'Paranoid',
    albumArtists: ['Black Sabbath'],
    albumArtist: 'Black Sabbath',
    genres: ['Heavy Metal', 'Rock'],
    composers: ['Tony Iommi'],
    comment: '',
    date: '1970-09-18',
    year: 1970,
    trackNumber: 4,
    trackTotal: 8,
    discNumber: 1,
    discTotal: 1,
    compilation: false,
  });

  assert.deepEqual(normalizeAudioProperties({
    duration: 0,
    durationMs: 250,
    bitrate: 64,
    sampleRate: 44100,
    channels: 2,
    bitsPerSample: 16,
    codec: 'MP3',
    containerFormat: 'MP3',
    isLossless: false,
  }), {
    durationSeconds: 0.25,
    durationMs: 250,
    bitrateKbps: 64,
    sampleRateHz: 44100,
    channels: 2,
    bitsPerSample: 16,
    codec: 'MP3',
    containerFormat: 'MP3',
    isLossless: false,
    bitrateMode: null,
  });

  assert.deepEqual(normalizeAudioProperties({
    duration: 356.2,
    durationMs: 356200,
    bitrate: 921,
    sampleRate: 44100,
    channels: 2,
    bitsPerSample: 16,
    codec: 'FLAC',
    containerFormat: 'FLAC',
    isLossless: true,
  }), {
    durationSeconds: 356.2,
    durationMs: 356200,
    bitrateKbps: 921,
    sampleRateHz: 44100,
    channels: 2,
    bitsPerSample: 16,
    codec: 'FLAC',
    containerFormat: 'FLAC',
    isLossless: true,
    bitrateMode: null,
  });
});

test('la patch applicativa viene tradotta nei nomi effettivi di TagLib', () => {
  assert.deepEqual(buildTagLibPatch({
    title: 'Iron Man',
    artists: ['Black Sabbath'],
    album: 'Paranoid',
    albumArtist: 'Black Sabbath',
    genres: ['Heavy Metal'],
    trackNumber: 4,
    trackTotal: 8,
    discNumber: 1,
    discTotal: 1,
    year: 1970,
  }), {
    title: 'Iron Man',
    artist: ['Black Sabbath'],
    album: 'Paranoid',
    albumArtist: ['Black Sabbath'],
    genre: ['Heavy Metal'],
    year: 1970,
    track: 4,
    totalTracks: 8,
    discNumber: 1,
    totalDiscs: 1,
  });

  assert.throws(() => buildTagLibPatch({}), (error) => (
    error instanceof MusicTagError && error.code === 'EMPTY_MUSIC_TAG_PATCH'
  ));
});

test('la lettura non espone dati binari delle copertine e restituisce solo metadati utili', async () => {
  await withTempDirectory(async (directory) => {
    const filePath = path.join(directory, 'track.mp3');
    await fs.writeFile(filePath, JSON.stringify({
      tags: {
        title: ['Iron Man'],
        artist: ['Black Sabbath'],
        album: ['Paranoid'],
        track: 4,
      },
      properties: {
        duration: 356,
        bitrate: 320,
        sampleRate: 44100,
        channels: 2,
        codec: 'MP3',
        containerFormat: 'MP3',
      },
      pictures: [{
        type: 'FrontCover',
        mimeType: 'image/jpeg',
        description: 'Cover',
        size: 12345,
        data: 'non deve uscire',
      }],
    }));

    const metadata = await readMusicFileMetadata(filePath, { adapter: fakeAdapter() });
    assert.equal(metadata.tags.title, 'Iron Man');
    assert.equal(metadata.tags.trackNumber, 4);
    assert.equal(metadata.properties.durationSeconds, 356);
    assert.equal(metadata.hasCoverArt, true);
    assert.deepEqual(metadata.pictures, [{
      type: 'FrontCover',
      mimeType: 'image/jpeg',
      description: 'Cover',
      size: 12345,
    }]);
  });
});

test('la scrittura modifica una copia verificata e sostituisce il file soltanto alla fine', async () => {
  await withTempDirectory(async (directory) => {
    const filePath = path.join(directory, 'track.flac');
    await fs.writeFile(filePath, JSON.stringify({
      tags: { title: ['Vecchio titolo'], artist: ['Artista'] },
      properties: { duration: 10, codec: 'FLAC', containerFormat: 'FLAC', isLossless: true },
      pictures: [],
    }));

    const result = await updateMusicFileTags(filePath, {
      title: 'Nuovo titolo',
      album: 'Nuovo album',
      trackNumber: 2,
    }, { adapter: fakeAdapter() });

    const stored = JSON.parse(await fs.readFile(filePath, 'utf8'));
    assert.equal(stored.tags.title, 'Nuovo titolo');
    assert.equal(stored.tags.album, 'Nuovo album');
    assert.equal(stored.tags.track, 2);
    assert.equal(result.tags.title, 'Nuovo titolo');
    assert.equal(result.tags.album, 'Nuovo album');

    const siblings = await fs.readdir(directory);
    assert.deepEqual(siblings, ['track.flac']);
  });
});

test('un errore di TagLib lascia intatto il file originale e pulisce la copia temporanea', async () => {
  await withTempDirectory(async (directory) => {
    const filePath = path.join(directory, 'track.wav');
    const original = `${JSON.stringify({
      tags: { title: ['Originale'] },
      properties: { duration: 1, codec: 'PCM', containerFormat: 'WAV', isLossless: true },
      pictures: [],
    })}\n`;
    await fs.writeFile(filePath, original);

    await assert.rejects(
      updateMusicFileTags(filePath, { title: 'Non salvare' }, { adapter: fakeAdapter({ failWrite: true }) }),
      (error) => error instanceof MusicTagError && error.code === 'MUSIC_TAG_WRITE_FAILED',
    );

    assert.equal(await fs.readFile(filePath, 'utf8'), original);
    assert.deepEqual(await fs.readdir(directory), ['track.wav']);
  });
});



test('la copertina frontale incorporata viene preferita e restituita come buffer solo al backend', async () => {
  await withTempDirectory(async (directory) => {
    const filePath = path.join(directory, 'track.mp3');
    await fs.writeFile(filePath, 'fixture');
    const back = { type: 'BackCover', mimeType: 'image/png', data: new Uint8Array([1, 2]) };
    const front = { type: 'FrontCover', mimeType: 'image/jpeg', description: 'Front', data: new Uint8Array([3, 4, 5]) };
    assert.equal(selectMusicCoverPicture([back, front]), front);

    const artwork = await readMusicCoverArt(filePath, {
      adapter: {
        async readPictures() { return [back, front]; },
      },
    });
    assert.equal(Buffer.isBuffer(artwork.data), true);
    assert.deepEqual([...artwork.data], [3, 4, 5]);
    assert.equal(artwork.mimeType, 'image/jpeg');
    assert.equal(artwork.description, 'Front');
  });
});

test('un formato fuori whitelist viene rifiutato prima di invocare TagLib', async () => {
  await withTempDirectory(async (directory) => {
    const filePath = path.join(directory, 'track.m4a');
    await fs.writeFile(filePath, 'fake');
    await assert.rejects(
      readMusicFileMetadata(filePath, { adapter: fakeAdapter() }),
      (error) => error instanceof MusicTagError && error.code === 'UNSUPPORTED_MUSIC_FORMAT',
    );
  });
});
