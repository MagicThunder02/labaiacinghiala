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
