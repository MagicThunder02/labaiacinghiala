(function exposeMusicPlayerState(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BaiaMusicPlayerState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createMusicPlayerStateModule() {
  'use strict';

  const MODES = Object.freeze(['normal', 'shuffle', 'repeat', 'repeat-one']);

  function normalizeText(value) {
    return String(value || '').trim();
  }

  function normalizeTrack(value) {
    if (!value || typeof value !== 'object') return null;
    const trackId = normalizeText(value.trackId);
    const streamUrl = normalizeText(value.streamUrl);
    if (!trackId || !streamUrl.startsWith('/api/music/tracks/') || !streamUrl.endsWith('/stream')) return null;

    const artists = Array.isArray(value.artists)
      ? value.artists.map((artist) => ({
        artistId: normalizeText(artist?.artistId) || null,
        name: normalizeText(artist?.name),
      })).filter((artist) => artist.name)
      : [];

    return Object.freeze({
      trackId,
      title: normalizeText(value.title) || 'Brano senza titolo',
      artists,
      albumId: normalizeText(value.albumId) || null,
      albumTitle: normalizeText(value.albumTitle),
      coverUrl: normalizeText(value.coverUrl) || null,
      streamUrl,
      durationSeconds: Number.isFinite(Number(value.durationSeconds))
        ? Math.max(0, Number(value.durationSeconds))
        : 0,
    });
  }

  function shuffle(values, random) {
    const result = [...values];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const candidate = Number(random());
      const bounded = Number.isFinite(candidate) ? Math.min(Math.max(candidate, 0), 0.999999999) : 0;
      const target = Math.floor(bounded * (index + 1));
      [result[index], result[target]] = [result[target], result[index]];
    }
    return result;
  }

  function createPlayerState({ random = Math.random } = {}) {
    let queue = [];
    let order = [];
    let position = -1;
    let mode = MODES[0];
    let context = null;

    function currentQueueIndex() {
      return position >= 0 && position < order.length ? order[position] : -1;
    }

    function currentTrack() {
      const index = currentQueueIndex();
      return index >= 0 ? queue[index] || null : null;
    }

    function naturalOrder() {
      return queue.map((_, index) => index);
    }

    function rebuildOrder(nextMode) {
      const currentIndex = currentQueueIndex();
      if (!queue.length) {
        order = [];
        position = -1;
        return;
      }

      if (nextMode === 'shuffle') {
        const activeIndex = currentIndex >= 0 ? currentIndex : 0;
        const remaining = naturalOrder().filter((index) => index !== activeIndex);
        order = [activeIndex, ...shuffle(remaining, random)];
        position = 0;
        return;
      }

      order = naturalOrder();
      position = currentIndex >= 0 ? currentIndex : 0;
    }

    function setMode(value) {
      if (!MODES.includes(value)) throw new TypeError('Modalità di riproduzione non valida.');
      if (mode === value) return mode;
      rebuildOrder(value);
      mode = value;
      return mode;
    }

    function cycleMode() {
      const index = MODES.indexOf(mode);
      return setMode(MODES[(index + 1) % MODES.length]);
    }

    function setQueue(values, { startTrackId = '', queueContext = null } = {}) {
      const seen = new Set();
      queue = (Array.isArray(values) ? values : [])
        .map(normalizeTrack)
        .filter((track) => {
          if (!track || seen.has(track.trackId)) return false;
          seen.add(track.trackId);
          return true;
        });
      context = queueContext && typeof queueContext === 'object'
        ? Object.freeze({
          type: normalizeText(queueContext.type) || 'selection',
          id: normalizeText(queueContext.id) || null,
          title: normalizeText(queueContext.title) || '',
        })
        : Object.freeze({ type: 'selection', id: null, title: '' });

      const requestedIndex = queue.findIndex((track) => track.trackId === normalizeText(startTrackId));
      order = naturalOrder();
      position = requestedIndex >= 0 ? requestedIndex : (queue.length ? 0 : -1);
      if (mode === 'shuffle' && queue.length) rebuildOrder('shuffle');
      return currentTrack();
    }

    function selectTrack(trackId) {
      const requestedId = normalizeText(trackId);
      if (!requestedId) return null;
      const queueIndex = queue.findIndex((track) => track.trackId === requestedId);
      if (queueIndex < 0) return null;
      const orderIndex = order.indexOf(queueIndex);
      if (orderIndex < 0) return null;
      const changed = orderIndex !== position;
      position = orderIndex;
      return { track: currentTrack(), changed };
    }

    function appendTracks(values) {
      const seen = new Set(queue.map((track) => track.trackId));
      const added = [];
      for (const value of Array.isArray(values) ? values : []) {
        const track = normalizeTrack(value);
        if (!track || seen.has(track.trackId)) continue;
        seen.add(track.trackId);
        queue.push(track);
        order.push(queue.length - 1);
        added.push(track);
      }

      const selectedFirstTrack = position < 0 && added.length > 0;
      if (selectedFirstTrack) position = order.length - added.length;
      return Object.freeze({
        added: Object.freeze([...added]),
        addedCount: added.length,
        selectedFirstTrack,
        currentTrack: currentTrack(),
      });
    }

    function moveTrack(trackId, targetPosition) {
      const requestedId = normalizeText(trackId);
      const sourcePosition = order.findIndex((queueIndex) => queue[queueIndex]?.trackId === requestedId);
      if (sourcePosition < 0 || order.length < 2) return null;
      const boundedTarget = Math.min(order.length - 1, Math.max(0, Number.parseInt(targetPosition, 10) || 0));
      if (sourcePosition === boundedTarget) {
        return Object.freeze({ changed: false, modeChanged: false, track: currentTrack() });
      }

      const currentId = currentTrack()?.trackId || '';
      const orderedTracks = order.map((queueIndex) => queue[queueIndex]);
      const [moved] = orderedTracks.splice(sourcePosition, 1);
      orderedTracks.splice(boundedTarget, 0, moved);
      queue = orderedTracks;
      order = naturalOrder();
      position = currentId ? queue.findIndex((track) => track.trackId === currentId) : -1;
      const modeChanged = mode !== 'normal';
      mode = 'normal';
      return Object.freeze({ changed: true, modeChanged, track: currentTrack() });
    }

    function removeTrack(trackId) {
      const requestedId = normalizeText(trackId);
      const queueIndex = queue.findIndex((track) => track.trackId === requestedId);
      if (queueIndex < 0) return null;
      const orderPosition = order.indexOf(queueIndex);
      if (orderPosition < 0) return null;

      const removed = queue[queueIndex];
      const wasCurrent = orderPosition === position;
      const hadNext = wasCurrent && orderPosition + 1 < order.length;
      queue.splice(queueIndex, 1);
      order = order
        .filter((index) => index !== queueIndex)
        .map((index) => index > queueIndex ? index - 1 : index);

      if (wasCurrent) position = hadNext ? orderPosition : (order.length ? 0 : -1);
      else if (orderPosition < position) position -= 1;

      return Object.freeze({
        removed,
        wasCurrent,
        hadNext,
        nextTrack: currentTrack(),
        queueEmpty: queue.length === 0,
      });
    }

    function clearQueue() {
      const removedCount = queue.length;
      queue = [];
      order = [];
      position = -1;
      context = null;
      return removedCount;
    }

    function next({ automatic = false } = {}) {
      const current = currentTrack();
      if (!current) return null;
      if (automatic && mode === 'repeat-one') return { track: current, replay: true, changed: false };

      if (position + 1 < order.length) {
        position += 1;
        return { track: currentTrack(), replay: false, changed: true };
      }
      if (mode === 'repeat') {
        position = 0;
        return { track: currentTrack(), replay: false, changed: true };
      }
      return null;
    }

    function previous() {
      const current = currentTrack();
      if (!current) return null;
      if (position > 0) {
        position -= 1;
        return { track: currentTrack(), changed: true };
      }
      if (mode === 'repeat' && order.length > 1) {
        position = order.length - 1;
        return { track: currentTrack(), changed: true };
      }
      return { track: current, changed: false };
    }

    function snapshot() {
      const orderedQueue = order.map((queueIndex, orderPosition) => Object.freeze({
        ...queue[queueIndex],
        orderPosition,
        active: orderPosition === position,
      }));
      return Object.freeze({
        mode,
        modes: MODES,
        queueLength: queue.length,
        queueIndex: currentQueueIndex(),
        orderPosition: position,
        currentTrack: currentTrack(),
        context,
        queue: Object.freeze(orderedQueue),
      });
    }

    return Object.freeze({
      setQueue,
      appendTracks,
      moveTrack,
      removeTrack,
      clearQueue,
      selectTrack,
      currentTrack,
      next,
      previous,
      setMode,
      cycleMode,
      snapshot,
    });
  }

  return Object.freeze({ MODES, normalizeTrack, createPlayerState });
});
