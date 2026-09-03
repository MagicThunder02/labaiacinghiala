(function initMusicPlayerVisibility(globalObject, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else globalObject.BaiaMusicPlayerVisibility = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function createMusicPlayerVisibilityApi() {
  'use strict';

  const BLOCKED_PAGE_IDS = Object.freeze(['films', 'series']);
  const blockedPages = new Set(BLOCKED_PAGE_IDS);

  function normalizePageId(value) {
    return String(value || '').trim().toLowerCase();
  }

  function isPlaybackBlocked(pageId) {
    return blockedPages.has(normalizePageId(pageId));
  }

  function createVisibilityState({ pageId = '', collapsed = false } = {}) {
    let currentPageId = normalizePageId(pageId);
    let miniCollapsed = Boolean(collapsed);

    function setPage(nextPageId) {
      const previousPageId = currentPageId;
      const wasBlocked = isPlaybackBlocked(previousPageId);
      currentPageId = normalizePageId(nextPageId);
      const blocked = isPlaybackBlocked(currentPageId);
      return {
        pageId: currentPageId,
        previousPageId,
        blocked,
        becameBlocked: blocked && !wasBlocked,
        becameAllowed: !blocked && wasBlocked,
      };
    }

    function setCollapsed(value) {
      miniCollapsed = Boolean(value);
      return miniCollapsed;
    }

    function view({ hasTrack = false, fullOpen = false } = {}) {
      const blocked = isPlaybackBlocked(currentPageId);
      const available = Boolean(hasTrack) && !blocked;
      const showFull = available && Boolean(fullOpen);
      const showMiniContainer = available && !showFull;
      const showRestore = showMiniContainer && miniCollapsed;
      const reserveMiniSpace = showMiniContainer && !miniCollapsed;
      return {
        pageId: currentPageId,
        blocked,
        collapsed: miniCollapsed,
        showFull,
        showMiniContainer,
        showRestore,
        reserveMiniSpace,
      };
    }

    function snapshot() {
      return {
        pageId: currentPageId,
        blocked: isPlaybackBlocked(currentPageId),
        collapsed: miniCollapsed,
      };
    }

    return Object.freeze({
      setPage,
      setCollapsed,
      view,
      snapshot,
      isBlocked: () => isPlaybackBlocked(currentPageId),
    });
  }

  return Object.freeze({ BLOCKED_PAGE_IDS, isPlaybackBlocked, createVisibilityState });
});
