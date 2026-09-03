const frames = new Map();
const pageById = new Map();
const STORAGE_PAGE = 'baiaCinghialaCurrentPage';
const STORAGE_GROUPS = 'baiaCinghialaOpenGroups';
const TOUCH_LAYOUT_QUERY = '(hover: none) and (pointer: coarse)';
const touchLayoutMedia = window.matchMedia(TOUCH_LAYOUT_QUERY);

const menuDefinition = [
  {
    type: 'group',
    id: 'cinema',
    label: 'Cinema',
    icon: '/icons/cinema.svg',
    pages: [
      { id: 'films', label: 'Film', icon: '/icons/film.svg', src: '/pages/films.html', section: 'films' },
      { id: 'series', label: 'Serie', icon: '/icons/series.svg', src: '/pages/series.html', section: 'series' },
    ],
  },
  { type: 'page', id: 'music', label: 'Musica', icon: '/icons/music.svg', src: '/pages/music.html', section: 'music' },
  {
    type: 'group',
    id: 'reading',
    label: 'Libri',
    icon: '/icons/books.svg',
    pages: [
      { id: 'books', label: 'Libri', icon: '/icons/books.svg', src: '/pages/books.html', section: 'books' },
      { id: 'comics', label: 'Fumetti', icon: '/icons/comics.svg', src: '/pages/comics.html', section: 'comics' },
      { id: 'manga', label: 'Manga', icon: '/icons/manga.svg', src: '/pages/manga.html', section: 'manga' },
    ],
  },
];

const quickDefinition = [
  { type: 'page', id: 'upload-manager', label: 'Upload manager', icon: '/icons/upload.svg', src: '/pages/upload-manager.html', capability: 'uploadContent' },
  { type: 'page', id: 'metadata-editor', label: 'Metadati', icon: '/icons/metadata.svg', src: '/pages/metadata-editor.html', capability: 'editMetadata' },
  { type: 'page', id: 'account-manager', label: 'Account', icon: '/icons/users.svg', src: '/pages/account-manager.html', capability: 'manageAccounts' },
];

const hiddenPages = [
  { id: 'profile', label: 'Profilo', src: '/pages/profile.html', allowUnauthenticated: true, allowPasswordChange: true },
];

const accountNavigation = window.BaiaAccountNavigation;
if (!accountNavigation) throw new Error('Policy di navigazione account non disponibile.');

const elements = {
  sidebar: document.querySelector('#sidebar'),
  sidebarTab: document.querySelector('#sidebarTab'),
  mainMenu: document.querySelector('#mainMenu'),
  quickLinks: document.querySelector('#quickLinks'),
  contentArea: document.querySelector('#contentArea'),
  loadingState: document.querySelector('#loadingState'),
  profileName: document.querySelector('#profileName'),
  profileAvatar: document.querySelector('#profileAvatar'),
  profileButton: document.querySelector('#profileButton'),
  profileMenuButton: document.querySelector('#profileMenuButton'),
  userMenu: document.querySelector('#userMenu'),
  reloadCurrentPage: document.querySelector('#reloadCurrentPage'),
  logoutAccount: document.querySelector('#logoutAccount'),
  versionLabel: document.querySelector('#versionLabel'),
  shellToast: document.querySelector('#shellToast'),
  sidebarBackdrop: document.querySelector('#sidebarBackdrop'),
  authGate: document.querySelector('#authGate'),
  authTitle: document.querySelector('#authTitle'),
  authDescription: document.querySelector('#authDescription'),
  authLoading: document.querySelector('#authLoading'),
  loginForm: document.querySelector('#loginForm'),
  loginUsername: document.querySelector('#loginUsername'),
  loginPassword: document.querySelector('#loginPassword'),
  loginSubmit: document.querySelector('#loginSubmit'),
  authMessage: document.querySelector('#authMessage'),
  authActions: document.querySelector('#authActions'),
  authRetryButton: document.querySelector('#authRetryButton'),
  authSetupButton: document.querySelector('#authSetupButton'),
  musicFullPlayer: document.querySelector('#musicFullPlayer'),
  musicFullBackdrop: document.querySelector('#musicFullBackdrop'),
  musicFullBackButton: document.querySelector('#musicFullBackButton'),
  musicFullMenuButton: document.querySelector('#musicFullMenuButton'),
  musicFullMenu: document.querySelector('#musicFullMenu'),
  musicGoArtistButton: document.querySelector('#musicGoArtistButton'),
  musicGoAlbumButton: document.querySelector('#musicGoAlbumButton'),
  musicShowQueueButton: document.querySelector('#musicShowQueueButton'),
  musicFullArtwork: document.querySelector('#musicFullArtwork'),
  musicFullTitle: document.querySelector('#musicFullTitle'),
  musicFullSubtitle: document.querySelector('#musicFullSubtitle'),
  musicFullCurrentTime: document.querySelector('#musicFullCurrentTime'),
  musicFullProgress: document.querySelector('#musicFullProgress'),
  musicFullDuration: document.querySelector('#musicFullDuration'),
  musicFullPreviousButton: document.querySelector('#musicFullPreviousButton'),
  musicFullPlayPauseButton: document.querySelector('#musicFullPlayPauseButton'),
  musicFullNextButton: document.querySelector('#musicFullNextButton'),
  musicFullModeButton: document.querySelector('#musicFullModeButton'),
  musicFullVolumeButton: document.querySelector('#musicFullVolumeButton'),
  musicFullVolume: document.querySelector('#musicFullVolume'),
  musicQueuePanel: document.querySelector('#musicQueuePanel'),
  musicQueueTitle: document.querySelector('#musicQueueTitle'),
  musicQueueClearButton: document.querySelector('#musicQueueClearButton'),
  musicQueueCloseButton: document.querySelector('#musicQueueCloseButton'),
  musicQueueList: document.querySelector('#musicQueueList'),
  musicMiniPlayer: document.querySelector('#musicMiniPlayer'),
  musicMiniCollapseButton: document.querySelector('#musicMiniCollapseButton'),
  musicMiniRestoreButton: document.querySelector('#musicMiniRestoreButton'),
  musicMiniCover: document.querySelector('#musicMiniCover'),
  musicMiniTitle: document.querySelector('#musicMiniTitle'),
  musicMiniArtist: document.querySelector('#musicMiniArtist'),
  musicMiniProgress: document.querySelector('#musicMiniProgress'),
  musicPreviousButton: document.querySelector('#musicPreviousButton'),
  musicPlayPauseButton: document.querySelector('#musicPlayPauseButton'),
  musicNextButton: document.querySelector('#musicNextButton'),
  musicModeButton: document.querySelector('#musicModeButton'),
  musicMiniVolumeButton: document.querySelector('#musicMiniVolumeButton'),
  musicMiniVolumePopover: document.querySelector('#musicMiniVolumePopover'),
  musicMiniVolume: document.querySelector('#musicMiniVolume'),
  musicPlayerStatus: document.querySelector('#musicPlayerStatus'),
  musicAudio: document.querySelector('#musicAudio'),
};


function usesTouchLayout() {
  return touchLayoutMedia.matches;
}

function syncSidebarTabPlacement() {
  if (!elements.sidebarTab || !elements.sidebar) return;

  if (usesTouchLayout()) {
    // Il pannello deve poter scorrere verticalmente: tenere il trigger al suo
    // interno lo farebbe ritagliare dall'overflow. Come fratello resta sempre
    // visibile e sopra l'iframe/backdrop.
    if (elements.sidebarTab.parentElement === elements.sidebar) {
      elements.sidebar.insertAdjacentElement('afterend', elements.sidebarTab);
    }
    return;
  }

  // Ripristina il DOM desktop originale, compreso il comportamento hover.
  if (elements.sidebarTab.parentElement !== elements.sidebar) {
    elements.sidebar.insertBefore(elements.sidebarTab, elements.sidebar.firstChild);
  }
}

function syncShellViewport() {
  const visualHeight = window.visualViewport?.height;
  const viewportHeight = Math.round(
    Number.isFinite(visualHeight) && visualHeight > 0
      ? visualHeight
      : (window.innerHeight || document.documentElement.clientHeight || 0),
  );
  if (viewportHeight > 0) document.documentElement.style.setProperty('--baia-shell-height', `${viewportHeight}px`);
}

function syncBackdrop(open) {
  if (!elements.sidebarBackdrop) return;
  const visible = Boolean(open);
  elements.sidebarBackdrop.hidden = !visible;
  elements.sidebarBackdrop.setAttribute('aria-hidden', String(!visible));
  elements.sidebarBackdrop.tabIndex = visible ? 0 : -1;
}

function setSidebarOpen(open, { returnFocus = false } = {}) {
  const shouldOpen = Boolean(open);
  const modalDrawer = shouldOpen && usesTouchLayout();

  elements.sidebar.classList.toggle('is-open', shouldOpen);
  elements.sidebarTab.setAttribute('aria-expanded', String(shouldOpen));
  elements.sidebarTab.setAttribute('aria-label', shouldOpen ? 'Chiudi menu' : 'Apri menu');
  document.body.classList.toggle('drawer-open', modalDrawer);
  syncBackdrop(modalDrawer);

  if (!shouldOpen) {
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && elements.sidebar.contains(activeElement)) activeElement.blur();
    if (returnFocus && usesTouchLayout()) requestAnimationFrame(() => elements.sidebarTab.focus({ preventScroll: true }));
  }
}

