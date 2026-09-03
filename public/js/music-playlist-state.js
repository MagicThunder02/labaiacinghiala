(function playlistStateModule(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BaiaMusicPlaylistState = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  function normalizeTrackIds(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    return value.map((item) => String(item || '').trim()).filter((item) => {
      if (!item || seen.has(item)) return false;
      seen.add(item);
      return true;
    });
  }

  function moveTrackIds(value, trackId, offset) {
    const trackIds = normalizeTrackIds(value);
    const id = String(trackId || '').trim();
    const direction = Math.sign(Number(offset) || 0);
    const from = trackIds.indexOf(id);
    if (from < 0 || !direction) return { trackIds, moved: false, from, to: from };
    const to = from + direction;
    if (to < 0 || to >= trackIds.length) return { trackIds, moved: false, from, to: from };
    [trackIds[from], trackIds[to]] = [trackIds[to], trackIds[from]];
    return { trackIds, moved: true, from, to };
  }

  function playlistDraft(payload = {}) {
    return {
      name: String(payload.name || '').replace(/\s+/g, ' ').trim(),
      description: String(payload.description || '').replace(/\s+/g, ' ').trim(),
    };
  }

  return { moveTrackIds, normalizeTrackIds, playlistDraft };
}));
