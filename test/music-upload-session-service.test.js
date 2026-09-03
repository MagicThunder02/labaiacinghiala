'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function createEnvironment(root) {
  const library = path.join(root, 'media');
  const uploads = path.join(library, '.uploads');
  fs.mkdirSync(uploads, { recursive: true });
  return {
    uploads,
    env: {
      ...process.env,
      DATABASE_PATH: path.join(root, 'media.sqlite'),
      DATABASE_BACKUPS_PATH: path.join(root, 'backups'),
      LIBRARY_PATH: library,
      METADATA_POSTER_CACHE_PATH: path.join(root, 'poster-cache'),
      METADATA_POSTERS_PATH: path.join(root, 'posters'),
      UPLOAD_TEMP_PATH: uploads,
    },
  };
}

function runScript(root, script) {
  const { env } = createEnvironment(root);
  return spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env,
  });
}

function lastJson(stdout) {
  return JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
}

function metadataSource({ complete = true } = {}) {
  return `async (filePath) => ({
    fileName: path.basename(filePath), extension: path.extname(filePath), format: path.extname(filePath).slice(1),
    sizeBytes: fs.statSync(filePath).size, modifiedAt: new Date().toISOString(), hasCoverArt: false, pictures: [],
    tags: {
      title: ${complete ? "'Iron Man'" : "''"}, artists: ['Black Sabbath'], artist: 'Black Sabbath',
      album: 'Paranoid', albumArtists: ['Black Sabbath'], albumArtist: 'Black Sabbath',
      genres: ['Heavy Metal'], composers: [], comment: '', date: '1970', year: 1970,
      trackNumber: ${complete ? '1' : 'null'}, trackTotal: 8, discNumber: 1, discTotal: 1, compilation: false,
    },
    properties: { durationSeconds: 355, durationMs: 355000, bitrateKbps: 320, sampleRateHz: 44100, channels: 2 },
  })`;
}

