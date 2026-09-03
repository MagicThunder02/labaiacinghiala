'use strict';

(function exposeAccountNavigation(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.BaiaAccountNavigation = Object.freeze(api);
})(typeof window !== 'undefined' ? window : globalThis, () => {
  function normalizedSections(state) {
    return new Set(
      (Array.isArray(state?.sections) ? state.sections : [])
        .map((value) => String(value || '').trim().toLowerCase())
        .filter(Boolean),
    );
  }

  function hasSection(state, sectionKey) {
    const section = String(sectionKey || '').trim().toLowerCase();
    return Boolean(section) && normalizedSections(state).has(section);
  }

  function hasCapability(state, capabilityKey) {
    const capability = String(capabilityKey || '').trim();
    return Boolean(capability) && state?.capabilities?.[capability] === true;
  }

  function canAccessPage(page, state, { allowUnauthenticated = false } = {}) {
    if (!page) return false;
    if (!state?.authenticated) return Boolean(allowUnauthenticated && page.allowUnauthenticated);
    if (state?.account?.mustChangePassword && !page.allowPasswordChange) return false;
    if (page.section && !hasSection(state, page.section)) return false;
    if (page.capability && !hasCapability(state, page.capability)) return false;
    if (page.role && state?.account?.role !== page.role) return false;
    return true;
  }

  function filterNavigation(items, state) {
    const filtered = [];
    for (const item of Array.isArray(items) ? items : []) {
      if (item?.type === 'group') {
        const pages = (Array.isArray(item.pages) ? item.pages : [])
          .filter((page) => canAccessPage(page, state));
        if (pages.length) filtered.push({ ...item, pages });
        continue;
      }
      if (canAccessPage(item, state)) filtered.push(item);
    }
    return filtered;
  }

  function flattenPages(items) {
    const pages = [];
    for (const item of Array.isArray(items) ? items : []) {
      if (item?.type === 'group') pages.push(...flattenPages(item.pages));
      else if (item) pages.push(item);
    }
    return pages;
  }

  function firstAccessiblePage(items, state, fallbackPage = null) {
    return flattenPages(items).find((page) => canAccessPage(page, state)) || fallbackPage;
  }

  return {
    normalizedSections,
    hasSection,
    hasCapability,
    canAccessPage,
    filterNavigation,
    flattenPages,
    firstAccessiblePage,
  };
});
