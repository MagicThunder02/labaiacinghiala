'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function createEnvironment(root) {
  const library = path.join(root, 'media');
  fs.mkdirSync(library, { recursive: true });
  return {
    ...process.env,
    DATABASE_PATH: path.join(root, 'media.sqlite'),
    DATABASE_BACKUPS_PATH: path.join(root, 'backups'),
    LIBRARY_PATH: library,
    METADATA_POSTER_CACHE_PATH: path.join(root, 'poster-cache'),
    METADATA_POSTERS_PATH: path.join(root, 'posters'),
    UPLOAD_TEMP_PATH: path.join(library, '.uploads'),
  };
}

test('cronologia musicale conta una sola volta per sessione e usa soglie diverse per brani lunghi e corti', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-music-listening-'));
  const script = String.raw`
    const path = require('node:path');
    const fs = require('node:fs');
    const db = require('./src/database');

    const albumDir = path.join(process.env.LIBRARY_PATH, 'Musica', 'Artista', 'Album');
    fs.mkdirSync(albumDir, { recursive: true });
    const albumId = Number(db.prepare(
      'INSERT INTO music_albums (album_uuid, title, directory_path, relative_path, album_artists_json, genres_json) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('album-1', 'Album', albumDir, path.relative(process.env.LIBRARY_PATH, albumDir), '["Artista"]', '["Rock"]').lastInsertRowid);

    function insertTrack(uuid, number, duration) {
      const fileName = String(number).padStart(2, '0') + ' Brano.mp3';
      const filePath = path.join(albumDir, fileName);
      fs.writeFileSync(filePath, 'fixture-' + uuid);
      const stats = fs.statSync(filePath);
      db.prepare(
        'INSERT INTO music_tracks (track_uuid, album_id, file_path, relative_path, file_name, title, artists_json, genres_json, composers_json, track_number, extension, mime_type, duration_seconds, duration_ms, size_bytes, modified_at, available) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)'
      ).run(uuid, albumId, filePath, path.relative(process.env.LIBRARY_PATH, filePath), fileName, uuid, '["Artista"]', '["Rock"]', '[]', number, '.mp3', 'audio/mpeg', duration, duration * 1000, stats.size, Math.trunc(stats.mtimeMs));
    }

    insertTrack('track-long', 1, 180);
    insertTrack('track-short', 2, 40);
    const service = require('./src/services/music-listening-service');

    const longSession = '11111111-1111-4111-8111-111111111111';
    const first = service.recordMusicListening('pietro', 'track-long', {
      sessionId: longSession, event: 'checkpoint', positionSeconds: 29, durationSeconds: 180, listenedSeconds: 29,
    });
    const qualified = service.recordMusicListening('pietro', 'track-long', {
      sessionId: longSession, event: 'checkpoint', positionSeconds: 30, durationSeconds: 180, listenedSeconds: 30,
    });
    const retry = service.recordMusicListening('pietro', 'track-long', {
      sessionId: longSession, event: 'checkpoint', positionSeconds: 31, durationSeconds: 180, listenedSeconds: 31,
    });
    const ended = service.recordMusicListening('pietro', 'track-long', {
      sessionId: longSession, event: 'ended', positionSeconds: 180, durationSeconds: 180, listenedSeconds: 175,
    });
    const endedRetry = service.recordMusicListening('pietro', 'track-long', {
      sessionId: longSession, event: 'ended', positionSeconds: 180, durationSeconds: 180, listenedSeconds: 175,
    });

    const shortSession = '22222222-2222-4222-8222-222222222222';
    const shortBefore = service.recordMusicListening('pietro', 'track-short', {
      sessionId: shortSession, event: 'checkpoint', positionSeconds: 19, durationSeconds: 40, listenedSeconds: 19,
    });
    const shortQualified = service.recordMusicListening('pietro', 'track-short', {
      sessionId: shortSession, event: 'pause', positionSeconds: 20, durationSeconds: 40, listenedSeconds: 20,
    });
    const skippedToEnd = service.recordMusicListening('pietro', 'track-short', {
      sessionId: '66666666-6666-4666-8666-666666666666', event: 'ended', positionSeconds: 40, durationSeconds: 40, listenedSeconds: 1,
    });

    const secondLong = service.recordMusicListening('pietro', 'track-long', {
      sessionId: '33333333-3333-4333-8333-333333333333', event: 'pause', positionSeconds: 35, durationSeconds: 180, listenedSeconds: 35,
    });
    const otherProfile = service.recordMusicListening('other', 'track-long', {
      sessionId: '44444444-4444-4444-8444-444444444444', event: 'ended', positionSeconds: 180, durationSeconds: 180, listenedSeconds: 180,
    });

    const histories = db.prepare(
      'SELECT t.track_uuid AS trackId, h.profile_key AS profileKey, h.play_count AS playCount, h.completed_count AS completedCount, h.last_played_at AS lastPlayedAt FROM music_listening_history h JOIN music_tracks t ON t.id = h.track_id ORDER BY h.profile_key, t.track_uuid'
    ).all();
    const sessions = Number(db.prepare('SELECT COUNT(*) AS count FROM music_playback_sessions').get().count);

    let conflict = null;
    try {
      service.recordMusicListening('pietro', 'track-short', {
        sessionId: longSession, event: 'pause', positionSeconds: 10, durationSeconds: 40, listenedSeconds: 10,
      });
    } catch (error) {
      conflict = { code: error.code, statusCode: error.statusCode };
    }

    console.log(JSON.stringify({
      first, qualified, retry, ended, endedRetry,
      shortBefore, shortQualified, skippedToEnd, secondLong, otherProfile,
      histories, sessions, conflict,
      missing: service.recordMusicListening('pietro', 'missing', {
        sessionId: '55555555-5555-4555-8555-555555555555', event: 'pause', positionSeconds: 1, durationSeconds: 10, listenedSeconds: 1,
      }),
    }));
    db.close();
  `;

  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: createEnvironment(root),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(payload.first.qualified, false);
  assert.equal(payload.first.countedPlay, false);
  assert.equal(payload.qualified.qualified, true);
  assert.equal(payload.qualified.countedPlay, true);
  assert.equal(payload.retry.countedPlay, false);
  assert.equal(payload.ended.countedCompletion, true);
  assert.equal(payload.endedRetry.countedCompletion, false);
  assert.equal(payload.shortBefore.qualified, false);
  assert.equal(payload.shortQualified.thresholdSeconds, 20);
  assert.equal(payload.shortQualified.countedPlay, true);
  assert.equal(payload.skippedToEnd.qualified, false);
  assert.equal(payload.skippedToEnd.countedCompletion, false);
  assert.equal(payload.secondLong.playCount, 2);
  assert.equal(payload.otherProfile.playCount, 1);
  assert.equal(payload.sessions, 5);
  assert.deepEqual(payload.conflict, {
    code: 'MUSIC_LISTENING_SESSION_CONFLICT',
    statusCode: 409,
  });
  assert.equal(payload.missing, null);

  const pietroLong = payload.histories.find((row) => row.profileKey === 'pietro' && row.trackId === 'track-long');
  const pietroShort = payload.histories.find((row) => row.profileKey === 'pietro' && row.trackId === 'track-short');
  const otherLong = payload.histories.find((row) => row.profileKey === 'other' && row.trackId === 'track-long');
  assert.deepEqual(
    { playCount: pietroLong.playCount, completedCount: pietroLong.completedCount },
    { playCount: 2, completedCount: 1 },
  );
  assert.deepEqual(
    { playCount: pietroShort.playCount, completedCount: pietroShort.completedCount },
    { playCount: 1, completedCount: 0 },
  );
  assert.deepEqual(
    { playCount: otherLong.playCount, completedCount: otherLong.completedCount },
    { playCount: 1, completedCount: 1 },
  );
  assert.ok(pietroLong.lastPlayedAt);
  assert.ok(pietroShort.lastPlayedAt);

  fs.rmSync(root, { recursive: true, force: true });
});

test('payload di ascolto rifiuta sessioni, eventi e secondi non validi', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-music-listening-invalid-'));
  const script = String.raw`
    const service = require('./src/services/music-listening-service');
    const results = [];
    for (const payload of [
      { sessionId: 'no', event: 'pause', positionSeconds: 0, durationSeconds: 10, listenedSeconds: 0 },
      { sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', event: 'hack', positionSeconds: 0, durationSeconds: 10, listenedSeconds: 0 },
      { sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', event: 'pause', positionSeconds: -1, durationSeconds: 10, listenedSeconds: 0 },
    ]) {
      try {
        service.normalizePayload(payload, 10);
        results.push(null);
      } catch (error) {
        results.push(error.code);
      }
    }
    console.log(JSON.stringify(results));
    require('./src/database').close();
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: createEnvironment(root),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)), [
    'MUSIC_LISTENING_INVALID_SESSION',
    'MUSIC_LISTENING_INVALID_EVENT',
    'MUSIC_LISTENING_INVALID_SECONDS',
  ]);
  fs.rmSync(root, { recursive: true, force: true });
});