function resetDrawerState() {
  elements.sidebar.classList.remove('is-open');
  document.body.classList.remove('drawer-open');
  elements.sidebarTab.setAttribute('aria-expanded', 'false');
  elements.sidebarTab.setAttribute('aria-label', 'Apri menu');
  syncBackdrop(false);
}

function syncTouchShell() {
  syncShellViewport();
  syncSidebarTabPlacement();
  if (!usesTouchLayout()) {
    document.body.classList.remove('drawer-open');
    syncBackdrop(false);
    return;
  }
  setSidebarOpen(elements.sidebar.classList.contains('is-open'));
}

let currentPageId = '';
let toastTimer = null;
let accountState = null;
let accountRefreshPromise = null;
let openGroups = new Set(['cinema']);
try {
  const saved = JSON.parse(localStorage.getItem(STORAGE_GROUPS) || '[]');
  if (Array.isArray(saved) && saved.length) openGroups = new Set(saved);
} catch {}

const musicPlayerState = window.BaiaMusicPlayerState?.createPlayerState();
const musicListeningState = window.BaiaMusicListeningState?.createListeningState();
const musicVisibilityState = window.BaiaMusicPlayerVisibility?.createVisibilityState();
const MUSIC_MODE_LABELS = Object.freeze({
  normal: 'Normale',
  shuffle: 'Shuffle',
  repeat: 'Ripeti',
  'repeat-one': 'Ripeti 1',
});
let musicLoadToken = 0;
let musicCoverToken = 0;
let musicCoverObjectUrl = '';
let musicBroadcastTimer = null;
let musicFullPlayerOpen = false;
let musicListeningRequestChain = Promise.resolve();
let musicListeningQualificationPendingSessionId = '';
let musicListeningQualifiedSessionId = '';
let musicMiniVolumeCloseTimer = null;
let musicLastAudibleVolume = 1;
let musicQueueDragTrackId = '';
const musicProgressThumbTimers = new WeakMap();
const musicProgressPointers = new WeakSet();

function currentMusicDuration() {
  const mediaDuration = Number(elements.musicAudio?.duration);
  if (Number.isFinite(mediaDuration) && mediaDuration > 0) return mediaDuration;
  return Math.max(0, Number(musicPlayerState?.currentTrack()?.durationSeconds) || 0);
}

function broadcastMusicHistoryUpdated(listening) {
  const message = { type: 'shell-music-history-updated', listening };
  for (const frame of frames.values()) {
    frame.contentWindow?.postMessage(message, window.location.origin);
  }
}

function sendMusicListeningPayload(trackId, payload, { keepalive = false } = {}) {
  const normalizedTrackId = String(trackId || '').trim();
  if (!normalizedTrackId || !payload) return Promise.resolve(null);

  const request = async () => {
    try {
      await window.BaiaApi?.ready;
      const response = await (window.BaiaApi.fetchApiJson || window.BaiaApi.fetchApi)(
        `/api/music/tracks/${encodeURIComponent(normalizedTrackId)}/listening`,
        {
          method: 'PUT',
          keepalive,
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        },
      );
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || `Cronologia musicale non aggiornata (${response.status}).`);
      const listening = data?.listening || null;
      if (listening?.countedPlay || listening?.countedCompletion) {
        broadcastMusicHistoryUpdated(listening);
      }
      return listening;
    } catch (error) {
      console.warn(error?.message || 'Cronologia musicale non aggiornata.');
      return null;
    }
  };

  musicListeningRequestChain = musicListeningRequestChain.catch(() => null).then(request);
  return musicListeningRequestChain;
}

function reportMusicListening(event = 'checkpoint', { final = false, keepalive = false } = {}) {
  const snapshot = musicListeningState?.snapshot();
  if (!snapshot) return Promise.resolve(null);
  musicListeningState.sample(elements.musicAudio.currentTime);
  const payload = musicListeningState.payload(currentMusicDuration(), event);
  const sessionId = payload?.sessionId || '';
  if (final) musicListeningState.clear();

  return sendMusicListeningPayload(snapshot.trackId, payload, { keepalive }).then((listening) => {
    if (listening?.qualified) musicListeningQualifiedSessionId = sessionId;
    if (musicListeningQualificationPendingSessionId === sessionId) {
      musicListeningQualificationPendingSessionId = '';
    }
    return listening;
  });
}

function finishMusicListening(event = 'change', options = {}) {
  if (!musicListeningState?.snapshot()) return Promise.resolve(null);
  musicListeningState.pause(elements.musicAudio.currentTime);
  return reportMusicListening(event, { ...options, final: true });
}

function startMusicListening(track, positionSeconds = 0) {
  if (!track?.trackId || !musicListeningState) return null;
  musicListeningQualificationPendingSessionId = '';
  musicListeningQualifiedSessionId = '';
  return musicListeningState.start(track.trackId, positionSeconds);
}

function ensureMusicListening(track) {
  if (!track?.trackId || !musicListeningState) return null;
  if (!musicListeningState.isCurrent(track.trackId)) startMusicListening(track, elements.musicAudio.currentTime);
  return musicListeningState.snapshot();
}

function maybeReportMusicQualification() {
  const snapshot = musicListeningState?.snapshot();
  if (!snapshot || !snapshot.playing) return;
  const duration = currentMusicDuration();
  const threshold = duration > 0 && duration < 60 ? duration * 0.5 : 30;
  if (snapshot.listenedSeconds < threshold) return;
  if (
    musicListeningQualifiedSessionId === snapshot.sessionId
    || musicListeningQualificationPendingSessionId === snapshot.sessionId
  ) return;

  musicListeningQualificationPendingSessionId = snapshot.sessionId;
  reportMusicListening('checkpoint');
}

function currentMusicSnapshot() {
  const snapshot = musicPlayerState?.snapshot() || {};
  const duration = Number.isFinite(elements.musicAudio?.duration) ? elements.musicAudio.duration : 0;
  return {
    mode: snapshot.mode || 'normal',
    queueLength: Number(snapshot.queueLength || 0),
    queueIndex: Number.isInteger(snapshot.queueIndex) ? snapshot.queueIndex : -1,
    context: snapshot.context || null,
    currentTrack: snapshot.currentTrack || null,
    queue: Array.isArray(snapshot.queue) ? snapshot.queue : [],
    playing: Boolean(elements.musicAudio && !elements.musicAudio.paused && !elements.musicAudio.ended),
    currentTime: Number(elements.musicAudio?.currentTime || 0),
    duration,
    volume: Number(elements.musicAudio?.volume ?? 1),
    muted: Boolean(elements.musicAudio?.muted),
    pageBlocked: Boolean(musicVisibilityState?.isBlocked()),
    miniCollapsed: Boolean(musicVisibilityState?.snapshot()?.collapsed),
  };
}

function broadcastMusicState({ immediate = false } = {}) {
  const send = () => {
    musicBroadcastTimer = null;
    const message = { type: 'shell-music-state', state: currentMusicSnapshot() };
    for (const frame of frames.values()) {
      frame.contentWindow?.postMessage(message, window.location.origin);
    }
  };
  if (immediate) {
    clearTimeout(musicBroadcastTimer);
    send();
    return;
  }
  if (!musicBroadcastTimer) musicBroadcastTimer = setTimeout(send, 220);
}

const MUSIC_FALLBACK_PALETTE = window.BaiaMediaPalette?.DEFAULT_PALETTE || Object.freeze({
  base: [22, 25, 19],
  primary: [108, 139, 72],
  secondary: [55, 95, 130],
  accentA: [164, 88, 72],
  accentB: [126, 103, 176],
});

async function extractMusicCoverPalette(objectUrl) {
  if (!window.BaiaMediaPalette) return MUSIC_FALLBACK_PALETTE;
  return window.BaiaMediaPalette.extractFromUrl(objectUrl, { width: 72, height: 72 });
}

function applyMusicPlayerPalette(palette = MUSIC_FALLBACK_PALETTE) {
  if (window.BaiaMediaPalette) {
    window.BaiaMediaPalette.applyCssVariables(elements.musicFullPlayer, palette, 'music-color');
    return;
  }
  elements.musicFullPlayer?.style.setProperty('--music-color-base', palette.base.join(', '));
  elements.musicFullPlayer?.style.setProperty('--music-color-a', palette.primary.join(', '));
  elements.musicFullPlayer?.style.setProperty('--music-color-b', palette.secondary.join(', '));
  elements.musicFullPlayer?.style.setProperty('--music-color-c', palette.accentA.join(', '));
  elements.musicFullPlayer?.style.setProperty('--music-color-d', palette.accentB.join(', '));
}

async function updateMusicPlayerPalette(objectUrl, token, trackId) {
  let palette = MUSIC_FALLBACK_PALETTE;
  try {
    palette = await extractMusicCoverPalette(objectUrl);
  } catch {
    palette = MUSIC_FALLBACK_PALETTE;
  }
  if (token !== musicCoverToken || musicPlayerState.currentTrack()?.trackId !== trackId) return;
  applyMusicPlayerPalette(palette);
}

