document.documentElement.classList.toggle('baia-shell-embedded', window.parent !== window);
function shellToast(message) {
  if (window.parent !== window) {
    window.parent.postMessage({ type: 'shell-toast', message }, window.location.origin);
    return;
  }
  console.log(message);
}
function shellNavigate(pageId) {
  if (window.parent !== window) {
    window.parent.postMessage({ type: 'shell-navigate', pageId }, window.location.origin);
  }
}
function shellImmersive(active) {
  if (window.parent !== window) {
    window.parent.postMessage({ type: 'shell-immersive', active: Boolean(active) }, window.location.origin);
  }
}
function shellContextBack(active, label = 'Indietro') {
  if (window.parent !== window) {
    window.parent.postMessage({
      type: 'shell-context-back',
      active: Boolean(active),
      label: String(label || 'Indietro'),
    }, window.location.origin);
  }
}
function shellMusicPlayQueue(tracks, startTrackId, context = null) {
  const payload = { tracks, startTrackId, context };
  if (window.parent === window) return false;
  try {
    if (window.parent.BaiaShell?.musicPlayQueue) return window.parent.BaiaShell.musicPlayQueue(payload);
  } catch {}
  window.parent.postMessage({ type: 'shell-music-play-queue', payload }, window.location.origin);
  return true;
}
function shellMusicAddToQueue(tracks) {
  return shellMusicCommand('append-tracks', { tracks: Array.isArray(tracks) ? tracks : [] });
}
function shellMusicCommand(command, payload = null) {
  if (window.parent === window) return false;
  try {
    if (window.parent.BaiaShell?.musicCommand) return window.parent.BaiaShell.musicCommand(command, payload || {});
  } catch {}
  window.parent.postMessage({ type: 'shell-music-command', command, payload }, window.location.origin);
  return true;
}
function shellMusicRequestState() {
  if (window.parent === window) return null;
  try {
    if (window.parent.BaiaShell?.musicState) return window.parent.BaiaShell.musicState();
  } catch {}
  window.parent.postMessage({ type: 'shell-music-state-request' }, window.location.origin);
  return null;
}
function shellAccountRefresh() {
  if (window.parent !== window) {
    window.parent.postMessage({ type: 'shell-account-refresh' }, window.location.origin);
  }
}
function shellAccountSignedOut() {
  if (window.parent !== window) {
    window.parent.postMessage({ type: 'shell-account-signed-out' }, window.location.origin);
  }
}
function shellShowAccountGate() {
  if (window.parent !== window) {
    window.parent.postMessage({ type: 'shell-show-account-gate' }, window.location.origin);
  }
}
function reportAccountFailure(payload, status) {
  const authCodes = new Set(['ACCOUNT_REQUIRED', 'ACCOUNT_SESSION_EXPIRED', 'ACCOUNT_DISABLED', 'ACCOUNT_DELETED']);
  const accessCodes = new Set(['SECTION_ACCESS_DENIED', 'ADMIN_REQUIRED', 'PASSWORD_CHANGE_REQUIRED']);
  if (![401, 403].includes(Number(status))) return false;

  let message = null;
  let eventName = '';
  if (authCodes.has(payload?.code)) {
    message = {
      type: 'shell-account-auth-required',
      code: payload.code,
      message: payload.error || '',
    };
    eventName = 'baia-account-auth-required';
  } else if (accessCodes.has(payload?.code)) {
    message = {
      type: 'shell-account-access-denied',
      code: payload.code,
      section: payload.section || '',
      message: payload.error || '',
    };
    eventName = 'baia-account-access-denied';
  }
  if (!message) return false;
  if (window.parent !== window) window.parent.postMessage(message, window.location.origin);
  else window.dispatchEvent(new CustomEvent(eventName, { detail: message }));
  return true;
}

