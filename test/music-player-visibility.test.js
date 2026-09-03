'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  BLOCKED_PAGE_IDS,
  isPlaybackBlocked,
  createVisibilityState,
} = require('../public/js/music-player-visibility');

test('solo Film e Serie sospendono e nascondono il player musicale', () => {
  assert.deepEqual(BLOCKED_PAGE_IDS, ['films', 'series']);
  assert.equal(isPlaybackBlocked('films'), true);
  assert.equal(isPlaybackBlocked('series'), true);
  for (const pageId of ['music', 'books', 'comics', 'manga', 'upload-manager', 'metadata-editor', 'profile']) {
    assert.equal(isPlaybackBlocked(pageId), false, pageId);
  }
});

test('il mini-player si collassa senza perdere la coda e ricompare nelle sezioni consentite', () => {
  const visibility = createVisibilityState({ pageId: 'music' });
  assert.deepEqual(visibility.view({ hasTrack: true, fullOpen: false }), {
    pageId: 'music',
    blocked: false,
    collapsed: false,
    showFull: false,
    showMiniContainer: true,
    showRestore: false,
    reserveMiniSpace: true,
  });

  visibility.setCollapsed(true);
  const collapsed = visibility.view({ hasTrack: true, fullOpen: false });
  assert.equal(collapsed.showMiniContainer, true);
  assert.equal(collapsed.showRestore, true);
  assert.equal(collapsed.reserveMiniSpace, false);

  const blocked = visibility.setPage('films');
  assert.equal(blocked.becameBlocked, true);
  assert.equal(visibility.view({ hasTrack: true, fullOpen: true }).showFull, false);
  assert.equal(visibility.view({ hasTrack: true, fullOpen: false }).showRestore, false);

  const allowed = visibility.setPage('books');
  assert.equal(allowed.becameAllowed, true);
  assert.equal(visibility.view({ hasTrack: true, fullOpen: false }).showRestore, true);
});