function revokeMusicCover() {
  if (musicCoverObjectUrl) URL.revokeObjectURL(musicCoverObjectUrl);
  musicCoverObjectUrl = '';
}

function clearMusicCoverUi() {
  for (const element of [elements.musicMiniCover, elements.musicFullArtwork]) {
    element?.classList.remove('has-art');
    element?.style.removeProperty('background-image');
  }
  if (elements.musicFullBackdrop) {
    elements.musicFullBackdrop.hidden = true;
    elements.musicFullBackdrop.removeAttribute('src');
  }
  applyMusicPlayerPalette();
}

function applyMusicCoverUi(objectUrl) {
  const background = `url("${objectUrl}")`;
  for (const element of [elements.musicMiniCover, elements.musicFullArtwork]) {
    if (!element) continue;
    element.style.backgroundImage = background;
    element.classList.add('has-art');
  }
  if (elements.musicFullBackdrop) {
    elements.musicFullBackdrop.src = objectUrl;
    elements.musicFullBackdrop.hidden = false;
  }
}

async function updateMusicCover(track) {
  const token = ++musicCoverToken;
  revokeMusicCover();
  clearMusicCoverUi();
  if (!track?.coverUrl) return;

  try {
    await window.BaiaApi?.ready;
    const response = await window.BaiaApi.fetchApi(track.coverUrl, {
    });
    if (!response.ok) return;
    const blob = await response.blob();
    if (token !== musicCoverToken || musicPlayerState.currentTrack()?.trackId !== track.trackId) return;
    musicCoverObjectUrl = URL.createObjectURL(blob);
    applyMusicCoverUi(musicCoverObjectUrl);
    void updateMusicPlayerPalette(musicCoverObjectUrl, token, track.trackId);
  } catch {
    // Il placeholder resta visibile se la cover non è disponibile.
  }
}

function formatMusicTime(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(value / 60);
  const remaining = value % 60;
  return `${minutes}:${String(remaining).padStart(2, '0')}`;
}

function syncMusicProgress() {
  const duration = Number.isFinite(elements.musicAudio.duration) ? elements.musicAudio.duration : 0;
  const currentTime = Number.isFinite(elements.musicAudio.currentTime) ? elements.musicAudio.currentTime : 0;
  const bounded = Math.min(Math.max(0, currentTime), duration || 0);
  const percentage = duration > 0 ? Math.min(100, Math.max(0, currentTime / duration * 100)) : 0;

  for (const progress of [elements.musicMiniProgress, elements.musicFullProgress]) {
    progress.max = String(Math.max(0, duration));
    progress.value = String(bounded);
    progress.style.setProperty('--music-progress', `${percentage}%`);
  }
  elements.musicFullCurrentTime.textContent = formatMusicTime(currentTime);
  elements.musicFullDuration.textContent = formatMusicTime(duration);
}

function normalizedMusicVolume(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(1, Math.max(0, parsed));
}

function syncMusicVolumeUi() {
  const volume = normalizedMusicVolume(elements.musicAudio.volume);
  const silent = Boolean(elements.musicAudio.muted || volume === 0);

  for (const range of [elements.musicFullVolume, elements.musicMiniVolume]) {
    if (!range) continue;
    range.value = String(volume);
    range.style.setProperty('--music-volume', `${Math.round(volume * 100)}%`);
  }

  if (elements.musicFullVolumeButton) {
    elements.musicFullVolumeButton.classList.toggle('is-muted', silent);
    elements.musicFullVolumeButton.setAttribute('aria-label', silent ? 'Riattiva audio' : 'Disattiva audio');
    elements.musicFullVolumeButton.title = silent ? 'Riattiva audio' : 'Disattiva audio';
  }

  if (elements.musicMiniVolumeButton) {
    elements.musicMiniVolumeButton.classList.toggle('is-muted', silent);
    elements.musicMiniVolumeButton.setAttribute('aria-label', silent ? 'Riattiva audio' : 'Disattiva audio');
    elements.musicMiniVolumeButton.title = silent ? 'Riattiva audio' : 'Disattiva audio';
  }
}

function setMusicVolume(value) {
  const volume = normalizedMusicVolume(value);
  elements.musicAudio.volume = volume;
  if (volume > 0) {
    musicLastAudibleVolume = volume;
    elements.musicAudio.muted = false;
  }
  syncMusicVolumeUi();
  broadcastMusicState({ immediate: true });
  return volume;
}

function toggleMusicMute() {
  const silent = elements.musicAudio.muted || elements.musicAudio.volume === 0;
  if (silent) {
    elements.musicAudio.muted = false;
    if (elements.musicAudio.volume === 0) elements.musicAudio.volume = musicLastAudibleVolume || 1;
  } else {
    musicLastAudibleVolume = elements.musicAudio.volume || musicLastAudibleVolume;
    elements.musicAudio.muted = true;
  }
  syncMusicVolumeUi();
  broadcastMusicState({ immediate: true });
  return elements.musicAudio.muted;
}

function clearMusicMiniVolumeTimer() {
  clearTimeout(musicMiniVolumeCloseTimer);
  musicMiniVolumeCloseTimer = null;
}

function closeMusicMiniVolumePopover() {
  clearMusicMiniVolumeTimer();
  if (!elements.musicMiniVolumePopover || elements.musicMiniVolumePopover.hidden) return false;
  elements.musicMiniVolumePopover.hidden = true;
  elements.musicMiniVolumeButton?.setAttribute('aria-expanded', 'false');
  syncMusicVolumeUi();
  return true;
}

function scheduleMusicMiniVolumeClose() {
  clearMusicMiniVolumeTimer();
  musicMiniVolumeCloseTimer = setTimeout(closeMusicMiniVolumePopover, 2000);
}

function dismissMusicMiniVolumeFromShellPointer(event) {
  if (!event?.target?.closest?.('.music-mini-volume-wrap')) closeMusicMiniVolumePopover();
}

function bindMusicMiniVolumeDismissalToFrame(frame) {
  if (!frame) return;
  const bind = () => {
    try {
      frame.contentDocument?.addEventListener('pointerdown', closeMusicMiniVolumePopover, true);
    } catch {
      // Le pagine della shell sono same-origin; in caso contrario resta attivo
      // il timer automatico di chiusura come fallback.
    }
  };
  frame.addEventListener('load', bind);
  if (frame.contentDocument?.readyState === 'complete') bind();
}

function openMusicMiniVolumePopover() {
  if (!elements.musicMiniVolumePopover) return false;
  elements.musicMiniVolumePopover.hidden = false;
  elements.musicMiniVolumeButton?.setAttribute('aria-expanded', 'true');
  syncMusicVolumeUi();
  scheduleMusicMiniVolumeClose();
  return true;
}

function setMusicProgressThumbVisible(control, visible, delay = 0) {
  if (!control) return;
  clearTimeout(musicProgressThumbTimers.get(control));
  musicProgressThumbTimers.delete(control);
  if (visible) {
    control.classList.add('is-interacting');
    return;
  }
  const hide = () => control.classList.remove('is-interacting');
  if (delay > 0) musicProgressThumbTimers.set(control, setTimeout(hide, delay));
  else hide();
}

function bindTransientMusicSliderThumb(control) {
  if (!control) return;
  control.addEventListener('pointerdown', () => {
    musicProgressPointers.add(control);
    setMusicProgressThumbVisible(control, true);
  });
  control.addEventListener('input', () => {
    setMusicProgressThumbVisible(control, true);
    if (!musicProgressPointers.has(control)) setMusicProgressThumbVisible(control, false, 500);
  });
  const finish = () => {
    musicProgressPointers.delete(control);
    setMusicProgressThumbVisible(control, false);
  };
  control.addEventListener('pointerup', finish);
  control.addEventListener('pointercancel', finish);
  control.addEventListener('change', finish);
  control.addEventListener('blur', finish);
}

function closeMusicFullMenu() {
  elements.musicFullMenu.hidden = true;
  elements.musicFullMenuButton.setAttribute('aria-expanded', 'false');
}

function closeMusicQueue() {
  elements.musicQueuePanel.hidden = true;
}

function isMusicPlaybackBlocked() {
  return Boolean(musicVisibilityState?.isBlocked());
}

function setMusicMiniCollapsed(collapsed) {
  if (!musicPlayerState?.currentTrack() || isMusicPlaybackBlocked()) return false;
  closeMusicMiniVolumePopover();
  const value = musicVisibilityState?.setCollapsed(collapsed) ?? Boolean(collapsed);
  syncMusicPlayerUi();
  return value;
}

function applyMusicPagePolicy(pageId) {
  const transition = musicVisibilityState?.setPage(pageId) || { blocked: false };
  if (transition.blocked) {
    musicFullPlayerOpen = false;
    closeMusicFullMenu();
    closeMusicQueue();
    closeMusicMiniVolumePopover();
    if (!elements.musicAudio.paused) elements.musicAudio.pause();
  }
  syncMusicPlayerUi();
  broadcastMusicState({ immediate: true });
  return transition;
}