const reportAccountAuthFailure = reportAccountFailure;
function apiUrl(url) {
  return window.BaiaApi?.url(url) || url;
}
async function mediaUrl(url) {
  if (window.BaiaApi?.authorizeMediaUrl) return window.BaiaApi.authorizeMediaUrl(url);
  return apiUrl(url);
}
function setMediaSrc(element, url) {
  const requestToken = Symbol('baia-media-src');
  element.__baiaMediaRequest = requestToken;
  mediaUrl(url).then((resolved) => {
    if (element.__baiaMediaRequest === requestToken) element.src = resolved;
  }).catch((error) => {
    console.error(error);
    if (element.__baiaMediaRequest === requestToken) element.removeAttribute('src');
  });
}
async function apiFetch(url, options = {}) {
  await window.BaiaApi?.ready;
  const request = window.BaiaApi?.fetchApi || fetch;
  return request(apiUrl(url), options);
}
function nativeUploadAvailable() {
  return Boolean(window.BaiaApi?.nativeUploadsAvailable?.());
}
async function pickNativeUploadFiles(role, category = null) {
  if (!window.BaiaApi?.pickUploadFiles) throw new Error('Selettore upload nativo non disponibile.');
  return window.BaiaApi.pickUploadFiles(role, category);
}
async function releaseNativeUploadFiles(tokens) {
  return window.BaiaApi?.releaseUploadFiles?.(tokens);
}
async function nativeUpload(request, onProgress = null) {
  if (!window.BaiaApi?.uploadFilesNative) throw new Error('Trasporto upload nativo non disponibile.');
  return window.BaiaApi.uploadFilesNative(request, onProgress);
}
async function apiRequest(url, options = {}) {
  await window.BaiaApi?.ready;
  const request = window.BaiaApi?.fetchApiJson || window.BaiaApi?.fetchApi || fetch;
  const response = await request(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
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
window.BaiaPage = {
  shellToast,
  shellNavigate,
  shellImmersive,
  shellContextBack,
  shellMusicPlayQueue,
  shellMusicAddToQueue,
  shellMusicCommand,
  shellMusicRequestState,
  shellAccountRefresh,
  shellAccountSignedOut,
  shellShowAccountGate,
  reportAccountFailure,
  reportAccountAuthFailure,
  apiUrl,
  mediaUrl,
  setMediaSrc,
  apiFetch,
  apiRequest,
  nativeUploadAvailable,
  pickNativeUploadFiles,
  releaseNativeUploadFiles,
  nativeUpload,
};


/* Rail controls: altezza reale della copertina e visibilità solo quando si può scorrere. */
(function initBaiaRailControls() {
  const COVER_SELECTOR = '.poster-frame, .music-cover, .reading-cover';
  const scheduled = new WeakMap();
  const activeGlowCard = new WeakMap();
  const glowShieldTimers = new WeakMap();
  const GLOW_FADE_MS = 180;

  function keepGlowShield(card) {
    if (!(card instanceof Element)) return;
    const timer = glowShieldTimers.get(card);
    if (timer) clearTimeout(timer);
    glowShieldTimers.delete(card);
    card.classList.add('baia-rail-glow-shield');
  }

  function releaseGlowShield(card) {
    if (!(card instanceof Element)) return;
    const previous = glowShieldTimers.get(card);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      glowShieldTimers.delete(card);
      card.classList.remove('baia-rail-glow-shield');
    }, GLOW_FADE_MS + 24);
    glowShieldTimers.set(card, timer);
  }

  function updateGlow(shell) {
    const card = activeGlowCard.get(shell);
    if (!(card instanceof Element) || !card.isConnected) {
      shell.classList.remove('baia-rail-glow-active');
      return;
    }
    const cover = card.querySelector('.poster-frame, .reading-cover, .music-cover') || card;
    const coverRect = cover.getBoundingClientRect();
    const shellRect = shell.getBoundingClientRect();
    if (coverRect.width <= 0 || coverRect.height <= 0) return;
    shell.style.setProperty('--baia-rail-glow-left', `${coverRect.left - shellRect.left}px`);
    shell.style.setProperty('--baia-rail-glow-top', `${coverRect.top - shellRect.top}px`);
    shell.style.setProperty('--baia-rail-glow-width', `${coverRect.width}px`);
    shell.style.setProperty('--baia-rail-glow-height', `${coverRect.height}px`);
    shell.style.setProperty('--baia-rail-glow-radius', getComputedStyle(cover).borderRadius || 'var(--cover-radius)');
    shell.classList.add('baia-rail-glow-active');
  }

  function updateShell(shell) {
    if (!(shell instanceof Element)) return;
    const rail = shell.querySelector(':scope > .poster-rail');
    if (!rail) return;

    const left = shell.querySelector(':scope > .rail-arrow-left');
    const right = shell.querySelector(':scope > .rail-arrow-right');
    const maxScroll = Math.max(0, rail.scrollWidth - rail.clientWidth);
    const epsilon = 2;

    if (left) {
      const unavailable = maxScroll <= epsilon || rail.scrollLeft <= epsilon;
      left.hidden = unavailable;
      left.setAttribute('aria-hidden', unavailable ? 'true' : 'false');
      left.tabIndex = unavailable ? -1 : 0;
    }
    if (right) {
      const unavailable = maxScroll <= epsilon || rail.scrollLeft >= maxScroll - epsilon;
      right.hidden = unavailable;
      right.setAttribute('aria-hidden', unavailable ? 'true' : 'false');
      right.tabIndex = unavailable ? -1 : 0;
    }

    const cover = rail.querySelector(COVER_SELECTOR);
    if (cover) {
      const coverRect = cover.getBoundingClientRect();
      const shellRect = shell.getBoundingClientRect();
      if (coverRect.height > 0) {
        shell.style.setProperty('--baia-rail-cover-top', `${Math.max(0, coverRect.top - shellRect.top)}px`);
        shell.style.setProperty('--baia-rail-cover-height', `${coverRect.height}px`);
      }
    }
    updateGlow(shell);
  }

  function schedule(shell) {
    if (scheduled.get(shell)) return;
    scheduled.set(shell, true);
    requestAnimationFrame(() => {
      scheduled.delete(shell);
      updateShell(shell);
    });
  }

  function connectShell(shell) {
    if (!(shell instanceof Element) || shell.dataset.baiaRailControls === '1') return;
    const rail = shell.querySelector(':scope > .poster-rail');
    if (!rail) return;
    shell.dataset.baiaRailControls = '1';

    rail.addEventListener('scroll', () => schedule(shell), { passive: true });
    rail.addEventListener('load', () => schedule(shell), true);

    rail.addEventListener('pointerover', (event) => {
      const card = event.target instanceof Element ? event.target.closest('.poster-card-button, .reading-card-button, .music-card-button') : null;
      if (!card || !rail.contains(card)) return;
      activeGlowCard.set(shell, card);
      keepGlowShield(card);
      schedule(shell);
    });
    rail.addEventListener('pointerout', (event) => {
      const card = activeGlowCard.get(shell);
      if (!card) return;
      const next = event.relatedTarget;
      if (next instanceof Node && card.contains(next)) return;
      if (next instanceof Element && next.closest('.poster-card-button, .reading-card-button, .music-card-button') === card) return;
      activeGlowCard.delete(shell);
      shell.classList.remove('baia-rail-glow-active');
      releaseGlowShield(card);
    });
    rail.addEventListener('focusin', (event) => {
      const card = event.target instanceof Element ? event.target.closest('.poster-card-button, .reading-card-button, .music-card-button') : null;
      if (!card || !rail.contains(card)) return;
      activeGlowCard.set(shell, card);
      keepGlowShield(card);
      schedule(shell);
    });
    rail.addEventListener('focusout', () => {
      const leavingCard = activeGlowCard.get(shell);
      requestAnimationFrame(() => {
        const focused = document.activeElement instanceof Element ? document.activeElement.closest('.poster-card-button, .reading-card-button, .music-card-button') : null;
        if (focused && rail.contains(focused)) {
          activeGlowCard.set(shell, focused);
          keepGlowShield(focused);
          schedule(shell);
          return;
        }
        activeGlowCard.delete(shell);
        shell.classList.remove('baia-rail-glow-active');
        releaseGlowShield(leavingCard);
      });
    });

    const mutationObserver = new MutationObserver(() => schedule(shell));
    mutationObserver.observe(rail, { childList: true, subtree: true });

    if (typeof ResizeObserver === 'function') {
      const resizeObserver = new ResizeObserver(() => schedule(shell));
      resizeObserver.observe(shell);
      resizeObserver.observe(rail);
    }

    schedule(shell);
  }

  function connectAll(root = document) {
    root.querySelectorAll?.('.showcase-shell').forEach(connectShell);
  }

  function start() {
    connectAll();
    const pageObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.matches('.showcase-shell')) connectShell(node);
          connectAll(node);
        }
      }
    });
    pageObserver.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', () => document.querySelectorAll('.showcase-shell').forEach(schedule), { passive: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
