(function exposeMusicListeningState(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BaiaMusicListeningState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createMusicListeningModule(root) {
  'use strict';

  function normalizeSeconds(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : 0;
  }

  function createUuid() {
    if (root?.crypto?.randomUUID) return root.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    if (root?.crypto?.getRandomValues) root.crypto.getRandomValues(bytes);
    else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function createListeningState({ createSessionId = createUuid, now = Date.now } = {}) {
    let state = null;

    function snapshot() {
      if (!state) return null;
      return {
        sessionId: state.sessionId,
        trackId: state.trackId,
        listenedSeconds: state.listenedSeconds,
        positionSeconds: state.lastMediaTime,
        playing: state.playing,
      };
    }

    function start(trackId, currentTime = 0, wallMs = now()) {
      const normalizedTrackId = String(trackId || '').trim();
      if (!normalizedTrackId) return null;
      state = {
        sessionId: String(createSessionId()),
        trackId: normalizedTrackId,
        listenedSeconds: 0,
        lastMediaTime: normalizeSeconds(currentTime),
        lastWallMs: Number(wallMs) || 0,
        playing: false,
      };
      return snapshot();
    }

    function sample(currentTime = 0, wallMs = now()) {
      if (!state) return null;
      const mediaTime = normalizeSeconds(currentTime);
      const wallTime = Number(wallMs) || state.lastWallMs;
      if (state.playing) {
        const mediaDelta = mediaTime - state.lastMediaTime;
        const wallDelta = Math.max(0, (wallTime - state.lastWallMs) / 1000);
        const maximumCredibleDelta = Math.max(3, wallDelta * 1.75 + 1.5);
        if (mediaDelta > 0 && mediaDelta <= maximumCredibleDelta) {
          state.listenedSeconds += mediaDelta;
        }
      }
      state.lastMediaTime = mediaTime;
      state.lastWallMs = wallTime;
      return snapshot();
    }

    function play(currentTime = 0, wallMs = now()) {
      if (!state) return null;
      sample(currentTime, wallMs);
      state.playing = true;
      state.lastMediaTime = normalizeSeconds(currentTime);
      state.lastWallMs = Number(wallMs) || state.lastWallMs;
      return snapshot();
    }

    function pause(currentTime = 0, wallMs = now()) {
      if (!state) return null;
      sample(currentTime, wallMs);
      state.playing = false;
      return snapshot();
    }

    function seek(currentTime = 0, wallMs = now()) {
      if (!state) return null;
      state.lastMediaTime = normalizeSeconds(currentTime);
      state.lastWallMs = Number(wallMs) || state.lastWallMs;
      return snapshot();
    }

    function payload(durationSeconds = 0, event = 'checkpoint') {
      if (!state) return null;
      return {
        sessionId: state.sessionId,
        event: String(event || 'checkpoint'),
        positionSeconds: state.lastMediaTime,
        durationSeconds: normalizeSeconds(durationSeconds),
        listenedSeconds: state.listenedSeconds,
      };
    }

    function clear() {
      const previous = snapshot();
      state = null;
      return previous;
    }

    return Object.freeze({
      clear,
      isCurrent: (trackId) => Boolean(state && state.trackId === String(trackId || '').trim()),
      pause,
      payload,
      play,
      sample,
      seek,
      snapshot,
      start,
    });
  }

  return Object.freeze({ createListeningState });
});