function setMusicFullPlayerOpen(open) {
  const visible = Boolean(open && musicPlayerState?.currentTrack() && !isMusicPlaybackBlocked());
  musicFullPlayerOpen = visible;
  elements.musicFullPlayer.hidden = !visible;
  document.body.classList.toggle('music-full-player-open', visible);
  if (!visible) {
    closeMusicFullMenu();
    closeMusicQueue();
  } else {
    requestAnimationFrame(() => elements.musicFullBackButton.focus());
  }
  syncMusicPlayerUi();
  return visible;
}

function moveMusicQueueTrack(trackId, targetPosition) {
  const result = musicPlayerState?.moveTrack(trackId, targetPosition);
  if (!result?.changed) return false;
  syncMusicPlayerUi();
  broadcastMusicState({ immediate: true });
  renderMusicQueue();
  showToast(result.modeChanged ? 'Coda riordinata. Modalità Normale attivata.' : 'Coda riordinata.');
  return true;
}

async function removeMusicQueueTrack(trackId) {
  const result = musicPlayerState?.removeTrack(trackId);
  if (!result) return false;

  if (result.wasCurrent) {
    await finishMusicListening('change');
    if (result.nextTrack) {
      await playCurrentMusicTrack({ autoplay: true });
    } else {
      musicLoadToken += 1;
      elements.musicAudio.pause();
      elements.musicAudio.removeAttribute('src');
      elements.musicAudio.load();
      revokeMusicCover();
      clearMusicCoverUi();
      musicFullPlayerOpen = false;
      syncMusicPlayerUi();
      broadcastMusicState({ immediate: true });
    }
  } else {
    syncMusicPlayerUi();
    broadcastMusicState({ immediate: true });
  }

  if (!elements.musicQueuePanel.hidden) renderMusicQueue();
  showToast(`${result.removed.title} rimosso dalla coda.${result.wasCurrent && result.nextTrack ? ' Riproduzione del brano successivo.' : ''}`);
  return true;
}

async function clearMusicQueue() {
  if (!musicPlayerState?.snapshot()?.queueLength) return false;
  await finishMusicListening('change');
  musicPlayerState.clearQueue();
  musicLoadToken += 1;
  elements.musicAudio.pause();
  elements.musicAudio.removeAttribute('src');
  elements.musicAudio.load();
  revokeMusicCover();
  clearMusicCoverUi();
  musicFullPlayerOpen = false;
  closeMusicFullMenu();
  closeMusicQueue();
  syncMusicPlayerUi();
  broadcastMusicState({ immediate: true });
  showToast('Coda svuotata.');
  return true;
}

function appendMusicQueue(payload = {}) {
  const result = musicPlayerState?.appendTracks(payload.tracks);
  if (!result) return false;
  if (!result.addedCount) {
    showToast('Il brano è già presente nella coda oppure non è riproducibile.');
    return false;
  }

  if (result.selectedFirstTrack) {
    musicVisibilityState?.setCollapsed(false);
    musicFullPlayerOpen = false;
    updateMusicCover(result.currentTrack);
  }
  syncMusicPlayerUi();
  broadcastMusicState({ immediate: true });
  if (!elements.musicQueuePanel.hidden) renderMusicQueue();
  const title = result.addedCount === 1 ? result.added[0].title : `${result.addedCount} brani`;
  showToast(`${title} aggiunto${result.addedCount === 1 ? '' : 'i'} in fondo alla coda.`);
  return true;
}

function renderMusicQueue() {
  const snapshot = musicPlayerState?.snapshot();
  const queue = Array.isArray(snapshot?.queue) ? snapshot.queue : [];
  elements.musicQueueTitle.textContent = 'Brani in coda';
  elements.musicQueueClearButton.disabled = queue.length === 0;

  if (!queue.length) {
    const empty = document.createElement('p');
    empty.className = 'music-queue-empty';
    empty.textContent = 'La coda è vuota.';
    elements.musicQueueList.replaceChildren(empty);
    return;
  }

  elements.musicQueueList.replaceChildren(...queue.map((track, index) => {
    const row = document.createElement('div');
    row.className = 'music-queue-item';
    row.classList.toggle('active', Boolean(track.active));
    row.dataset.trackId = track.trackId;
    row.setAttribute('aria-current', track.active ? 'true' : 'false');
    row.draggable = true;

    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'music-queue-drag-handle';
    handle.setAttribute('aria-label', `Trascina ${track.title} per riordinare`);
    handle.title = 'Trascina per riordinare';

    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'music-queue-select';
    const number = document.createElement('span');
    number.className = 'music-queue-number';
    number.textContent = String(index + 1).padStart(2, '0');
    const copy = document.createElement('span');
    copy.className = 'music-queue-copy';
    const title = document.createElement('strong');
    title.textContent = track.title;
    const subtitle = document.createElement('small');
    const artist = track.artists?.map((item) => item.name).filter(Boolean).join(', ');
    subtitle.textContent = [artist, track.albumTitle].filter(Boolean).join(' · ');
    copy.append(title, subtitle);
    select.append(number, copy);
    select.addEventListener('click', () => {
      const result = musicPlayerState.selectTrack(track.trackId);
      if (!result) return;
      playCurrentMusicTrack({ autoplay: true, replay: !result.changed });
      renderMusicQueue();
    });

    const actions = document.createElement('div');
    actions.className = 'music-queue-actions';
    const moveUp = document.createElement('button');
    moveUp.type = 'button';
    moveUp.className = 'music-queue-action music-queue-up';
    moveUp.setAttribute('aria-label', `Sposta ${track.title} in alto`);
    moveUp.title = 'Sposta in alto';
    moveUp.disabled = index === 0;
    moveUp.addEventListener('click', () => moveMusicQueueTrack(track.trackId, index - 1));

    const moveDown = document.createElement('button');
    moveDown.type = 'button';
    moveDown.className = 'music-queue-action music-queue-down';
    moveDown.setAttribute('aria-label', `Sposta ${track.title} in basso`);
    moveDown.title = 'Sposta in basso';
    moveDown.disabled = index === queue.length - 1;
    moveDown.addEventListener('click', () => moveMusicQueueTrack(track.trackId, index + 1));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'music-queue-action music-queue-remove';
    remove.setAttribute('aria-label', `Rimuovi ${track.title} dalla coda`);
    remove.title = 'Rimuovi dalla coda';
    remove.addEventListener('click', () => removeMusicQueueTrack(track.trackId));
    actions.append(moveUp, moveDown, remove);

    row.addEventListener('dragstart', (event) => {
      musicQueueDragTrackId = track.trackId;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', track.trackId);
      requestAnimationFrame(() => row.classList.add('is-dragging'));
    });
    row.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const after = event.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2;
      row.classList.toggle('drop-after', after);
      row.classList.toggle('drop-before', !after);
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
    row.addEventListener('drop', (event) => {
      event.preventDefault();
      const sourceId = musicQueueDragTrackId || event.dataTransfer.getData('text/plain');
      const sourceIndex = queue.findIndex((item) => item.trackId === sourceId);
      let targetIndex = index + (event.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2 ? 1 : 0);
      if (sourceIndex >= 0 && sourceIndex < targetIndex) targetIndex -= 1;
      targetIndex = Math.min(queue.length - 1, Math.max(0, targetIndex));
      row.classList.remove('drop-before', 'drop-after');
      moveMusicQueueTrack(sourceId, targetIndex);
    });
    row.addEventListener('dragend', () => {
      musicQueueDragTrackId = '';
      row.classList.remove('is-dragging', 'drop-before', 'drop-after');
      for (const item of elements.musicQueueList.querySelectorAll('.music-queue-item')) {
        item.classList.remove('drop-before', 'drop-after');
      }
    });

    row.append(handle, select, actions);
    return row;
  }));
}

function syncMusicPlayerUi() {
  const snapshot = musicPlayerState?.snapshot();
  const track = snapshot?.currentTrack;
  const visible = Boolean(track);
  const visibility = musicVisibilityState?.view({ hasTrack: visible, fullOpen: musicFullPlayerOpen }) || {
    showFull: visible && musicFullPlayerOpen,
    showMiniContainer: visible && !musicFullPlayerOpen,
    showRestore: false,
    reserveMiniSpace: visible && !musicFullPlayerOpen,
    collapsed: false,
  };

  elements.musicMiniPlayer.hidden = !visibility.showMiniContainer;
  elements.musicMiniPlayer.classList.toggle('is-collapsed', Boolean(visibility.collapsed));
  elements.musicMiniRestoreButton.hidden = !visibility.showRestore;
  elements.musicFullPlayer.hidden = !visibility.showFull;
  document.body.classList.toggle('has-music-player', Boolean(visibility.reserveMiniSpace));
  document.body.classList.toggle('music-mini-player-collapsed', Boolean(visibility.showRestore));
  document.body.classList.toggle('music-full-player-open', Boolean(visibility.showFull));
  if (!visibility.showMiniContainer || visibility.collapsed) closeMusicMiniVolumePopover();
  if (!visible) return;

  const playing = !elements.musicAudio.paused && !elements.musicAudio.ended;
  for (const button of [elements.musicPlayPauseButton, elements.musicFullPlayPauseButton]) {
    button.classList.toggle('is-playing', playing);
    button.setAttribute('aria-label', playing ? 'Pausa' : 'Riproduci');
  }

  const modeLabel = MUSIC_MODE_LABELS[snapshot.mode] || 'Normale';
  for (const button of [elements.musicModeButton, elements.musicFullModeButton]) {
    button.dataset.mode = snapshot.mode;
    button.setAttribute('aria-label', `Modalità ${modeLabel}`);
    button.title = modeLabel;
  }

  const artist = track.artists?.map((item) => item.name).filter(Boolean).join(', ');
  elements.musicMiniTitle.textContent = track.title;
  elements.musicMiniTitle.title = track.title;
  elements.musicMiniArtist.textContent = artist || 'Artista sconosciuto';
  elements.musicMiniArtist.title = artist || 'Artista sconosciuto';
  elements.musicFullTitle.textContent = track.title;
  elements.musicFullSubtitle.textContent = [track.albumTitle, artist].filter(Boolean).join(' · ');
  elements.musicGoArtistButton.disabled = !track.artists?.[0]?.artistId;
  elements.musicGoAlbumButton.disabled = !track.albumId;
  elements.musicPlayerStatus.textContent = `${playing ? 'In riproduzione' : 'In pausa'}: ${track.title}${artist ? ` — ${artist}` : ''}. Modalità ${modeLabel}.`;
  if (!elements.musicQueuePanel.hidden) renderMusicQueue();
  syncMusicProgress();
  syncMusicVolumeUi();
}