test('crea una sessione multi-brano opaca e segnala i tag incompleti senza esporre path server', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-music-session-create-'));
  const { uploads } = createEnvironment(root);
  const first = path.join(uploads, 'first.mp3');
  const second = path.join(uploads, 'second.flac');
  fs.writeFileSync(first, 'first');
  fs.writeFileSync(second, 'second');

  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const {
      createMusicUploadSession, getMusicUploadSession, SESSION_PREFIX,
    } = require('./src/services/music-upload-session-service');
    const complete = ${metadataSource({ complete: true })};
    const incomplete = ${metadataSource({ complete: false })};
    const metadataReader = (filePath) => path.extname(filePath) === '.flac' ? incomplete(filePath) : complete(filePath);
    (async () => {
      const session = await createMusicUploadSession([
        { path: ${JSON.stringify(first)}, originalname: '01 Iron Man.mp3' },
        { path: ${JSON.stringify(second)}, originalname: '02 Senza tag.flac' },
      ], 'device:test-owner', { metadataReader });
      let wrongOwner;
      try { await getMusicUploadSession(session.sessionId, 'device:other', { metadataReader }); }
      catch (error) { wrongOwner = { code: error.code, statusCode: error.statusCode }; }
      const serialized = JSON.stringify(session);
      const directories = fs.readdirSync(${JSON.stringify(uploads)}).filter((name) => name.startsWith(SESSION_PREFIX));
      console.log(JSON.stringify({ session, wrongOwner, serialized, directories }));
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `;

  const result = runScript(root, script);
  assert.equal(result.status, 0, result.stderr);
  const payload = lastJson(result.stdout);
  assert.equal(payload.session.tracks.length, 2);
  assert.equal(payload.session.tracks[0].readyToImport, true);
  assert.equal(payload.session.tracks[0].proposedRelativePath, 'Musica/Black Sabbath/Paranoid/01 Iron Man.mp3');
  assert.equal(payload.session.tracks[1].readyToImport, false);
  assert.equal(payload.session.tracks[1].validation.code, 'MUSIC_IMPORT_TAGS_INCOMPLETE');
  assert.deepEqual(payload.wrongOwner, { code: 'MUSIC_UPLOAD_SESSION_NOT_FOUND', statusCode: 404 });
  assert.equal(payload.serialized.includes(root), false);
  assert.equal(payload.serialized.includes('ownerKey'), false);
  assert.equal(payload.serialized.includes('storedName'), false);
  assert.equal(payload.directories.length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('modifica i tag effettivi del file temporaneo e ricalcola la destinazione proposta', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-music-session-tags-'));
  const { uploads } = createEnvironment(root);
  const source = path.join(uploads, 'incoming.wav');
  fs.writeFileSync(source, 'wav');

  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const { createMusicUploadSession, updateMusicUploadTrackTags } = require('./src/services/music-upload-session-service');
    let tags = {
      title: '', artists: ['Black Sabbath'], artist: 'Black Sabbath', album: 'Paranoid',
      albumArtists: ['Black Sabbath'], albumArtist: 'Black Sabbath', genres: [], composers: [],
      comment: '', date: '1970', year: 1970, trackNumber: null, trackTotal: 8,
      discNumber: 1, discTotal: 1, compilation: false,
    };
    const metadataReader = async (filePath) => ({
      fileName: path.basename(filePath), extension: '.wav', format: 'wav', sizeBytes: fs.statSync(filePath).size,
      modifiedAt: new Date().toISOString(), hasCoverArt: false, pictures: [], tags: { ...tags },
      properties: { durationSeconds: 10, durationMs: 10000, sampleRateHz: 44100, channels: 2 },
    });
    const tagWriter = async (_filePath, changes) => {
      tags = {
        ...tags,
        title: changes.title ?? tags.title,
        artists: changes.artists || (changes.artist ? [changes.artist] : tags.artists),
        artist: changes.artist || changes.artists?.[0] || tags.artist,
        album: changes.album ?? tags.album,
        albumArtists: changes.albumArtists || (changes.albumArtist ? [changes.albumArtist] : tags.albumArtists),
        albumArtist: changes.albumArtist || changes.albumArtists?.[0] || tags.albumArtist,
        trackNumber: changes.trackNumber ?? tags.trackNumber,
      };
      return metadataReader(_filePath);
    };
    (async () => {
      const session = await createMusicUploadSession([
        { path: ${JSON.stringify(source)}, originalname: 'grezzo.wav' },
      ], 'local-admin', { metadataReader });
      const before = session.tracks[0];
      const after = await updateMusicUploadTrackTags(session.sessionId, before.trackId, 'local-admin', {
        title: 'War Pigs', trackNumber: 1,
      }, { metadataReader, tagWriter });
      console.log(JSON.stringify({ before, after, sourceExists: fs.existsSync(${JSON.stringify(source)}) }));
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `;

  const result = runScript(root, script);
  assert.equal(result.status, 0, result.stderr);
  const payload = lastJson(result.stdout);
  assert.equal(payload.before.readyToImport, false);
  assert.equal(payload.after.readyToImport, true);
  assert.equal(payload.after.tags.title, 'War Pigs');
  assert.equal(payload.after.proposedRelativePath, 'Musica/Black Sabbath/Paranoid/01 War Pigs.wav');
  assert.equal(payload.sourceExists, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('finalizza i brani singolarmente e la cancellazione elimina soltanto i temporanei rimasti', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-music-session-commit-'));
  const { uploads } = createEnvironment(root);
  const first = path.join(uploads, 'first.mp3');
  const second = path.join(uploads, 'second.mp3');
  fs.writeFileSync(first, 'first');
  fs.writeFileSync(second, 'second');

  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const {
      createMusicUploadSession, commitMusicUploadTrack, cancelMusicUploadSession, SESSION_PREFIX,
    } = require('./src/services/music-upload-session-service');
    let counter = 0;
    const metadataReader = async (filePath) => {
      const index = path.basename(filePath).includes('unused') ? 2 : 1;
      return {
        fileName: path.basename(filePath), extension: '.mp3', format: 'mp3', sizeBytes: fs.statSync(filePath).size,
        modifiedAt: new Date().toISOString(), hasCoverArt: false, pictures: [],
        tags: { title: 'Brano ' + (++counter), artists: ['Artista'], artist: 'Artista', album: 'Album', albumArtists: ['Artista'], albumArtist: 'Artista', genres: [], composers: [], comment: '', date: '', year: null, trackNumber: counter, trackTotal: 2, discNumber: 1, discTotal: 1, compilation: false },
        properties: { durationSeconds: 10, durationMs: 10000 },
      };
    };
    const importer = async (filePath) => {
      await fs.promises.rm(filePath);
      return { id: 41, trackUuid: 'logical-track', relativePath: 'Musica/Artista/Album/01 Brano.mp3' };
    };
    (async () => {
      const session = await createMusicUploadSession([
        { path: ${JSON.stringify(first)}, originalname: 'first.mp3' },
        { path: ${JSON.stringify(second)}, originalname: 'second.mp3' },
      ], 'device:owner', { metadataReader });
      const committed = await commitMusicUploadTrack(session.sessionId, session.tracks[0].trackId, 'device:owner', { importer });
      const cancelled = await cancelMusicUploadSession(session.sessionId, 'device:owner');
      const directories = fs.readdirSync(${JSON.stringify(uploads)}).filter((name) => name.startsWith(SESSION_PREFIX));
      console.log(JSON.stringify({ committed, cancelled, directories }));
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `;

  const result = runScript(root, script);
  assert.equal(result.status, 0, result.stderr);
  const payload = lastJson(result.stdout);
  assert.equal(payload.committed.remainingTracks, 1);
  assert.equal(payload.committed.sessionComplete, false);
  assert.equal(payload.committed.imported.id, 41);
  assert.equal(payload.cancelled.cancelled, true);
  assert.deepEqual(payload.directories, []);
  fs.rmSync(root, { recursive: true, force: true });
});
