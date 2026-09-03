(() => {
  const STORAGE_KEY = 'baiaApiBaseUrl';
  const LOCAL_SERVER_BASE_URL = 'http://127.0.0.1:3000';
  const TAURI_DEV_PORT = '1430';
  const ACCOUNT_AUTH_FAILURE_CODES = new Set([
    'ACCOUNT_REQUIRED',
    'ACCOUNT_SESSION_EXPIRED',
    'ACCOUNT_DISABLED',
    'ACCOUNT_DELETED',
  ]);
  const ACCOUNT_ACCESS_FAILURE_CODES = new Set([
    'SECTION_ACCESS_DENIED',
    'ADMIN_REQUIRED',
    'PASSWORD_CHANGE_REQUIRED',
  ]);

  let runtimeBaseUrl = '';
  let coreBootstrap = null;
  let coreBootstrapError = null;
  const mediaUrlCache = new Map();

  function normalizeBaseUrl(value) {
    return String(value || '').trim().replace(/\/+$/, '');
  }

  function isBundledAppFrontend() {
    const { protocol, hostname, port } = window.location;
    if (protocol === 'tauri:') return true;
    if (hostname === 'tauri.localhost') return true;
    return port === TAURI_DEV_PORT && (hostname === 'localhost' || hostname === '127.0.0.1');
  }

  function getTauriCore() {
    try {
      if (window.parent !== window && window.parent.__TAURI__?.core) return window.parent.__TAURI__.core;
      if (window.__TAURI__?.core) return window.__TAURI__.core;
    } catch {}
    return null;
  }

  function getStoredBaseUrl() {
    try {
      return normalizeBaseUrl(window.localStorage.getItem(STORAGE_KEY));
    } catch {
      return '';
    }
  }

  function getBaseUrl() {
    const injected = normalizeBaseUrl(window.__BAIA_API_BASE_URL__);
    if (injected) return injected;

    if (isBundledAppFrontend()) return runtimeBaseUrl || LOCAL_SERVER_BASE_URL;

    const stored = getStoredBaseUrl();
    if (stored) return stored;
    return '';
  }

  function isAbsoluteUrl(value) {
    return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value);
  }

  function url(value) {
    const input = String(value || '');
    if (!input || isAbsoluteUrl(input) || input.startsWith('#')) return input;

    const baseUrl = getBaseUrl();
    if (!baseUrl) return input;

    try {
      return new URL(input, `${baseUrl}/`).toString();
    } catch {
      return input;
    }
  }

  function setBaseUrl(value) {
    const normalized = normalizeBaseUrl(value);
    try {
      if (normalized) window.localStorage.setItem(STORAGE_KEY, normalized);
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch {}
    return normalized;
  }

  function clearBaseUrl() {
    return setBaseUrl('');
  }

  function applyCoreBootstrap(bootstrap) {
    const previousBaseUrl = runtimeBaseUrl;
    coreBootstrap = bootstrap || null;
    runtimeBaseUrl = normalizeBaseUrl(bootstrap?.apiBaseUrl);
    if (previousBaseUrl !== runtimeBaseUrl) mediaUrlCache.clear();
    return coreBootstrap;
  }

  async function initializeCore() {
    if (!isBundledAppFrontend()) return null;
    const tauriCore = getTauriCore();
    if (!tauriCore?.invoke) return null;

    try {
      const bootstrap = await tauriCore.invoke('baia_core_bootstrap');
      coreBootstrapError = null;
      return applyCoreBootstrap(bootstrap);
    } catch (error) {
      coreBootstrapError = error;
      return null;
    }
  }

  const ready = initializeCore();

  async function getCoreBootstrap() {
    await ready;
    return coreBootstrap;
  }

  function getCoreBootstrapError() {
    return coreBootstrapError;
  }

  async function setServerEndpoint(value) {
    await ready;
    const tauriCore = getTauriCore();
    if (!isBundledAppFrontend() || !tauriCore?.invoke) {
      throw new Error('La configurazione nativa del server è disponibile solo nell’app Baia.');
    }

    const endpoint = normalizeBaseUrl(value);
    const bootstrap = await tauriCore.invoke('baia_core_set_server_endpoint', { endpoint });
    coreBootstrapError = null;
    return applyCoreBootstrap(bootstrap);
  }

  async function resetServerEndpoint() {
    await ready;
    const tauriCore = getTauriCore();
    if (!isBundledAppFrontend() || !tauriCore?.invoke) {
      throw new Error('La configurazione nativa del server è disponibile solo nell’app Baia.');
    }

    const bootstrap = await tauriCore.invoke('baia_core_reset_server_endpoint');
    coreBootstrapError = null;
    return applyCoreBootstrap(bootstrap);
  }

  async function probeServer() {
    await ready;
    const tauriCore = getTauriCore();
    if (!tauriCore?.invoke || !coreBootstrap) return null;
    return tauriCore.invoke('baia_core_probe_server');
  }

  async function getDeviceIdentity() {
    await ready;
    const tauriCore = getTauriCore();
    if (!isBundledAppFrontend() || !tauriCore?.invoke || !coreBootstrap) return null;
    return tauriCore.invoke('baia_core_device_identity');
  }

  async function getPairingStatus() {
    await ready;
    const tauriCore = getTauriCore();
    if (!isBundledAppFrontend() || !tauriCore?.invoke || !coreBootstrap) return null;
    return tauriCore.invoke('baia_core_pairing_status');
  }

  async function pairWithInvite(inviteToken, deviceName = '') {
    await ready;
    const tauriCore = getTauriCore();
    if (!isBundledAppFrontend() || !tauriCore?.invoke || !coreBootstrap) {
      throw new Error('Il pairing è disponibile solo nell’app Baia.');
    }

    const status = await tauriCore.invoke('baia_core_pair_with_invite', {
      inviteToken: String(inviteToken || '').trim(),
      deviceName: String(deviceName || '').trim() || null,
    });
    mediaUrlCache.clear();
    return status;
  }

  async function requestAuthHeaders(method, value) {
    await ready;
    if (!isBundledAppFrontend()) return {};

    const tauriCore = getTauriCore();
    if (!tauriCore?.invoke || !coreBootstrap) {
      throw new Error('Baia Core non disponibile per autenticare la richiesta.');
    }

    const target = url(value);
    const authorization = await tauriCore.invoke('baia_core_authorize_request', {
      method: String(method || 'GET').toUpperCase(),
      url: target,
    });

    return {
      'X-Baia-Device-Id': authorization.deviceId,
      'X-Baia-Timestamp': String(authorization.timestamp),
      'X-Baia-Nonce': authorization.nonce,
      'X-Baia-Signature': authorization.signature,
    };
  }

  function dispatchAccountFailure(payload, status) {
    if (![401, 403].includes(Number(status))) return false;
    let message = null;
    let eventName = '';
    if (ACCOUNT_AUTH_FAILURE_CODES.has(payload?.code)) {
      message = {
        type: 'shell-account-auth-required',
        code: payload.code,
        message: payload.error || '',
      };
      eventName = 'baia-account-auth-required';
    } else if (ACCOUNT_ACCESS_FAILURE_CODES.has(payload?.code)) {
      message = {
        type: 'shell-account-access-denied',
        code: payload.code,
        section: payload.section || '',
        message: payload.error || '',
      };
      eventName = 'baia-account-access-denied';
    }
    if (!message) return false;
    window.dispatchEvent(new CustomEvent(eventName, { detail: message }));
    if (window.parent !== window) window.parent.postMessage(message, window.location.origin);
    return true;
  }

  async function fetchApi(value, options = {}) {
    const target = url(value);
    const method = String(options.method || 'GET').toUpperCase();
    if (isBundledAppFrontend() && (method === 'GET' || method === 'HEAD') && mediaBridgePath(target)) {
      const bridgeTarget = await authorizeMediaUrl(target);
      const response = await fetch(bridgeTarget, options);
      if ((response.status === 401 || response.status === 403) && response.headers.get('content-type')?.includes('application/json')) {
        void response.clone().json().then((payload) => dispatchAccountFailure(payload, response.status)).catch(() => {});
      }
      return response;
    }

    const authHeaders = await requestAuthHeaders(method, target);
    const response = await fetch(target, {
      ...options,
      headers: {
        ...(options.headers || {}),
        ...authHeaders,
      },
    });
    if ((response.status === 401 || response.status === 403) && response.headers.get('content-type')?.includes('application/json')) {
      void response.clone().json().then((payload) => dispatchAccountFailure(payload, response.status)).catch(() => {});
    }
    return response;
  }


  function relativeApiPath(value) {
    const input = String(value || '').trim();
    if (!input) throw new Error('Path API Baia mancante.');
    let parsed;
    try {
      parsed = isAbsoluteUrl(input)
        ? new URL(input)
        : new URL(input, `${getBaseUrl() || LOCAL_SERVER_BASE_URL}/`);
    } catch {
      throw new Error('Path API Baia non valido.');
    }
    if (parsed.origin !== getBaseUrl() || !parsed.pathname.startsWith('/api/') || parsed.hash) {
      throw new Error('Il Core accetta soltanto path /api/ del server Baia configurato.');
    }
    return `${parsed.pathname}${parsed.search}`;
  }

  function coreRequestHeaders(headers) {
    if (!headers) return {};
    const entries = typeof headers.entries === 'function'
      ? [...headers.entries()]
      : Array.isArray(headers)
        ? headers
        : Object.entries(headers);
    const accepted = {};
    for (const [rawName, rawValue] of entries) {
      const name = String(rawName || '').trim();
      const lower = name.toLowerCase();
      if (lower.startsWith('x-baia-')) {
        throw new Error('Gli header X-Baia vengono generati esclusivamente dal Core.');
      }
      if (!['accept', 'content-type'].includes(lower)) {
        throw new Error(`Header API non consentito dal Core: ${name}.`);
      }
      accepted[lower] = String(rawValue ?? '');
    }
    return accepted;
  }

  function coreApiResponse(result) {
    const sourceHeaders = result?.headers || {};
    const headerMap = new Map(Object.entries(sourceHeaders).map(([name, value]) => [String(name).toLowerCase(), String(value)]));
    const body = String(result?.body ?? '');
    return {
      status: Number(result?.status || 0),
      ok: Boolean(result?.ok),
      headers: {
        get(name) {
          return headerMap.get(String(name || '').toLowerCase()) ?? null;
        },
      },
      async json() {
        return JSON.parse(body);
      },
      async text() {
        return body;
      },
      clone() {
        return coreApiResponse(result);
      },
    };
  }

  async function fetchApiJson(value, options = {}) {
    await ready;
    if (!isBundledAppFrontend()) return fetchApi(value, options);

    const tauriCore = getTauriCore();
    if (!tauriCore?.invoke || !coreBootstrap) {
      throw new Error('Baia Core non disponibile per la richiesta API.');
    }

    const method = String(options.method || 'GET').toUpperCase();
    const body = options.body == null ? null : options.body;
    if (body != null && typeof body !== 'string') {
      throw new Error('Il trasporto API del Core accetta soltanto body testuali.');
    }

    const result = await tauriCore.invoke('baia_core_api_request', {
      request: {
        path: relativeApiPath(value),
        method,
        headers: coreRequestHeaders(options.headers),
        body,
      },
    });
    const response = coreApiResponse(result);
    if ((response.status === 401 || response.status === 403) && response.headers.get('content-type')?.includes('application/json')) {
      void response.clone().json().then((payload) => dispatchAccountFailure(payload, response.status)).catch(() => {});
    }
    return response;
  }

  function nativeUploadsAvailable() {
    const tauriCore = getTauriCore();
    return Boolean(isBundledAppFrontend() && tauriCore?.invoke && tauriCore?.Channel);
  }

  async function pickUploadFiles(role, category = null) {
    await ready;
    const tauriCore = getTauriCore();
    if (!nativeUploadsAvailable() || !coreBootstrap) {
      throw new Error('Gli upload nativi sono disponibili solo nell’app Baia associata al server.');
    }
    return tauriCore.invoke('baia_core_pick_upload_files', {
      role: String(role || ''),
      category: category ? String(category) : null,
    });
  }

  async function releaseUploadFiles(tokens) {
    await ready;
    const tauriCore = getTauriCore();
    const values = [...new Set((tokens || []).map((token) => String(token || '').trim()).filter(Boolean))];
    if (!values.length || !nativeUploadsAvailable() || !coreBootstrap) return;
    await tauriCore.invoke('baia_core_release_upload_files', { tokens: values });
  }

  async function uploadFilesNative(request, onProgress = null) {
    await ready;
    const tauriCore = getTauriCore();
    if (!nativeUploadsAvailable() || !coreBootstrap) {
      throw new Error('Gli upload nativi sono disponibili solo nell’app Baia associata al server.');
    }
    const progressChannel = new tauriCore.Channel();
    progressChannel.onmessage = (progress) => {
      if (typeof onProgress === 'function') onProgress(progress || {});
    };
    const response = await tauriCore.invoke('baia_core_upload_files', {
      request,
      onProgress: progressChannel,
    });
    const status = Number(response?.status || 0);
    const payload = response?.payload ?? null;
    if (!response?.ok) {
      dispatchAccountFailure(payload, status);
      const error = new Error(payload?.error || `Errore HTTP ${status || 'sconosciuto'}`);
      error.code = payload?.code || '';
      error.status = status;
      throw error;
    }
    return payload;
  }

  function isServerHttpApiUrl(value) {
    try {
      const parsed = new URL(value);
      return /^https?:$/.test(parsed.protocol)
        && parsed.origin === getBaseUrl()
        && parsed.pathname.startsWith('/api/');
    } catch {
      return false;
    }
  }

  function mediaBridgePath(value) {
    if (!isServerHttpApiUrl(value)) return null;
    let parsedTarget;
    try {
      parsedTarget = new URL(value);
    } catch {
      return null;
    }

    const uuid = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';
    const path = parsedTarget.pathname;
    const isMovieStream = /^\/api\/movies\/\d+\/stream$/.test(path);
    const isMoviePoster = /^\/api\/movies\/\d+\/poster$/.test(path);
    const isSeriesPoster = new RegExp(`^/api/series/${uuid}/poster$`).test(path);
    const isMusicStream = new RegExp(`^/api/music/tracks/${uuid}/stream$`).test(path);
    const isMusicAlbumCover = new RegExp(`^/api/music/albums/${uuid}/cover$`).test(path);
    const isReadingFile = /^\/api\/reading\/\d+\/file$/.test(path);
    const isReadingCover = /^\/api\/reading\/\d+\/cover$/.test(path);
    const isReadingEntry = /^\/api\/reading\/\d+\/reader\/entry\/\d+$/.test(path);

    const cacheQueryKeys = [...parsedTarget.searchParams.keys()];
    const cacheQueryIsSafe = cacheQueryKeys.length <= 2
      && new Set(cacheQueryKeys).size === cacheQueryKeys.length
      && cacheQueryKeys.every((key) => key === 'v' || key === 't');
    const isArtwork = isMoviePoster || isSeriesPoster || isMusicAlbumCover || isReadingCover;
    if (isArtwork && cacheQueryIsSafe && !parsedTarget.hash) return path;

    const isStreamOrDocument = isMovieStream || isMusicStream || isReadingFile || isReadingEntry;
    if (isStreamOrDocument && !parsedTarget.search && !parsedTarget.hash) return path;
    return null;
  }

  async function authorizeMediaUrl(value) {
    await ready;
    const target = url(value);
    if (!isBundledAppFrontend() || !isServerHttpApiUrl(target)) return target;

    const cached = mediaUrlCache.get(target);
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (cached && cached.expires > nowSeconds + 60) return cached.url;

    const tauriCore = getTauriCore();
    if (!tauriCore?.invoke || !coreBootstrap) {
      throw new Error('Baia Core non disponibile per autorizzare la risorsa multimediale.');
    }

    const bridgePath = mediaBridgePath(target);
    const signed = bridgePath
      ? await tauriCore.invoke('baia_core_media_bridge_url', { path: bridgePath })
      : await tauriCore.invoke('baia_core_authorize_media_url', { url: target });
    let expires = nowSeconds + 60;
    try {
      expires = Number(new URL(signed).searchParams.get('_baia_expires')) || expires;
    } catch {}
    mediaUrlCache.set(target, { url: signed, expires });
    return signed;
  }

  window.BaiaApi = Object.freeze({
    url,
    getBaseUrl,
    setBaseUrl,
    clearBaseUrl,
    ready,
    getCoreBootstrap,
    getCoreBootstrapError,
    setServerEndpoint,
    resetServerEndpoint,
    probeServer,
    getDeviceIdentity,
    getPairingStatus,
    pairWithInvite,
    requestAuthHeaders,
    fetchApi,
    fetchApiJson,
    nativeUploadsAvailable,
    pickUploadFiles,
    releaseUploadFiles,
    uploadFilesNative,
    authorizeMediaUrl,
    isTauri: isBundledAppFrontend,
    storageKey: STORAGE_KEY,
  });
})();