async function playCurrentMusicTrack({ autoplay = true, replay = false } = {}) {
  const track = musicPlayerState?.currentTrack();
  if (!track) return false;

  const needsNewListeningSession = replay || !musicListeningState?.isCurrent(track.trackId);
  if (needsNewListeningSession && musicListeningState?.snapshot()) {
    finishMusicListening('change');
  }

  if (replay && elements.musicAudio.src) {
    if (needsNewListeningSession) startMusicListening(track, 0);
    elements.musicAudio.currentTime = 0;
    musicListeningState?.seek(0);
    if (autoplay && !isMusicPlaybackBlocked()) {
      try {
        if (!elements.musicAudio.paused) musicListeningState?.play(0);
        await elements.musicAudio.play();
      } catch (error) {
        showToast(error?.message || 'Riproduzione non disponibile.');
      }
    }
    syncMusicPlayerUi();
    broadcastMusicState({ immediate: true });
    return true;
  }

  const token = ++musicLoadToken;
  elements.musicAudio.pause();
  elements.musicAudio.removeAttribute('src');
  elements.musicAudio.load();
  if (needsNewListeningSession) startMusicListening(track, 0);
  syncMusicPlayerUi();
  updateMusicCover(track);
  broadcastMusicState({ immediate: true });

  try {
    const signedUrl = await window.BaiaApi.authorizeMediaUrl(track.streamUrl);
    if (token !== musicLoadToken || musicPlayerState.currentTrack()?.trackId !== track.trackId) return false;
    elements.musicAudio.src = signedUrl;
    elements.musicAudio.load();
    if (autoplay && !isMusicPlaybackBlocked()) await elements.musicAudio.play();
    return true;
  } catch (error) {
    if (token === musicLoadToken) showToast(error?.message || 'Impossibile riprodurre il brano.');
    return false;
  } finally {
    if (token === musicLoadToken) {
      syncMusicPlayerUi();
      broadcastMusicState({ immediate: true });
    }
  }
}

function musicPlayQueue(payload = {}) {
  if (!accountNavigation.hasSection(accountState, 'music')) return false;
  if (!musicPlayerState) return false;
  const hadTrackBeforeQueue = Boolean(musicPlayerState.currentTrack());
  const fullPlayerWasOpen = Boolean(musicFullPlayerOpen);
  musicVisibilityState?.setCollapsed(false);
  const track = musicPlayerState.setQueue(payload.tracks, {
    startTrackId: payload.startTrackId,
    queueContext: payload.context,
  });
  if (!track) {
    showToast('La coda non contiene brani riproducibili.');
    return false;
  }
  playCurrentMusicTrack({ autoplay: payload.autoplay !== false });

  // Il player grande si apre automaticamente soltanto al primo brano.
  // Se una sessione audio esiste già, il mini-player si aggiorna senza
  // interrompere la navigazione; un player grande già aperto resta aperto.
  if (fullPlayerWasOpen || (!hadTrackBeforeQueue && payload.openPlayer !== false)) {
    setMusicFullPlayerOpen(true);
  }
  return true;
}

async function musicTogglePlayback() {
  if (!musicPlayerState?.currentTrack() || isMusicPlaybackBlocked()) return;
  if (elements.musicAudio.paused || elements.musicAudio.ended) {
    if (!elements.musicAudio.src) await playCurrentMusicTrack({ autoplay: true });
    else {
      if (elements.musicAudio.ended) elements.musicAudio.currentTime = 0;
      try { await elements.musicAudio.play(); } catch (error) { showToast(error?.message || 'Riproduzione non disponibile.'); }
    }
  } else {
    elements.musicAudio.pause();
  }
}

function restartCurrentMusicTrack() {
  const track = musicPlayerState?.currentTrack();
  if (!track) return;
  const wasPlaying = !elements.musicAudio.paused && !elements.musicAudio.ended;
  finishMusicListening('change');
  startMusicListening(track, 0);
  elements.musicAudio.currentTime = 0;
  musicListeningState?.seek(0);
  if (wasPlaying) musicListeningState?.play(0);
  syncMusicProgress();
  broadcastMusicState({ immediate: true });
}

function musicPrevious() {
  if (!musicPlayerState?.currentTrack()) return;
  if (elements.musicAudio.currentTime > 3) {
    restartCurrentMusicTrack();
    return;
  }
  const result = musicPlayerState.previous();
  if (!result) return;
  if (result.changed) playCurrentMusicTrack({ autoplay: !elements.musicAudio.paused });
  else restartCurrentMusicTrack();
}

function musicNext({ automatic = false } = {}) {
  if (!musicPlayerState?.currentTrack()) return;
  const wasPlaying = !elements.musicAudio.paused || automatic;
  const result = musicPlayerState.next({ automatic });
  if (!result) {
    elements.musicAudio.pause();
    syncMusicPlayerUi();
    broadcastMusicState({ immediate: true });
    return;
  }
  playCurrentMusicTrack({ autoplay: wasPlaying, replay: result.replay });
}

function musicCycleMode() {
  if (!musicPlayerState?.currentTrack()) return null;
  const mode = musicPlayerState.cycleMode();
  syncMusicPlayerUi();
  broadcastMusicState({ immediate: true });
  return mode;
}

function navigateMusicDetail(kind, id) {
  if (!accountNavigation.hasSection(accountState, 'music')) return false;
  const targetId = String(id || '').trim();
  if (!targetId || !['album', 'artist'].includes(kind)) return false;
  setMusicFullPlayerOpen(false);
  openPage('music');
  const frame = frames.get('music');
  const send = () => frame?.contentWindow?.postMessage({
    type: 'shell-music-navigate',
    target: kind,
    id: targetId,
  }, window.location.origin);
  if (frame?.contentDocument?.readyState === 'complete') requestAnimationFrame(send);
  else frame?.addEventListener('load', send, { once: true });
  return true;
}

function musicOpenQueue() {
  if (!musicPlayerState?.snapshot()?.queueLength) return false;
  closeMusicFullMenu();
  renderMusicQueue();
  elements.musicQueuePanel.hidden = false;
  requestAnimationFrame(() => elements.musicQueueCloseButton.focus());
  return true;
}

function musicCommand(command, payload = {}) {
  if (!accountNavigation.hasSection(accountState, 'music')) return false;
  switch (command) {
    case 'play-pause': musicTogglePlayback(); return true;
    case 'previous': musicPrevious(); return true;
    case 'next': musicNext(); return true;
    case 'cycle-mode': musicCycleMode(); return true;
    case 'open-player': return setMusicFullPlayerOpen(true);
    case 'close-player': setMusicFullPlayerOpen(false); return true;
    case 'show-queue': return musicOpenQueue();
    case 'append-tracks': return appendMusicQueue(payload);
    case 'select-track': {
      const result = musicPlayerState?.selectTrack(payload.trackId);
      if (!result) return false;
      playCurrentMusicTrack({ autoplay: payload.autoplay !== false, replay: !result.changed });
      return true;
    }
    case 'seek': {
      const value = Number(payload.seconds);
      if (Number.isFinite(value) && value >= 0 && Number.isFinite(elements.musicAudio.duration)) {
        elements.musicAudio.currentTime = Math.min(value, elements.musicAudio.duration);
        musicListeningState?.seek(elements.musicAudio.currentTime);
        syncMusicProgress();
        broadcastMusicState({ immediate: true });
      }
      return true;
    }
    default: return false;
  }
}

function sendMusicStateTo(source) {
  source?.postMessage({ type: 'shell-music-state', state: currentMusicSnapshot() }, window.location.origin);
}

function saveGroups() {
  try { localStorage.setItem(STORAGE_GROUPS, JSON.stringify([...openGroups])); } catch {}
}

function registerPages(items) {
  for (const item of items) {
    if (item.type === 'group') registerPages(item.pages);
    else pageById.set(item.id, item);
  }
}
registerPages(menuDefinition);
registerPages(quickDefinition);
registerPages(hiddenPages);

