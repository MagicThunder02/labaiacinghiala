'use strict';

const db = require('../database');

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENTS = new Set(['checkpoint', 'pause', 'change', 'ended']);
const MAX_SECONDS = 7 * 24 * 60 * 60;

class MusicListeningError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'MusicListeningError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const findTrack = db.prepare(`
  SELECT id, track_uuid AS trackId, duration_seconds AS indexedDurationSeconds
  FROM music_tracks
  WHERE track_uuid = ? AND available = 1
`);

const findSession = db.prepare(`
  SELECT session_id AS sessionId, track_id AS trackInternalId, profile_key AS profileKey,
         qualified, completed, listened_seconds AS listenedSeconds
  FROM music_playback_sessions
  WHERE session_id = ?
`);

const insertSession = db.prepare(`
  INSERT INTO music_playback_sessions (
    session_id, track_id, profile_key, qualified, completed, listened_seconds,
    started_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateSession = db.prepare(`
  UPDATE music_playback_sessions
  SET qualified = ?, completed = ?, listened_seconds = ?, updated_at = ?
  WHERE session_id = ?
`);

const getHistory = db.prepare(`
  SELECT play_count AS playCount, completed_count AS completedCount,
         last_position_seconds AS lastPositionSeconds,
         last_duration_seconds AS lastDurationSeconds,
         last_played_at AS lastPlayedAt
  FROM music_listening_history
  WHERE track_id = ? AND profile_key = ?
`);

const insertHistory = db.prepare(`
  INSERT INTO music_listening_history (
    track_id, profile_key, play_count, completed_count,
    last_position_seconds, last_duration_seconds, last_played_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateHistory = db.prepare(`
  UPDATE music_listening_history
  SET play_count = ?, completed_count = ?,
      last_position_seconds = ?, last_duration_seconds = ?,
      last_played_at = ?, updated_at = ?
  WHERE track_id = ? AND profile_key = ?
`);

const cleanupOldSessions = db.prepare(`
  DELETE FROM music_playback_sessions
  WHERE julianday(updated_at) < julianday('now', '-45 days')
`);

function normalizeProfileKey(value) {
  return String(value || 'default').trim() || 'default';
}

function finiteSeconds(value, fieldName) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > MAX_SECONDS) {
    throw new MusicListeningError(
      'MUSIC_LISTENING_INVALID_SECONDS',
      `${fieldName} non è valido.`,
    );
  }
  return number;
}

function normalizePayload(payload = {}, indexedDurationSeconds = 0) {
  const sessionId = String(payload.sessionId || '').trim();
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new MusicListeningError(
      'MUSIC_LISTENING_INVALID_SESSION',
      'La sessione di ascolto non è valida.',
    );
  }

  const event = String(payload.event || 'checkpoint').trim().toLowerCase();
  if (!EVENTS.has(event)) {
    throw new MusicListeningError(
      'MUSIC_LISTENING_INVALID_EVENT',
      'L’evento di ascolto non è supportato.',
    );
  }

  const requestedDuration = finiteSeconds(payload.durationSeconds || 0, 'La durata');
  const indexedDuration = Number(indexedDurationSeconds) > 0 ? Number(indexedDurationSeconds) : 0;
  const durationSeconds = requestedDuration > 0 ? requestedDuration : indexedDuration;
  const rawPosition = finiteSeconds(payload.positionSeconds || 0, 'La posizione');
  const positionSeconds = durationSeconds > 0 ? Math.min(rawPosition, durationSeconds) : rawPosition;
  const listenedSeconds = finiteSeconds(payload.listenedSeconds || 0, 'Il tempo ascoltato');
  const thresholdSeconds = durationSeconds > 0 && durationSeconds < 60
    ? durationSeconds * 0.5
    : 30;
  const qualified = listenedSeconds >= thresholdSeconds;
  const completed = event === 'ended' && qualified;

  return {
    sessionId,
    event,
    positionSeconds,
    durationSeconds,
    listenedSeconds,
    thresholdSeconds,
    qualified,
    completed,
  };
}

function transaction(callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

function recordMusicListening(profileKey, trackId, payload) {
  const track = findTrack.get(String(trackId || '').trim());
  if (!track) return null;

  const normalizedProfileKey = normalizeProfileKey(profileKey);
  const input = normalizePayload(payload, track.indexedDurationSeconds);
  const now = new Date().toISOString();

  const result = transaction(() => {
    const previousSession = findSession.get(input.sessionId);
    if (previousSession && (
      Number(previousSession.trackInternalId) !== Number(track.id)
      || previousSession.profileKey !== normalizedProfileKey
    )) {
      throw new MusicListeningError(
        'MUSIC_LISTENING_SESSION_CONFLICT',
        'La sessione di ascolto appartiene a un altro brano o profilo.',
        409,
      );
    }

    const wasQualified = Boolean(previousSession?.qualified);
    const wasCompleted = Boolean(previousSession?.completed);
    const listenedSeconds = Math.max(Number(previousSession?.listenedSeconds || 0), input.listenedSeconds);
    const qualified = wasQualified || input.qualified;
    const completed = wasCompleted || input.completed;
    const countedPlay = !wasQualified && qualified;
    const countedCompletion = !wasCompleted && completed;

    if (previousSession) {
      updateSession.run(
        qualified ? 1 : 0,
        completed ? 1 : 0,
        listenedSeconds,
        now,
        input.sessionId,
      );
    } else {
      insertSession.run(
        input.sessionId,
        track.id,
        normalizedProfileKey,
        qualified ? 1 : 0,
        completed ? 1 : 0,
        listenedSeconds,
        now,
        now,
      );
    }

    const previousHistory = getHistory.get(track.id, normalizedProfileKey);
    const playCount = Number(previousHistory?.playCount || 0) + (countedPlay ? 1 : 0);
    const completedCount = Number(previousHistory?.completedCount || 0) + (countedCompletion ? 1 : 0);
    const lastPlayedAt = qualified ? now : (previousHistory?.lastPlayedAt || null);

    if (previousHistory) {
      updateHistory.run(
        playCount,
        completedCount,
        input.positionSeconds,
        input.durationSeconds,
        lastPlayedAt,
        now,
        track.id,
        normalizedProfileKey,
      );
    } else {
      insertHistory.run(
        track.id,
        normalizedProfileKey,
        playCount,
        completedCount,
        input.positionSeconds,
        input.durationSeconds,
        lastPlayedAt,
        now,
      );
    }

    return {
      trackId: track.trackId,
      sessionId: input.sessionId,
      event: input.event,
      qualified,
      completed,
      countedPlay,
      countedCompletion,
      thresholdSeconds: input.thresholdSeconds,
      listenedSeconds,
      positionSeconds: input.positionSeconds,
      durationSeconds: input.durationSeconds,
      playCount,
      completedCount,
      lastPlayedAt,
    };
  });

  cleanupOldSessions.run();
  return result;
}

module.exports = {
  MusicListeningError,
  normalizePayload,
  recordMusicListening,
};