function makeIcon(src) {
  const icon = document.createElement('span');
  icon.className = 'ui-icon menu-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.style.setProperty('--icon-url', `url("${src}")`);
  return icon;
}

function makePageButton(page) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'menu-button';
  button.dataset.pageId = page.id;
  if (page.icon) button.appendChild(makeIcon(page.icon));
  const label = document.createElement('span');
  label.className = 'menu-label';
  label.textContent = page.label;
  button.appendChild(label);
  button.addEventListener('click', () => openPage(page.id));
  return button;
}

function canAccessPage(page, options = {}) {
  return accountNavigation.canAccessPage(page, accountState, options);
}

function accessDeniedMessage(page) {
  if (page?.capability) return 'Questa sezione è riservata agli amministratori.';
  if (page?.section) return `Il tuo account non può accedere alla sezione ${page.label}.`;
  return 'Il tuo account non può aprire questa pagina.';
}

function renderMenu() {
  const visibleMenu = accountNavigation.filterNavigation(menuDefinition, accountState);
  const visibleQuickLinks = accountNavigation.filterNavigation(quickDefinition, accountState);

  elements.mainMenu.replaceChildren();
  for (const item of visibleMenu) {
    if (item.type === 'page') {
      elements.mainMenu.appendChild(makePageButton(item));
      continue;
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'menu-group';
    wrapper.dataset.groupId = item.id;
    wrapper.classList.toggle('open', openGroups.has(item.id));

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'menu-button';
    toggle.dataset.groupToggle = item.id;
    toggle.appendChild(makeIcon(item.icon));
    const label = document.createElement('span');
    label.className = 'menu-label';
    label.textContent = item.label;
    toggle.appendChild(label);
    const arrow = document.createElement('span');
    arrow.className = 'ui-icon menu-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.style.setProperty('--icon-url', 'url("/icons/chevron-down.svg")');
    toggle.appendChild(arrow);
    toggle.addEventListener('click', () => {
      if (openGroups.has(item.id)) openGroups.delete(item.id);
      else openGroups.add(item.id);
      wrapper.classList.toggle('open', openGroups.has(item.id));
      saveGroups();
    });

    const children = document.createElement('div');
    children.className = 'menu-group-items';
    for (const page of item.pages) children.appendChild(makePageButton(page));

    wrapper.append(toggle, children);
    elements.mainMenu.appendChild(wrapper);
  }

  elements.quickLinks.replaceChildren(...visibleQuickLinks.map(makePageButton));
  if (currentPageId) setActiveState(currentPageId);
}

function frameFor(page) {
  if (frames.has(page.id)) return frames.get(page.id);
  const frame = document.createElement('iframe');
  frame.className = 'page-frame';
  frame.title = page.label;
  frame.src = page.src;
  frame.dataset.pageId = page.id;
  frame.setAttribute('loading', 'eager');
  frame.allowFullscreen = true;
  frame.setAttribute('allowfullscreen', '');
  frame.setAttribute('allow', 'fullscreen');
  bindMusicMiniVolumeDismissalToFrame(frame);
  elements.contentArea.appendChild(frame);
  frames.set(page.id, frame);
  return frame;
}

function clearPageFrames() {
  for (const frame of frames.values()) frame.remove();
  frames.clear();
  currentPageId = '';
  document.body.classList.remove('immersive-page');
  elements.loadingState.hidden = false;
}

function removeUnauthorizedFrames() {
  let removedCurrentPage = false;
  for (const [pageId, frame] of frames) {
    const page = pageById.get(pageId);
    if (canAccessPage(page)) continue;
    frame.remove();
    frames.delete(pageId);
    if (currentPageId === pageId) {
      currentPageId = '';
      removedCurrentPage = true;
    }
  }
  if (removedCurrentPage) {
    document.body.classList.remove('immersive-page');
    elements.loadingState.hidden = false;
  }
  return removedCurrentPage;
}

function resetMusicForAccountChange() {
  try { elements.musicAudio.pause(); } catch {}
  elements.musicAudio.removeAttribute('src');
  elements.musicAudio.load();
  musicPlayerState?.clearQueue();
  musicListeningState?.clear?.();
  musicListeningQualifiedSessionId = '';
  musicListeningQualificationPendingSessionId = '';
  setMusicFullPlayerOpen(false);
  closeMusicQueue();
  revokeMusicCover();
  syncMusicPlayerUi();
  broadcastMusicState({ immediate: true });
}

function setActiveState(pageId) {
  document.querySelectorAll('[data-page-id]').forEach((button) => {
    button.classList.toggle('active', button.dataset.pageId === pageId);
  });

  for (const group of menuDefinition.filter((item) => item.type === 'group')) {
    const contains = group.pages.some((page) => page.id === pageId);
    if (contains) {
      openGroups.add(group.id);
      const wrapper = document.querySelector(`[data-group-id="${group.id}"]`);
      wrapper?.classList.add('open');
    }
  }
  saveGroups();
}

function openPage(pageId, { allowUnauthenticated = false, silent = false } = {}) {
  const page = pageById.get(pageId);
  if (!page) return false;
  if (!canAccessPage(page, { allowUnauthenticated })) {
    if (!silent && accountState?.authenticated) showToast(accessDeniedMessage(page));
    return false;
  }
  document.body.classList.remove('immersive-page');
  const previousFrame = frames.get(currentPageId);
  if (previousFrame && previousFrame.contentWindow) {
    previousFrame.contentWindow.postMessage({ type: 'shell-page-visibility', active: false }, window.location.origin);
  }
  const frame = frameFor(page);
  elements.loadingState.hidden = true;
  document.querySelectorAll('.page-frame').forEach((item) => {
    item.classList.toggle('active', item === frame);
  });
  currentPageId = pageId;
  applyMusicPagePolicy(pageId);
  const notifyActive = () => frame.contentWindow?.postMessage({ type: 'shell-page-visibility', active: true }, window.location.origin);
  if (frame.contentDocument?.readyState === 'complete') notifyActive();
  else frame.addEventListener('load', notifyActive, { once: true });
  setActiveState(pageId);
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  if (accountState?.authenticated) {
    try { sessionStorage.setItem(STORAGE_PAGE, pageId); } catch {}
  }
  elements.userMenu.hidden = true;
  elements.profileMenuButton.setAttribute('aria-expanded', 'false');

  if (usesTouchLayout() || window.matchMedia('(max-width: 720px)').matches) setSidebarOpen(false);
  return true;
}

function showToast(message) {
  if (!message) return;
  elements.shellToast.textContent = String(message);
  elements.shellToast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.shellToast.classList.remove('visible'), 2700);
}

function accountFailureMessage(code, fallback = '') {
  const messages = {
    ACCOUNT_REQUIRED: 'Accedi con il tuo account Baia per continuare.',
    ACCOUNT_SESSION_EXPIRED: 'La sessione dell’account è scaduta. Accedi di nuovo.',
    ACCOUNT_DISABLED: 'Questo account è stato disabilitato.',
    ACCOUNT_DELETED: 'Questo account non è più disponibile.',
    DEVICE_UNKNOWN: 'Questo dispositivo non è ancora associato al server Baia.',
    DEVICE_REVOKED: 'Questo dispositivo è stato revocato. È necessaria una nuova associazione.',
    AUTH_REQUIRED: 'Il server richiede un dispositivo Baia verificato.',
  };
  return messages[code] || fallback || 'Non è stato possibile verificare l’accesso.';
}

function accountAccessFailureMessage(detail = {}) {
  if (detail.message) return detail.message;
  if (detail.code === 'PASSWORD_CHANGE_REQUIRED') return 'Imposta una nuova password dalla pagina Profilo per continuare.';
  if (detail.code === 'ADMIN_REQUIRED') return 'Questa sezione è riservata agli amministratori.';
  return 'Il tuo account non può accedere a questa sezione.';
}

async function handleAccountAccessDenied(detail = {}) {
  showToast(accountAccessFailureMessage(detail));
  await refreshAccountState({ loading: false });
}

async function requestAccountJson(path, options = {}) {
  await window.BaiaApi?.ready;
  const response = await (window.BaiaApi.fetchApiJson || window.BaiaApi.fetchApi)(path, {
    ...options,
    headers: {
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.error || `Errore HTTP ${response.status}`);
    error.code = payload?.code || '';
    error.status = response.status;
    error.retryAfter = response.headers.get('Retry-After') || '';
    throw error;
  }
  return payload;
}

function setAuthGateMode(mode, { message = '', code = '' } = {}) {
  const loading = mode === 'loading';
  const login = mode === 'login';
  elements.authGate.hidden = false;
  elements.authLoading.hidden = !loading;
  elements.loginForm.hidden = !login;
  elements.authActions.hidden = loading || login;
  elements.authSetupButton.hidden = !window.BaiaApi?.isTauri?.();
  elements.authRetryButton.hidden = false;
  elements.authMessage.textContent = message;
  elements.authMessage.dataset.code = code;
  document.body.classList.remove('auth-pending', 'auth-setup');
  document.body.classList.add('auth-locked');

  if (loading) {
    elements.authTitle.textContent = 'Accesso account';
    elements.authDescription.textContent = 'Verifica del dispositivo e dell’account in corso…';
  } else if (login) {
    elements.authTitle.textContent = 'Accedi a Baia';
    elements.authDescription.textContent = 'Il dispositivo è verificato. Inserisci le credenziali del tuo account.';
    requestAnimationFrame(() => elements.loginUsername.focus({ preventScroll: true }));
  } else {
    elements.authTitle.textContent = code === 'DEVICE_REVOKED'
      ? 'Dispositivo revocato'
      : (code === 'CONNECTION_ERROR' ? 'Server non raggiungibile' : 'Dispositivo da configurare');
    elements.authDescription.textContent = code === 'CONNECTION_ERROR'
      ? 'Controlla che il server Baia sia acceso e che l’indirizzo configurato sia corretto.'
      : 'L’identità del dispositivo resta separata dall’account personale.';
  }
}

function renderAccountIdentity(state) {
  const account = state?.account;
  const username = account?.username || 'Account';
  elements.profileName.textContent = username;
  elements.profileAvatar.textContent = username.trim().charAt(0).toUpperCase() || 'A';
  elements.profileButton.disabled = !state?.authenticated;
  elements.profileMenuButton.disabled = !state?.authenticated;
  elements.logoutAccount.hidden = Boolean(state?.localAccess);
}

function broadcastAccountState() {
  const message = { type: 'shell-account-state', state: accountState };
  for (const frame of frames.values()) frame.contentWindow?.postMessage(message, window.location.origin);
}

function initialAuthenticatedPage() {
  if (accountState?.account?.mustChangePassword) return 'profile';
  try {
    const saved = sessionStorage.getItem(STORAGE_PAGE);
    const savedPage = pageById.get(saved);
    if (savedPage && canAccessPage(savedPage)) return saved;
  } catch {}
  return accountNavigation.firstAccessiblePage(menuDefinition, accountState, pageById.get('profile'))?.id || 'profile';
}

function enterAuthenticatedState(state, { showWelcome = false } = {}) {
  const previousState = accountState;
  const wasAuthenticated = Boolean(previousState?.authenticated);
  const accountChanged = Boolean(
    wasAuthenticated
      && previousState?.account?.id
      && state?.account?.id
      && previousState.account.id !== state.account.id,
  );
  const hadMusicAccess = accountNavigation.hasSection(previousState, 'music');

  accountState = state;
  elements.authGate.hidden = true;
  elements.loginForm.reset();
  document.body.classList.remove('auth-pending', 'auth-locked', 'auth-setup');
  renderAccountIdentity(state);
  renderMenu();

  if (accountChanged) {
    resetMusicForAccountChange();
    clearPageFrames();
  } else {
    removeUnauthorizedFrames();
    if (hadMusicAccess && !accountNavigation.hasSection(state, 'music')) resetMusicForAccountChange();
  }

  const currentPage = pageById.get(currentPageId);
  const mustOpenInitial = !wasAuthenticated
    || !currentPage
    || !canAccessPage(currentPage)
    || currentPageId === 'profile' && state.account?.mustChangePassword;

  if (mustOpenInitial) openPage(initialAuthenticatedPage(), { silent: true });
  else broadcastAccountState();

  if (showWelcome) showToast(`Accesso effettuato come ${state.account.username}.`);
  if (state.account?.mustChangePassword) showToast('Imposta una password personale dalla pagina Profilo.');
}

function enterSignedOutState({ code = 'ACCOUNT_REQUIRED', message = '' } = {}) {
  accountState = { authenticated: false, account: null, sections: [], capabilities: {}, reasonCode: code };
  renderMenu();
  resetDrawerState();
  resetMusicForAccountChange();
  clearPageFrames();
  elements.profileName.textContent = 'Accesso';
  elements.profileAvatar.textContent = 'A';
  elements.profileButton.disabled = true;
  elements.profileMenuButton.disabled = true;
  elements.userMenu.hidden = true;
  setAuthGateMode('login', {
    code,
    message: code === 'ACCOUNT_REQUIRED' ? '' : accountFailureMessage(code, message),
  });
}

function enterDeviceSetupState({ code = '', message = '' } = {}) {
  accountState = { authenticated: false, account: null, sections: [], capabilities: {}, reasonCode: code };
  renderMenu();
  resetDrawerState();
  resetMusicForAccountChange();
  clearPageFrames();
  elements.profileName.textContent = 'Configura';
  elements.profileAvatar.textContent = 'C';
  elements.profileButton.disabled = true;
  elements.profileMenuButton.disabled = true;
  setAuthGateMode('device', { code, message: accountFailureMessage(code, message) });
}

async function refreshAccountState({ loading = true } = {}) {
  if (accountRefreshPromise) return accountRefreshPromise;
  accountRefreshPromise = (async () => {
    if (loading) setAuthGateMode('loading');
    try {
      const state = await requestAccountJson('/api/auth/me');
      if (state?.authenticated) {
        enterAuthenticatedState(state);
        return state;
      }
      enterSignedOutState({ code: state?.reasonCode || 'ACCOUNT_REQUIRED' });
      return state;
    } catch (error) {
      if (['DEVICE_UNKNOWN', 'DEVICE_REVOKED', 'AUTH_REQUIRED'].includes(error.code)) {
        enterDeviceSetupState({ code: error.code, message: error.message });
      } else {
        enterDeviceSetupState({ code: error.code || 'CONNECTION_ERROR', message: error.message });
      }
      return null;
    } finally {
      accountRefreshPromise = null;
    }
  })();
  return accountRefreshPromise;
}

function openAccountSetup() {
  elements.authGate.hidden = true;
  document.body.classList.remove('auth-pending', 'auth-locked');
  document.body.classList.add('auth-setup');
  clearPageFrames();
  openPage('profile', { allowUnauthenticated: true });
}

async function loginAccount(event) {
  event.preventDefault();
  const username = elements.loginUsername.value.trim();
  const password = elements.loginPassword.value;
  if (!username || !password) {
    elements.loginForm.reportValidity();
    return;
  }

  elements.loginSubmit.disabled = true;
  elements.authMessage.textContent = '';
  try {
    const state = await requestAccountJson('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    enterAuthenticatedState(state, { showWelcome: true });
  } catch (error) {
    if (['DEVICE_UNKNOWN', 'DEVICE_REVOKED', 'AUTH_REQUIRED'].includes(error.code)) {
      enterDeviceSetupState({ code: error.code, message: error.message });
      return;
    }
    elements.loginPassword.value = '';
    elements.authMessage.textContent = error.code === 'LOGIN_RATE_LIMITED' && error.retryAfter
      ? `${error.message} Attendi circa ${error.retryAfter} secondi.`
      : error.message;
    elements.loginPassword.focus();
  } finally {
    elements.loginSubmit.disabled = false;
  }
}

async function logoutAccount() {
  if (!accountState?.authenticated || accountState.localAccess) return;
  elements.logoutAccount.disabled = true;
  try {
    await requestAccountJson('/api/auth/logout', { method: 'POST' });
    enterSignedOutState();
  } catch (error) {
    showToast(error.message);
  } finally {
    elements.logoutAccount.disabled = false;
  }
}

async function loadAppInfo() {
  try {
    await window.BaiaApi?.ready;
    const target = window.BaiaApi?.url('/api/app-info') || '/api/app-info';
    const jsonRequest = window.BaiaApi?.fetchApiJson || window.BaiaApi?.fetchApi;
    const response = jsonRequest
      ? await jsonRequest(target)
      : await fetch(target);
    if (!response.ok) throw new Error('Dati applicazione non disponibili');
    const payload = await response.json();
    const info = payload.app || null;
    elements.versionLabel.textContent = `${info?.name || 'Baia Cinghiala'} v. ${info?.uiVersion || '2.0'}`;
    document.title = info?.name || 'Baia Cinghiala';
    return info;
  } catch {
    return null;
  }
}

async function bootstrapShell() {
  setAuthGateMode('loading');
  await loadAppInfo();
  await refreshAccountState({ loading: false });
}

function toggleSidebar(event) {
  event?.preventDefault();
  event?.stopPropagation();
  setSidebarOpen(!elements.sidebar.classList.contains('is-open'));
}

function seekMusicFromControl(control) {
  const value = Number(control.value);
  if (Number.isFinite(value) && Number.isFinite(elements.musicAudio.duration)) {
    elements.musicAudio.currentTime = Math.min(Math.max(0, value), elements.musicAudio.duration);
    musicListeningState?.seek(elements.musicAudio.currentTime);
    syncMusicProgress();
  }
}

bindTransientMusicSliderThumb(elements.musicFullProgress);
bindTransientMusicSliderThumb(elements.musicMiniProgress);
bindTransientMusicSliderThumb(elements.musicFullVolume);
bindTransientMusicSliderThumb(elements.musicMiniVolume);

elements.musicMiniCollapseButton.addEventListener('click', () => setMusicMiniCollapsed(true));
elements.musicMiniRestoreButton.addEventListener('click', () => setMusicMiniCollapsed(false));
elements.musicMiniCover.addEventListener('click', () => setMusicFullPlayerOpen(true));
elements.musicFullBackButton.addEventListener('click', () => setMusicFullPlayerOpen(false));
elements.musicFullMenuButton.addEventListener('click', (event) => {
  event.stopPropagation();
  const open = elements.musicFullMenu.hidden;
  closeMusicFullMenu();
  elements.musicFullMenu.hidden = !open;
  elements.musicFullMenuButton.setAttribute('aria-expanded', String(open));
});
elements.musicGoArtistButton.addEventListener('click', () => {
  const artistId = musicPlayerState?.currentTrack()?.artists?.[0]?.artistId;
  if (artistId) navigateMusicDetail('artist', artistId);
});
elements.musicGoAlbumButton.addEventListener('click', () => {
  const albumId = musicPlayerState?.currentTrack()?.albumId;
  if (albumId) navigateMusicDetail('album', albumId);
});
elements.musicShowQueueButton.addEventListener('click', musicOpenQueue);
elements.musicQueueClearButton.addEventListener('click', clearMusicQueue);
elements.musicQueueCloseButton.addEventListener('click', closeMusicQueue);
elements.musicFullPreviousButton.addEventListener('click', musicPrevious);
elements.musicFullPlayPauseButton.addEventListener('click', musicTogglePlayback);
elements.musicFullNextButton.addEventListener('click', () => musicNext());
elements.musicFullModeButton.addEventListener('click', musicCycleMode);
elements.musicFullVolumeButton.addEventListener('click', toggleMusicMute);
elements.musicFullVolume.addEventListener('input', () => setMusicVolume(elements.musicFullVolume.value));
elements.musicFullProgress.addEventListener('input', () => seekMusicFromControl(elements.musicFullProgress));
elements.musicFullProgress.addEventListener('change', () => broadcastMusicState({ immediate: true }));

elements.musicPreviousButton.addEventListener('click', musicPrevious);
elements.musicPlayPauseButton.addEventListener('click', musicTogglePlayback);
elements.musicNextButton.addEventListener('click', () => musicNext());
elements.musicModeButton.addEventListener('click', musicCycleMode);
elements.musicMiniVolumeButton.addEventListener('click', toggleMusicMute);
elements.musicMiniVolume.addEventListener('input', () => setMusicVolume(elements.musicMiniVolume.value));
elements.musicMiniProgress.addEventListener('input', () => seekMusicFromControl(elements.musicMiniProgress));
elements.musicMiniProgress.addEventListener('change', () => broadcastMusicState({ immediate: true }));
elements.musicAudio.addEventListener('volumechange', syncMusicVolumeUi);
elements.musicAudio.addEventListener('play', () => {
  const track = musicPlayerState?.currentTrack();
  ensureMusicListening(track);
  musicListeningState?.play(elements.musicAudio.currentTime);
  syncMusicPlayerUi();
  broadcastMusicState({ immediate: true });
});
elements.musicAudio.addEventListener('pause', () => {
  if (!elements.musicAudio.ended && musicListeningState?.snapshot()) {
    musicListeningState.pause(elements.musicAudio.currentTime);
    reportMusicListening('pause');
  }
  syncMusicPlayerUi();
  broadcastMusicState({ immediate: true });
});
elements.musicAudio.addEventListener('timeupdate', () => {
  musicListeningState?.sample(elements.musicAudio.currentTime);
  maybeReportMusicQualification();
  syncMusicProgress();
  broadcastMusicState();
});
elements.musicAudio.addEventListener('seeking', () => {
  musicListeningState?.seek(elements.musicAudio.currentTime);
});
elements.musicAudio.addEventListener('seeked', () => {
  musicListeningState?.seek(elements.musicAudio.currentTime);
  reportMusicListening('checkpoint');
});
elements.musicAudio.addEventListener('durationchange', syncMusicProgress);
elements.musicAudio.addEventListener('loadedmetadata', syncMusicProgress);
elements.musicAudio.addEventListener('ended', () => {
  musicListeningState?.pause(elements.musicAudio.currentTime);
  reportMusicListening('ended', { final: true });
  musicNext({ automatic: true });
});
elements.musicAudio.addEventListener('error', () => {
  if (musicPlayerState?.currentTrack() && elements.musicAudio.currentSrc) {
    showToast('Impossibile riprodurre il file audio.');
  }
  syncMusicPlayerUi();
  broadcastMusicState({ immediate: true });
});

elements.sidebarTab.addEventListener('click', toggleSidebar);
elements.sidebarBackdrop?.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  setSidebarOpen(false);
});
elements.profileButton.addEventListener('click', () => openPage('profile'));
elements.loginForm.addEventListener('submit', loginAccount);
elements.logoutAccount.addEventListener('click', logoutAccount);
elements.authRetryButton.addEventListener('click', () => refreshAccountState());
elements.authSetupButton.addEventListener('click', openAccountSetup);
elements.profileMenuButton.addEventListener('click', (event) => {
  event.stopPropagation();
  elements.userMenu.hidden = !elements.userMenu.hidden;
  elements.profileMenuButton.setAttribute('aria-expanded', String(!elements.userMenu.hidden));
});
elements.userMenu.addEventListener('click', (event) => {
  const target = event.target.closest('[data-open-page]');
  if (target) openPage(target.dataset.openPage);
});
elements.reloadCurrentPage.addEventListener('click', () => {
  const frame = frames.get(currentPageId);
  if (frame) frame.contentWindow.location.reload();
  elements.userMenu.hidden = true;
});
document.addEventListener('pointerdown', dismissMusicMiniVolumeFromShellPointer, true);
document.addEventListener('click', (event) => {
  if (!event.target.closest('.sidebar-footer')) {
    elements.userMenu.hidden = true;
    elements.profileMenuButton.setAttribute('aria-expanded', 'false');
  }
  if (!event.target.closest('.music-full-menu-wrap')) closeMusicFullMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (!elements.musicFullMenu.hidden) {
      closeMusicFullMenu();
      elements.musicFullMenuButton.focus();
      return;
    }
    if (!elements.musicQueuePanel.hidden) {
      closeMusicQueue();
      elements.musicFullMenuButton.focus();
      return;
    }
    if (musicFullPlayerOpen) {
      setMusicFullPlayerOpen(false);
      return;
    }
    setSidebarOpen(false);
    elements.userMenu.hidden = true;
  }
});
window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin) return;
  const data = event.data || {};
  if (data.type === 'shell-toast') showToast(data.message);
  if (data.type === 'shell-account-auth-required') {
    enterSignedOutState({ code: data.code, message: data.message });
    return;
  }
  if (data.type === 'shell-account-access-denied') {
    void handleAccountAccessDenied(data);
    return;
  }
  if (data.type === 'shell-account-refresh') {
    refreshAccountState({ loading: false });
    return;
  }
  if (data.type === 'shell-account-signed-out') {
    enterSignedOutState();
    return;
  }
  if (data.type === 'shell-show-account-gate') {
    refreshAccountState();
    return;
  }
  if (data.type === 'shell-navigate' && pageById.has(data.pageId)) openPage(data.pageId);
  if (data.type === 'shell-immersive') {
    document.body.classList.toggle('immersive-page', Boolean(data.active));
    if (data.active) setSidebarOpen(false);
  }
  if (data.type === 'shell-music-play-queue') musicPlayQueue(data.payload);
  if (data.type === 'shell-music-command') musicCommand(data.command, data.payload);
  if (data.type === 'shell-music-state-request') sendMusicStateTo(event.source);
  if (data.type === 'shell-metadata-updated') {
    for (const frame of frames.values()) {
      frame.contentWindow?.postMessage({
        type: 'library-metadata-updated',
        itemId: data.itemId,
      }, window.location.origin);
    }
  }
});
window.addEventListener('baia-account-auth-required', (event) => {
  const detail = event.detail || {};
  enterSignedOutState({ code: detail.code, message: detail.message });
});
window.addEventListener('baia-account-access-denied', (event) => {
  void handleAccountAccessDenied(event.detail || {});
});

if (new URLSearchParams(window.location.search).get('sidebar') === 'open') {
  document.body.classList.add('force-sidebar-open');
}

window.addEventListener('resize', syncShellViewport, { passive: true });
window.addEventListener('orientationchange', () => {
  setSidebarOpen(false);
  requestAnimationFrame(syncShellViewport);
});
window.visualViewport?.addEventListener('resize', syncShellViewport, { passive: true });
window.visualViewport?.addEventListener('scroll', syncShellViewport, { passive: true });
touchLayoutMedia.addEventListener?.('change', syncTouchShell);
window.addEventListener('pageshow', () => {
  resetDrawerState();
  syncShellViewport();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !elements.sidebar.classList.contains('is-open')) syncBackdrop(false);
});

window.setInterval(() => {
  const snapshot = musicListeningState?.snapshot();
  if (!snapshot || elements.musicAudio.paused || elements.musicAudio.ended) return;
  musicListeningState.sample(elements.musicAudio.currentTime);
  reportMusicListening('checkpoint');
}, 15000);

// Stato iniziale fail-safe: nessun overlay può restare attivo durante il caricamento o il ripristino da cache.
resetDrawerState();
syncTouchShell();

renderMenu();
void bootstrapShell();

window.addEventListener('pagehide', () => {
  reportMusicListening('change', { final: true, keepalive: true });
  revokeMusicCover();
}, { once: true });

window.BaiaShell = Object.freeze({
  openPage,
  showToast,
  refreshAccount: refreshAccountState,
  musicPlayQueue,
  musicCommand,
  musicState: currentMusicSnapshot,
});
