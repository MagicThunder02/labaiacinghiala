const state = {
  mode: 'home',
  home: { recent: [], latest: [], recommended: [] },
  genre: '',
  year: 0,
  filters: { genres: [], years: [] },
  series: [],
  seriesTotal: 0,
  seriesLoading: false,
  searchResults: [],
  activeSeries: null,
  activeEpisode: null,
  similarSeries: [],
  similarRequest: 0,
  searchTimer: null,
  paletteRequest: 0,
  playerReady: false,
  suppressProgressEvents: false,
  scrubbing: false,
  resumeAfterScrub: false,
  pendingSeekSeconds: null,
  seekTimer: null,
  lastSeekAppliedAt: 0,
  controlsHideTimer: null,
  playerLoadingTimer: null,
  volumeThumbTimer: null,
  wakeLockSentinel: null,
  touchTap: null,
  touchTapTimer: null,
  touchFeedbackTimer: null,
  progressPlaybackSinceSave: 0,
  progressLastObservedSeconds: null,
  progressLastSavedSeconds: null,
  progressLastSavedDuration: null,
  progressSaveQueue: Promise.resolve(),
};

const TOUCH_LAYOUT_QUERY = '(hover: none) and (pointer: coarse)';
const touchLayoutMedia = window.matchMedia(TOUCH_LAYOUT_QUERY);
const PLAYER_VOLUME_STORAGE_KEY = 'baia-player-volume';
const SERIES_PAGE_SIZE = 50;
const PROGRESS_CHECKPOINT_SECONDS = 30;

function usesTouchLayout() {
  return touchLayoutMedia.matches;
}

function syncSeriesViewport() {
  const viewportHeight = Math.round(window.visualViewport?.height || window.innerHeight || document.documentElement.clientHeight);
  if (viewportHeight > 0) document.documentElement.style.setProperty('--baia-viewport-height', `${viewportHeight}px`);
}

const elements = {
  browse: document.querySelector('#browseView'),
  pageTitle: document.querySelector('#pageTitle'),
  searchField: document.querySelector('#searchField'),
  filtersButton: document.querySelector('#filtersButton'),
  filtersPanel: document.querySelector('#filtersPanel'),
  homeButton: document.querySelector('#homeButton'),
  genreButton: document.querySelector('#genreButton'),
  genreMenu: document.querySelector('#genreMenu'),
  genreFilterSearch: document.querySelector('#genreFilterSearch'),
  genreOptions: document.querySelector('#genreOptions'),
  genreFilterEmpty: document.querySelector('#genreFilterEmpty'),
  yearButton: document.querySelector('#yearButton'),
  yearMenu: document.querySelector('#yearMenu'),
  yearFilterSearch: document.querySelector('#yearFilterSearch'),
  yearOptions: document.querySelector('#yearOptions'),
  yearFilterEmpty: document.querySelector('#yearFilterEmpty'),
  clearFiltersButton: document.querySelector('#clearFiltersButton'),
  homeView: document.querySelector('#homeView'),
  recentRail: document.querySelector('#recentRail'),
  latestRail: document.querySelector('#latestRail'),
  recommendedRail: document.querySelector('#recommendedRail'),
  recentEmpty: document.querySelector('#recentEmpty'),
  latestEmpty: document.querySelector('#latestEmpty'),
  recommendedEmpty: document.querySelector('#recommendedEmpty'),
  catalogView: document.querySelector('#catalogView'),
  grid: document.querySelector('#seriesGrid'),
  count: document.querySelector('#seriesCount'),
  clearYearButton: document.querySelector('#clearYearButton'),
  empty: document.querySelector('#emptyState'),
  loadMore: document.querySelector('#seriesLoadMoreButton'),
  searchView: document.querySelector('#searchView'),
  searchInput: document.querySelector('#searchInput'),
  searchCount: document.querySelector('#searchCount'),
  searchResults: document.querySelector('#searchResults'),
  searchEmpty: document.querySelector('#searchEmpty'),
  detail: document.querySelector('#detailView'),
  detailBack: document.querySelector('#detailBackButton'),
  detailTitle: document.querySelector('#detailTitle'),
  detailMeta: document.querySelector('#detailMeta'),
  detailPoster: document.querySelector('#detailPoster'),
  detailFallback: document.querySelector('#detailPosterFallback'),
  detailBackdrop: document.querySelector('#detailBackdropImage'),
  resume: document.querySelector('#resumeButton'),
  restart: document.querySelector('#restartButton'),
  season: document.querySelector('#seasonSelect'),
  episodes: document.querySelector('#episodeList'),
  similarSection: document.querySelector('#similarSection'),
  similarRail: document.querySelector('#similarRail'),
  playerView: document.querySelector('#playerView'),
  playerStage: document.querySelector('.player-stage'),
  playerTitle: document.querySelector('#playerTitle'),
  playerMeta: document.querySelector('#playerMeta'),
  videoPlayer: document.querySelector('#videoPlayer'),
  playerLoading: document.querySelector('#playerLoading'),
  closePlayerButton: document.querySelector('#closePlayerButton'),
  playerSeek: document.querySelector('#playerSeek'),
  playerControls: document.querySelector('#playerControls'),
  playerVolume: document.querySelector('#playerVolume'),
  remainingTime: document.querySelector('#remainingTime'),
  totalTime: document.querySelector('#totalTime'),
  playPauseButton: document.querySelector('#playPauseButton'),
  playPauseIcon: document.querySelector('#playPauseIcon'),
  fullscreenButton: document.querySelector('#fullscreenButton'),
  fullscreenIcon: document.querySelector('#fullscreenIcon'),
  previousEpisodeButton: document.querySelector('#previousEpisodeButton'),
  nextEpisodeButton: document.querySelector('#nextEpisodeButton'),
};

function initials(value) {
  return String(value || '').split(/\s+/).filter(Boolean).slice(0, 3).map((part) => part[0]?.toUpperCase()).join('');
}

function progressPercent(episode) {
  if (!episode?.durationSeconds) return 0;
  return Math.max(0, Math.min(100, episode.progressSeconds / episode.durationSeconds * 100));
}

function hasResumableProgress(episode) {
  return Boolean(
    episode
    && !episode.completed
    && Number(episode.progressSeconds) > 5
    && (!Number(episode.durationSeconds) || Number(episode.progressSeconds) < Number(episode.durationSeconds) - 5)
  );
}

function formatPlayerTime(seconds) {
  const safeSeconds = Number.isFinite(Number(seconds)) ? Math.max(0, Math.floor(Number(seconds))) : 0;
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const secs = safeSeconds % 60;
  return [hours, minutes, secs].map((value) => String(value).padStart(2, '0')).join(':');
}

function clampPlayerTime(seconds) {
  const duration = Number.isFinite(elements.videoPlayer.duration) ? elements.videoPlayer.duration : 0;
  if (!duration) return Math.max(0, Number(seconds) || 0);
  return Math.max(0, Math.min(duration, Number(seconds) || 0));
}

function updatePlayerTimeline(previewSeconds = null) {
  const player = elements.videoPlayer;
  const duration = Number.isFinite(player.duration) ? Math.max(0, player.duration) : 0;
  const current = previewSeconds === null
    ? (Number.isFinite(player.currentTime) ? player.currentTime : 0)
    : clampPlayerTime(previewSeconds);
  const remaining = Math.max(0, duration - current);
  const percentage = duration > 0 ? Math.max(0, Math.min(100, current / duration * 100)) : 0;

  elements.remainingTime.textContent = `-${formatPlayerTime(remaining)}`;
  elements.totalTime.textContent = formatPlayerTime(duration);
  elements.playerSeek.max = String(duration || 0);
  if (!state.scrubbing || previewSeconds !== null) elements.playerSeek.value = String(current);
  elements.playerSeek.style.setProperty('--seek-progress', `${percentage}%`);
  elements.playerSeek.setAttribute('aria-valuetext', `${formatPlayerTime(current)} di ${formatPlayerTime(duration)}, ${formatPlayerTime(remaining)} rimanenti`);
}

function updatePlayPauseControl() {
  const isPlaying = !elements.videoPlayer.paused && !elements.videoPlayer.ended;
  elements.playPauseButton.setAttribute('aria-label', isPlaying ? 'Metti in pausa' : 'Riproduci');
  elements.playPauseButton.title = isPlaying ? 'Pausa (Spazio)' : 'Riproduci (Spazio)';
  elements.playPauseIcon.className = `film-icon ${isPlaying ? 'pause-icon' : 'play-icon'}`;
}

function setPlayerLoading(loading, { delayed = false } = {}) {
  clearTimeout(state.playerLoadingTimer);
  state.playerLoadingTimer = null;
  if (!loading) {
    elements.playerLoading.hidden = true;
    elements.playerStage.classList.remove('player-is-loading');
    return;
  }
  const showLoading = () => {
    if (elements.playerView.hidden) return;
    elements.playerLoading.hidden = false;
    elements.playerStage.classList.add('player-is-loading');
  };
  if (delayed) state.playerLoadingTimer = window.setTimeout(showLoading, 160);
  else showLoading();
}

function isPlayerFullscreen() {
  return document.fullscreenElement === elements.playerView;
}

function updateFullscreenControl() {
  const fullscreen = isPlayerFullscreen();
  elements.fullscreenButton.setAttribute('aria-label', fullscreen ? 'Esci dallo schermo intero' : 'Entra a schermo intero');
  elements.fullscreenButton.title = fullscreen ? 'Esci dallo schermo intero (Esc)' : 'Schermo intero (Shift)';
  elements.fullscreenIcon.className = `film-icon ${fullscreen ? 'fullscreen-exit-icon' : 'fullscreen-enter-icon'}`;
}

function clampPlayerSetting(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function updateSideSliderProgress(input, value) {
  const minimum = Number(input.min) || 0;
  const maximum = Number(input.max) || 100;
  const percentage = maximum > minimum ? (value - minimum) / (maximum - minimum) * 100 : 0;
  input.style.setProperty('--side-progress', `${Math.max(0, Math.min(100, percentage))}%`);
}

function persistPlayerSetting(key, value) {
  try { window.localStorage.setItem(key, String(value)); } catch {}
}

function readPlayerSetting(key, fallback) {
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

function setPlayerVolume(value, { persist = true } = {}) {
  const volume = clampPlayerSetting(value, 0, 100, 100);
  elements.playerVolume.value = String(Math.round(volume));
  elements.videoPlayer.volume = volume / 100;
  elements.playerVolume.setAttribute('aria-valuetext', `${Math.round(volume)}%`);
  updateSideSliderProgress(elements.playerVolume, volume);
  if (persist) persistPlayerSetting(PLAYER_VOLUME_STORAGE_KEY, Math.round(volume));
}

function restorePlayerSettings() {
  setPlayerVolume(readPlayerSetting(PLAYER_VOLUME_STORAGE_KEY, 100), { persist: false });
}

function showPlayerVolumeThumb() {
  clearTimeout(state.volumeThumbTimer);
  elements.playerVolume.classList.add('is-interacting');
  state.volumeThumbTimer = window.setTimeout(() => {
    elements.playerVolume.classList.remove('is-interacting');
    state.volumeThumbTimer = null;
  }, 520);
}

async function releasePlayerWakeLock() {
  const sentinel = state.wakeLockSentinel;
  state.wakeLockSentinel = null;
  if (!sentinel || sentinel.released) return;
  try { await sentinel.release(); } catch {}
}

async function requestPlayerWakeLock() {
  if (!('wakeLock' in navigator)
    || document.visibilityState !== 'visible'
    || elements.playerView.hidden
    || elements.videoPlayer.paused
    || elements.videoPlayer.ended
    || state.wakeLockSentinel) return;

  try {
    const sentinel = await navigator.wakeLock.request('screen');
    state.wakeLockSentinel = sentinel;
    sentinel.addEventListener('release', () => {
      if (state.wakeLockSentinel === sentinel) state.wakeLockSentinel = null;
    }, { once: true });
  } catch (error) {
    // Wake Lock può non essere disponibile fuori da un contesto sicuro o per policy del browser.
    console.debug('Screen Wake Lock non disponibile:', error?.message || error);
  }
}

function isPlayerControlTarget(target) {
  return target instanceof Element && Boolean(target.closest(
    '.player-topbar, .custom-player-controls, .player-side-controls, .series-episode-navigation, button, input, select, textarea, a'
  ));
}

const PLAYER_CONTROLS_HIDE_DELAY = 3000;

function clearPlayerControlsTimer() {
  clearTimeout(state.controlsHideTimer);
  state.controlsHideTimer = null;
}

function shouldAutoHidePlayerControls() {
  return Boolean(
    !elements.playerView.hidden
    && isPlayerFullscreen()
    && !elements.videoPlayer.paused
    && !elements.videoPlayer.ended
    && !state.scrubbing
  );
}

function hidePlayerControls({ force = false } = {}) {
  clearPlayerControlsTimer();
  if (!force && !shouldAutoHidePlayerControls()) return;
  elements.playerStage.classList.add('player-controls-hidden');
}

function showPlayerControls({ restartTimer = true } = {}) {
  elements.playerStage.classList.remove('player-controls-hidden');
  clearPlayerControlsTimer();
  if (restartTimer && shouldAutoHidePlayerControls()) {
    state.controlsHideTimer = setTimeout(hidePlayerControls, PLAYER_CONTROLS_HIDE_DELAY);
  }
}

function syncPlayerControlsVisibility() {
  showPlayerControls({ restartTimer: shouldAutoHidePlayerControls() });
}

async function togglePlayback() {
  if (elements.videoPlayer.paused || elements.videoPlayer.ended) {
    try { await elements.videoPlayer.play(); } catch (error) { console.error(error); }
  } else {
    elements.videoPlayer.pause();
  }
  updatePlayPauseControl();
}

async function enterFullscreen() {
  if (isPlayerFullscreen() || elements.playerView.hidden) return;
  try { await elements.playerView.requestFullscreen(); }
  catch (error) { console.warn('Schermo intero non disponibile.', error); }
}

async function toggleFullscreen() {
  try {
    if (isPlayerFullscreen()) await document.exitFullscreen();
    else await enterFullscreen();
  } catch (error) {
    console.warn('Impossibile cambiare la modalità schermo intero.', error);
  }
}

function applyQueuedSeek(force = false) {
  const pending = state.pendingSeekSeconds;
  if (!Number.isFinite(pending)) return;
  const apply = () => {
    state.seekTimer = null;
    const target = clampPlayerTime(state.pendingSeekSeconds);
    state.pendingSeekSeconds = null;
    state.lastSeekAppliedAt = Date.now();
    elements.videoPlayer.currentTime = target;
  };
  if (force) {
    clearTimeout(state.seekTimer);
    apply();
    return;
  }
  if (state.seekTimer) return;
  const delay = Math.max(0, 80 - (Date.now() - state.lastSeekAppliedAt));
  state.seekTimer = setTimeout(apply, delay);
}

function beginScrubbing() {
  if (state.scrubbing || !state.playerReady) return;
  state.scrubbing = true;
  showPlayerControls({ restartTimer: false });
  state.resumeAfterScrub = !elements.videoPlayer.paused && !elements.videoPlayer.ended;
  if (state.resumeAfterScrub) elements.videoPlayer.pause();
}

async function finishScrubbing() {
  if (!state.scrubbing) return;
  state.pendingSeekSeconds = Number(elements.playerSeek.value);
  applyQueuedSeek(true);
  state.scrubbing = false;
  updatePlayerTimeline();
  state.progressLastObservedSeconds = Number.isFinite(elements.videoPlayer.currentTime)
    ? elements.videoPlayer.currentTime
    : null;
  if (state.resumeAfterScrub) {
    try { await elements.videoPlayer.play(); } catch {}
  }
  state.resumeAfterScrub = false;
  syncPlayerControlsVisibility();
}

function seekBy(seconds) {
  if (!state.playerReady) return;
  const target = clampPlayerTime(elements.videoPlayer.currentTime + seconds);
  elements.videoPlayer.currentTime = target;
  state.progressLastObservedSeconds = null;
  updatePlayerTimeline(target);
}

function createSeriesCard(series) {
  const article = document.createElement('article');
  article.className = 'poster-card';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'poster-card-button';
  button.setAttribute('aria-label', `Apri la serie ${series.title}`);
  const frame = document.createElement('div');
  frame.className = 'poster-frame';
  const fallback = document.createElement('div');
  fallback.className = 'poster-fallback';
  const strong = document.createElement('strong');
  strong.textContent = initials(series.title) || series.title;
  fallback.appendChild(strong);
  frame.appendChild(fallback);
  const image = document.createElement('img');
  image.className = 'poster-image';
  window.BaiaPage.setMediaSrc(image, series.posterUrl);
  image.alt = '';
  image.loading = 'lazy';
  image.addEventListener('error', () => image.remove(), { once: true });
  frame.appendChild(image);
  const shade = document.createElement('div');
  shade.className = 'poster-shade';
  frame.appendChild(shade);
  const caption = document.createElement('div');
  caption.className = 'poster-caption';
  const title = document.createElement('strong');
  title.textContent = series.title;
  const meta = document.createElement('span');
  meta.textContent = [series.year, `${series.seasonCount} stag.`, `${series.episodeCount} ep.`].filter(Boolean).join(' · ');
  caption.append(title, meta);
  frame.appendChild(caption);
  if (series.progressPercent > 0 && series.progressPercent < 100) {
    const track = document.createElement('div');
    track.className = 'progress-track';
    const bar = document.createElement('div');
    bar.className = 'progress-bar';
    bar.style.width = `${series.progressPercent}%`;
    track.appendChild(bar);
    frame.appendChild(track);
  }
  button.appendChild(frame);
  button.addEventListener('click', () => openDetails(series.seriesUuid).catch(handleError));
  article.appendChild(button);
  return article;
}

function renderRail(container, emptyElement, seriesItems) {
  container.replaceChildren(...seriesItems.map(createSeriesCard));
  emptyElement.hidden = seriesItems.length !== 0;
  container.closest('.showcase-shell').hidden = seriesItems.length === 0;
}

function renderSimilarSeries(seriesItems) {
  state.similarSeries = seriesItems;
  elements.similarRail.replaceChildren(...seriesItems.map(createSeriesCard));
  elements.similarSection.hidden = seriesItems.length === 0;
}

async function loadSimilarSeries(seriesUuid) {
  const request = ++state.similarRequest;
  elements.similarSection.hidden = true;
  elements.similarRail.replaceChildren();

  try {
    const payload = await window.BaiaPage.apiRequest(`/api/series/${encodeURIComponent(seriesUuid)}/similar`);
    if (request !== state.similarRequest || state.activeSeries?.seriesUuid !== seriesUuid) return;
    renderSimilarSeries(Array.isArray(payload.series) ? payload.series : []);
  } catch (error) {
    if (request !== state.similarRequest || state.activeSeries?.seriesUuid !== seriesUuid) return;
    renderSimilarSeries([]);
    console.error(error);
  }
}

function renderSeries() {
  elements.grid.replaceChildren(...state.series.map(createSeriesCard));
  elements.count.textContent = state.seriesTotal === 1 ? '1 serie' : `${state.seriesTotal} serie`;
  elements.empty.hidden = state.seriesTotal > 0 || state.seriesLoading;
  elements.loadMore.hidden = state.series.length >= state.seriesTotal || state.seriesTotal === 0;
  elements.loadMore.disabled = state.seriesLoading;
  elements.loadMore.textContent = state.seriesLoading ? 'Caricamento…' : 'Mostra altro';
  elements.clearYearButton.hidden = !state.year;
  elements.clearYearButton.textContent = state.year ? String(state.year) : '';
}

function createSearchResult(series) {
  const item = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'search-result-button';

  const title = document.createElement('span');
  title.className = 'search-result-title';
  title.textContent = series.title;

  const meta = document.createElement('span');
  meta.className = 'search-result-meta';
  meta.textContent = [series.year, ...(series.genres || []).slice(0, 2)].filter(Boolean).join(' · ');

  button.append(title, meta);
  button.addEventListener('click', () => openDetails(series.seriesUuid).catch(handleError));
  item.appendChild(button);
  return item;
}

function renderSearchResults() {
  elements.searchResults.replaceChildren(...state.searchResults.map(createSearchResult));
  elements.searchCount.textContent = state.searchResults.length === 1
    ? '1 titolo'
    : `${state.searchResults.length} titoli`;
  elements.searchEmpty.hidden = state.searchResults.length !== 0;
}

function setBrowseMode(mode) {
  state.mode = mode;
  const searchOpen = mode === 'search';
  const activeFilterCount = [state.genre, state.year].filter(Boolean).length;
  // In ricerca la Home resta dietro al layer glass condiviso.
  elements.homeView.hidden = mode === 'catalog';
  elements.catalogView.hidden = mode !== 'catalog';
  elements.searchView.hidden = !searchOpen;
  document.body.classList.toggle('film-search-open', searchOpen);
  elements.homeButton.classList.toggle('active', mode === 'home');
  elements.searchField.classList.toggle('active', searchOpen);
  elements.searchInput.setAttribute('aria-expanded', String(searchOpen));
  elements.filtersButton.classList.toggle('has-filter', activeFilterCount > 0);
  elements.filtersButton.title = activeFilterCount > 0
    ? `Filtri attivi: ${activeFilterCount}`
    : 'Filtri';
  elements.genreButton.classList.toggle('has-filter', Boolean(state.genre));
  elements.yearButton.classList.toggle('has-filter', Boolean(state.year));
  elements.pageTitle.textContent = state.genre || 'Serie';
  elements.yearButton.textContent = state.year ? String(state.year) : 'Anno';
  elements.clearFiltersButton.disabled = !(state.genre || state.year);
  if (searchOpen) closeFiltersPanel();
  else closeMenus();
}

function closeMenus() {
  for (const [button, menu] of [
    [elements.genreButton, elements.genreMenu],
    [elements.yearButton, elements.yearMenu],
  ]) {
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  }
}

function closeFiltersPanel() {
  closeMenus();
  elements.filtersPanel.hidden = true;
  elements.filtersButton.setAttribute('aria-expanded', 'false');
  elements.filtersButton.classList.remove('active');
}

function toggleFiltersPanel() {
  const shouldOpen = elements.filtersPanel.hidden;
  closeMenus();
  elements.filtersPanel.hidden = !shouldOpen;
  elements.filtersButton.setAttribute('aria-expanded', String(shouldOpen));
  elements.filtersButton.classList.toggle('active', shouldOpen);
}

function toggleMenu(name) {
  const controls = {
    genre: [elements.genreButton, elements.genreMenu, elements.genreFilterSearch],
    year: [elements.yearButton, elements.yearMenu, elements.yearFilterSearch],
  };
  const [button, menu, searchInput] = controls[name];
  const shouldOpen = menu.hidden;
  closeMenus();
  menu.hidden = !shouldOpen;
  button.setAttribute('aria-expanded', String(shouldOpen));
  if (shouldOpen) {
    searchInput.value = '';
    renderFilterMenus();
    requestAnimationFrame(() => searchInput.focus({ preventScroll: true }));
  }
}

function makeFilterOption(label, value, selected, onSelect) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.dataset.value = String(value);
  button.classList.toggle('active', selected);
  button.addEventListener('click', () => onSelect(value));
  return button;
}

function normalizeFilterSearch(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('it')
    .trim();
}

function filterMenuValues(values, query) {
  const normalizedQuery = normalizeFilterSearch(query);
  if (!normalizedQuery) return values;
  return values.filter((value) => normalizeFilterSearch(value).includes(normalizedQuery));
}

function renderFilterMenu({
  container,
  emptyElement,
  values,
  query,
  allLabel,
  allValue,
  selectedValue,
  onSelect,
}) {
  const matchingValues = filterMenuValues(values, query);
  container.replaceChildren(
    makeFilterOption(allLabel, allValue, selectedValue === allValue, onSelect),
    ...matchingValues.map((value) => makeFilterOption(value, value, selectedValue === value, onSelect)),
  );
  emptyElement.hidden = matchingValues.length !== 0;
}

function renderFilterMenus() {
  renderFilterMenu({
    container: elements.genreOptions,
    emptyElement: elements.genreFilterEmpty,
    values: state.filters.genres,
    query: elements.genreFilterSearch.value,
    allLabel: 'Tutti i generi',
    allValue: '',
    selectedValue: state.genre,
    onSelect: selectGenre,
  });
  renderFilterMenu({
    container: elements.yearOptions,
    emptyElement: elements.yearFilterEmpty,
    values: state.filters.years,
    query: elements.yearFilterSearch.value,
    allLabel: 'Tutti',
    allValue: 0,
    selectedValue: state.year,
    onSelect: selectYear,
  });
}

function renderFilters(filters) {
  state.filters = {
    genres: Array.isArray(filters.genres) ? filters.genres : [],
    years: Array.isArray(filters.years) ? filters.years : [],
  };
  renderFilterMenus();
}

async function loadFilters() {
  const params = new URLSearchParams();
  if (state.genre) params.set('genre', state.genre);
  if (state.year) params.set('year', String(state.year));
  const query = params.toString();
  const suffix = query ? `?${query}` : '';
  const filters = await window.BaiaPage.apiRequest(`/api/series/filters${suffix}`);
  renderFilters(filters);
}

async function loadHome() {
  const payload = await window.BaiaPage.apiRequest('/api/series/home');
  state.home = payload;
  renderRail(elements.recentRail, elements.recentEmpty, payload.recent || []);
  renderRail(elements.latestRail, elements.latestEmpty, payload.latest || []);
  renderRail(elements.recommendedRail, elements.recommendedEmpty, payload.recommended || []);
}

async function loadSeries({ append = false } = {}) {
  if (state.seriesLoading) return;
  state.seriesLoading = true;
  renderSeries();
  const params = new URLSearchParams({
    limit: String(SERIES_PAGE_SIZE),
    offset: String(append ? state.series.length : 0),
  });
  if (state.genre) params.set('genre', state.genre);
  if (state.year) params.set('year', String(state.year));

  try {
    const payload = await window.BaiaPage.apiRequest(`/api/series?${params}`);
    const incoming = Array.isArray(payload.series) ? payload.series : [];
    state.series = append ? [...state.series, ...incoming] : incoming;
    state.seriesTotal = Number(payload.count || 0);
  } finally {
    state.seriesLoading = false;
    renderSeries();
  }
}

async function loadSearch() {
  const params = new URLSearchParams({ search: elements.searchInput.value.trim() });
  const payload = await window.BaiaPage.apiRequest(`/api/series?${params}`);
  state.searchResults = Array.isArray(payload.series) ? payload.series : [];
  renderSearchResults();
}

async function showHome() {
  state.genre = '';
  state.year = 0;
  setBrowseMode('home');
  await Promise.all([loadHome(), loadFilters()]);
}

async function showSearch() {
  setBrowseMode('search');
  await loadSearch();
  requestAnimationFrame(() => elements.searchInput.focus({ preventScroll: true }));
}

async function exitSearchMode() {
  if (state.mode !== 'search') return;
  clearTimeout(state.searchTimer);
  elements.searchInput.value = '';
  state.searchResults = [];
  await showHome();
}

async function selectGenre(value) {
  state.genre = String(value || '');
  setBrowseMode('catalog');
  await Promise.all([loadSeries(), loadFilters()]);
}

async function selectYear(value) {
  state.year = Number(value) || 0;
  setBrowseMode('catalog');
  await Promise.all([loadSeries(), loadFilters()]);
}

async function clearAllFilters() {
  if (!(state.genre || state.year)) return;
  state.genre = '';
  state.year = 0;
  setBrowseMode('catalog');
  await Promise.all([loadSeries(), loadFilters()]);
}

function detailMeta(series) {
  const lines = [];
  if (series.genres?.length) lines.push(series.genres.join(', '));
  if (series.year) lines.push(String(series.year));

  const seasonCount = Number(series.seasonCount) || series.seasons?.length || 0;
  const episodeCount = Number(series.episodeCount) || series.episodes?.length || 0;
  const libraryCounts = [];
  if (seasonCount) libraryCounts.push(`${seasonCount} ${seasonCount === 1 ? 'stagione' : 'stagioni'}`);
  if (episodeCount) libraryCounts.push(`${episodeCount} ${episodeCount === 1 ? 'episodio' : 'episodi'}`);
  if (libraryCounts.length) lines.push(libraryCounts.join(' · '));

  return lines.join('\n') || 'Informazioni non disponibili';
}

function setPoster(series) {
  elements.detailFallback.textContent = initials(series.title) || series.title;
  elements.detailPoster.alt = `Copertina di ${series.title}`;
  elements.detailPoster.hidden = false;
  window.BaiaPage.setMediaSrc(elements.detailPoster, series.posterUrl);
  elements.detailBackdrop.hidden = false;
  window.BaiaPage.setMediaSrc(elements.detailBackdrop, series.posterUrl);
  elements.detailPoster.onerror = () => { elements.detailPoster.hidden = true; elements.detailFallback.hidden = false; };
  elements.detailPoster.onload = () => { elements.detailFallback.hidden = true; };
  elements.detailBackdrop.onerror = () => { elements.detailBackdrop.hidden = true; };
}

const DETAIL_FALLBACK_PALETTE = window.BaiaMediaPalette?.DEFAULT_PALETTE || Object.freeze({
  base: [22, 25, 19],
  primary: [108, 139, 72],
  secondary: [55, 95, 130],
  accentA: [164, 88, 72],
  accentB: [126, 103, 176],
});

function applySeriesDetailPalette(palette = DETAIL_FALLBACK_PALETTE) {
  if (window.BaiaMediaPalette) {
    window.BaiaMediaPalette.applyCssVariables(elements.detail, palette, 'detail-color');
    return;
  }
  elements.detail.style.setProperty('--detail-color-base', palette.base.join(', '));
  elements.detail.style.setProperty('--detail-color-a', palette.primary.join(', '));
  elements.detail.style.setProperty('--detail-color-b', palette.secondary.join(', '));
  elements.detail.style.setProperty('--detail-color-c', palette.accentA.join(', '));
  elements.detail.style.setProperty('--detail-color-d', palette.accentB.join(', '));
}

async function applySeriesPosterPalette(series) {
  const request = ++state.paletteRequest;
  let palette = DETAIL_FALLBACK_PALETTE;
  if (series.posterUrl && window.BaiaMediaPalette) {
    try {
      const mediaUrl = await window.BaiaPage.mediaUrl(series.posterUrl);
      palette = await window.BaiaMediaPalette.extractFromUrl(mediaUrl, {
        width: 72,
        height: 104,
        crossOrigin: 'anonymous',
      });
    } catch {
      palette = DETAIL_FALLBACK_PALETTE;
    }
  }
  if (request !== state.paletteRequest || state.activeSeries?.seriesUuid !== series.seriesUuid) return;
  applySeriesDetailPalette(palette);
}

function selectedSeasonEpisodes() {
  const season = Number(elements.season.value || 1);
  return state.activeSeries?.episodes?.filter((episode) => (episode.seasonNumber || 1) === season) || [];
}

function renderEpisodes() {
  const episodes = selectedSeasonEpisodes();
  elements.episodes.replaceChildren(...episodes.map((episode) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'episode-row';
    const percent = progressPercent(episode);
    button.innerHTML = `<span class="episode-copy"><span class="episode-number">Episodio ${episode.episodeNumber ?? '—'}</span><span class="episode-title"></span>${percent > 0 && !episode.completed ? `<span class="episode-progress-track"><span class="episode-progress-bar" style="width:${percent}%"></span></span>` : ''}</span><span class="episode-progress">${episode.completed ? 'Completato' : percent > 0 ? `${Math.round(percent)}%` : 'Riproduci'}</span>`;
    button.querySelector('.episode-title').textContent = episode.title || `Episodio ${episode.episodeNumber}`;
    button.addEventListener('click', () => startPlayback(episode, { restart: false }).catch(handleError));
    return button;
  }));
}

async function openDetails(seriesUuid) {
  const payload = await window.BaiaPage.apiRequest(`/api/series/${encodeURIComponent(seriesUuid)}`);
  state.activeSeries = payload.series;
  state.activeEpisode = null;
  elements.detailTitle.textContent = state.activeSeries.title;
  elements.detailMeta.textContent = detailMeta(state.activeSeries);
  setPoster(state.activeSeries);
  void applySeriesPosterPalette(state.activeSeries);
  const seasons = state.activeSeries.seasons?.length ? state.activeSeries.seasons : [1];
  elements.season.replaceChildren(...seasons.map((season) => {
    const option = document.createElement('option');
    option.value = season;
    option.textContent = `Stagione ${season}`;
    return option;
  }));
  elements.season.value = seasons.includes(1) ? '1' : String(seasons[0]);
  renderEpisodes();
  elements.resume.textContent = state.activeSeries.resumeEpisodeId ? 'Riprendi' : 'Riproduci';
  elements.browse.hidden = true;
  elements.detail.hidden = false;
  elements.playerView.hidden = true;
  elements.detail.scrollTop = 0;
  void loadSimilarSeries(state.activeSeries.seriesUuid);
}

function allEpisodes() {
  return state.activeSeries?.episodes || [];
}

function episodeById(id) {
  return allEpisodes().find((episode) => episode.id === Number(id)) || null;
}

function firstEpisode() {
  return allEpisodes()[0] || null;
}

function updateEpisodeNav() {
  const episodes = allEpisodes();
  const index = episodes.findIndex((episode) => episode.id === state.activeEpisode?.id);
  elements.previousEpisodeButton.disabled = index <= 0;
  elements.nextEpisodeButton.disabled = index < 0 || index >= episodes.length - 1;
}

function restorePlaybackPosition(restart) {
  const episode = state.activeEpisode;
  if (!episode) return;
  if (!restart && hasResumableProgress(episode)) {
    const maximum = Number.isFinite(elements.videoPlayer.duration)
      ? Math.max(0, elements.videoPlayer.duration - 2)
      : episode.progressSeconds;
    elements.videoPlayer.currentTime = Math.min(episode.progressSeconds, maximum);
  } else {
    elements.videoPlayer.currentTime = 0;
  }
}

function resetProgressTracking(episode = null) {
  state.progressPlaybackSinceSave = 0;
  state.progressLastObservedSeconds = null;
  state.progressLastSavedSeconds = episode && Number.isFinite(Number(episode.progressSeconds))
    ? Number(episode.progressSeconds)
    : null;
  state.progressLastSavedDuration = episode && Number.isFinite(Number(episode.durationSeconds))
    ? Number(episode.durationSeconds)
    : null;
  state.progressSaveQueue = Promise.resolve();
}

function observeProgressPlayback() {
  const player = elements.videoPlayer;
  if (state.suppressProgressEvents || !state.playerReady || state.scrubbing || player.paused || player.ended || player.seeking) {
    state.progressLastObservedSeconds = Number.isFinite(player.currentTime) ? player.currentTime : null;
    return;
  }

  const current = Number(player.currentTime);
  if (!Number.isFinite(current)) return;
  const previous = state.progressLastObservedSeconds;
  state.progressLastObservedSeconds = current;
  if (!Number.isFinite(previous)) return;

  const delta = current - previous;
  if (delta > 0 && delta <= PROGRESS_CHECKPOINT_SECONDS * 2) {
    state.progressPlaybackSinceSave += delta;
  }
  if (state.progressPlaybackSinceSave >= PROGRESS_CHECKPOINT_SECONDS) saveProgress(false);
}

function saveProgressOnPageExit() {
  const episode = state.activeEpisode;
  const player = elements.videoPlayer;
  if (!state.playerReady || !episode || !Number.isFinite(player.currentTime)) return;

  const seconds = Number(player.currentTime);
  const durationSeconds = Number.isFinite(player.duration) ? Number(player.duration) : 0;
  const sameSeconds = Number.isFinite(state.progressLastSavedSeconds)
    && Math.abs(seconds - state.progressLastSavedSeconds) < 0.25;
  const sameDuration = Number.isFinite(state.progressLastSavedDuration)
    && Math.abs(durationSeconds - state.progressLastSavedDuration) < 0.25;
  if (sameSeconds && sameDuration) return;

  window.BaiaPage.apiRequest(`/api/movies/${episode.id}/progress`, {
    method: 'PUT',
    body: JSON.stringify({ seconds, durationSeconds }),
    keepalive: true,
  }).catch(() => {});
}

async function startPlayback(episode, { restart = false } = {}) {
  if (!episode) return;
  if (state.activeEpisode && state.activeEpisode.id !== episode.id) await saveProgress(true);
  state.activeEpisode = episode;
  resetProgressTracking(episode);
  state.playerReady = false;
  state.suppressProgressEvents = true;
  clearPlayerControlsTimer();
  elements.playerStage.classList.remove('player-controls-hidden');
  state.scrubbing = false;
  state.resumeAfterScrub = false;
  state.pendingSeekSeconds = null;
  clearTimeout(state.seekTimer);
  state.seekTimer = null;

  elements.playerTitle.textContent = episode.title || `Episodio ${episode.episodeNumber}`;
  elements.playerMeta.textContent = `${state.activeSeries.title} · S${episode.seasonNumber || 1}E${episode.episodeNumber || 1}`;
  elements.detail.hidden = true;
  elements.browse.hidden = true;
  elements.playerView.hidden = false;
  updateEpisodeNav();
  setPlayerLoading(true);
  elements.playerSeek.value = '0';
  elements.playerSeek.max = '0';
  updatePlayerTimeline(0);
  updatePlayPauseControl();
  updateFullscreenControl();
  showPlayerControls({ restartTimer: false });

  elements.videoPlayer.addEventListener('loadedmetadata', async () => {
    restorePlaybackPosition(restart);
    state.playerReady = true;
    state.progressLastObservedSeconds = Number.isFinite(elements.videoPlayer.currentTime)
      ? elements.videoPlayer.currentTime
      : null;
    updatePlayerTimeline();
    try { await elements.videoPlayer.play(); } catch {}
    updatePlayPauseControl();
  }, { once: true });

  elements.videoPlayer.pause();
  elements.videoPlayer.src = await window.BaiaPage.mediaUrl(episode.streamUrl);
  elements.videoPlayer.load();
  state.suppressProgressEvents = false;
}

async function saveProgress(force = false) {
  const episode = state.activeEpisode;
  const player = elements.videoPlayer;
  if (state.suppressProgressEvents || !state.playerReady || !episode || !Number.isFinite(player.currentTime)) return;
  if (!force && state.progressPlaybackSinceSave < PROGRESS_CHECKPOINT_SECONDS) return;

  const episodeId = episode.id;
  const seconds = Number(player.currentTime);
  const durationSeconds = Number.isFinite(player.duration) ? Number(player.duration) : 0;
  state.progressPlaybackSinceSave = 0;
  state.progressLastObservedSeconds = seconds;

  const performSave = async () => {
    const sameSeconds = Number.isFinite(state.progressLastSavedSeconds)
      && Math.abs(seconds - state.progressLastSavedSeconds) < 0.25;
    const sameDuration = Number.isFinite(state.progressLastSavedDuration)
      && Math.abs(durationSeconds - state.progressLastSavedDuration) < 0.25;
    if (sameSeconds && sameDuration) return;

    try {
      const payload = await window.BaiaPage.apiRequest(`/api/movies/${episodeId}/progress`, {
        method: 'PUT',
        body: JSON.stringify({ seconds, durationSeconds }),
      });
      state.progressLastSavedSeconds = payload.progress.seconds;
      state.progressLastSavedDuration = payload.progress.durationSeconds;
      const targetEpisode = state.activeSeries?.episodes?.find((item) => item.id === episodeId) || episode;
      targetEpisode.progressSeconds = payload.progress.seconds;
      targetEpisode.durationSeconds = payload.progress.durationSeconds;
      targetEpisode.completed = payload.progress.completed;
      targetEpisode.lastWatchedAt = new Date().toISOString();
    } catch (error) {
      console.error(error);
      if (!force && state.activeEpisode?.id === episodeId) {
        state.progressPlaybackSinceSave = Math.max(state.progressPlaybackSinceSave, PROGRESS_CHECKPOINT_SECONDS);
      }
    }
  };

  state.progressSaveQueue = state.progressSaveQueue.catch(() => {}).then(performSave);
  return state.progressSaveQueue;
}

async function closePlayer() {
  await saveProgress(true);
  loadHome().catch(handleError);
  if (isPlayerFullscreen()) {
    try { await document.exitFullscreen(); } catch {}
  }
  await releasePlayerWakeLock();
  clearPlayerControlsTimer();
  elements.playerStage.classList.remove('player-controls-hidden');
  state.suppressProgressEvents = true;
  state.scrubbing = false;
  state.resumeAfterScrub = false;
  state.pendingSeekSeconds = null;
  clearTimeout(state.seekTimer);
  state.seekTimer = null;
  setPlayerLoading(false);
  elements.videoPlayer.pause();
  elements.videoPlayer.removeAttribute('src');
  elements.videoPlayer.load();
  state.suppressProgressEvents = false;
  state.playerReady = false;
  resetProgressTracking();
  updatePlayerTimeline(0);
  updatePlayPauseControl();
  state.activeEpisode = null;
  elements.playerView.hidden = true;
  elements.detail.hidden = false;
  renderEpisodes();
  requestAnimationFrame(() => elements.resume.focus({ preventScroll: true }));
}

async function stepEpisode(direction) {
  const episodes = allEpisodes();
  const index = episodes.findIndex((episode) => episode.id === state.activeEpisode?.id);
  const target = episodes[index + direction];
  if (target) await startPlayback(target, { restart: false });
}

function showTouchSeekFeedback(seconds) {
  let feedback = elements.playerStage.querySelector('.touch-seek-feedback');
  if (!feedback) {
    feedback = document.createElement('div');
    feedback.className = 'touch-seek-feedback';
    feedback.setAttribute('aria-hidden', 'true');
    elements.playerStage.appendChild(feedback);
  }
  feedback.textContent = seconds > 0 ? `+${seconds}s` : `${seconds}s`;
  feedback.classList.toggle('left', seconds < 0);
  feedback.classList.toggle('right', seconds > 0);
  feedback.classList.add('visible');
  clearTimeout(state.touchFeedbackTimer);
  state.touchFeedbackTimer = setTimeout(() => feedback.classList.remove('visible'), 520);
}

function handleTouchPlayerTap(event) {
  if (!usesTouchLayout() || event.pointerType === 'mouse' || elements.playerView.hidden || isPlayerControlTarget(event.target)) return;
  event.preventDefault();

  const rect = elements.playerStage.getBoundingClientRect();
  const relativeX = (event.clientX - rect.left) / Math.max(1, rect.width);
  const zone = relativeX < .34 ? 'left' : relativeX > .66 ? 'right' : 'center';
  const now = performance.now();
  const previous = state.touchTap;
  const doubleTap = previous && previous.zone === zone && now - previous.time < 340;

  if (doubleTap) {
    clearTimeout(state.touchTapTimer);
    state.touchTapTimer = null;
    state.touchTap = null;
    if (zone === 'left' || zone === 'right') {
      const seconds = zone === 'left' ? -10 : 10;
      seekBy(seconds);
      showTouchSeekFeedback(seconds);
      showPlayerControls();
    } else {
      togglePlayback();
      showPlayerControls();
    }
    return;
  }

  const controlsWereHidden = elements.playerStage.classList.contains('player-controls-hidden');
  state.touchTap = { zone, time: now };
  clearTimeout(state.touchTapTimer);

  if (controlsWereHidden) {
    showPlayerControls();
    state.touchTapTimer = setTimeout(() => {
      state.touchTap = null;
      state.touchTapTimer = null;
    }, 340);
    return;
  }

  state.touchTapTimer = setTimeout(() => {
    state.touchTap = null;
    state.touchTapTimer = null;
    hidePlayerControls({ force: true });
  }, 300);
}

function handlePlayerSurfacePointerUp(event) {
  if (elements.playerView.hidden || isPlayerControlTarget(event.target)) return;
  if (usesTouchLayout() && event.pointerType !== 'mouse') {
    handleTouchPlayerTap(event);
    return;
  }
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  if (elements.playerStage.classList.contains('player-controls-hidden')) showPlayerControls();
  else hidePlayerControls({ force: true });
}

function handleError(error) {
  window.BaiaPage.shellToast(error.message || 'Operazione non riuscita.');
}

elements.homeButton.addEventListener('click', () => {
  closeFiltersPanel();
  elements.searchInput.value = '';
  showHome().catch(handleError);
});
elements.filtersButton.addEventListener('click', (event) => {
  event.stopPropagation();
  toggleFiltersPanel();
});
elements.filtersPanel.addEventListener('click', (event) => event.stopPropagation());
elements.searchField.addEventListener('click', () => {
  if (state.mode !== 'search') {
    showSearch().catch(handleError);
    return;
  }
  elements.searchInput.focus({ preventScroll: true });
});
elements.searchInput.addEventListener('focus', () => {
  if (state.mode !== 'search') showSearch().catch(handleError);
});
elements.genreButton.addEventListener('click', (event) => {
  event.stopPropagation();
  toggleMenu('genre');
});
elements.yearButton.addEventListener('click', (event) => {
  event.stopPropagation();
  toggleMenu('year');
});
elements.genreMenu.addEventListener('click', (event) => event.stopPropagation());
elements.yearMenu.addEventListener('click', (event) => event.stopPropagation());
for (const input of [elements.genreFilterSearch, elements.yearFilterSearch]) {
  input.addEventListener('input', renderFilterMenus);
  input.addEventListener('keydown', (event) => event.stopPropagation());
}
elements.clearFiltersButton.addEventListener('click', () => clearAllFilters().catch(handleError));
elements.clearYearButton.addEventListener('click', () => selectYear(0).catch(handleError));
elements.searchInput.addEventListener('input', () => {
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => loadSearch().catch(handleError), 160);
});
document.addEventListener('click', (event) => {
  if (state.mode !== 'search') return;

  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest('#searchField')) return;
  if (target.closest('.search-result-button')) return;

  exitSearchMode().catch(handleError);
}, true);
elements.loadMore.addEventListener('click', () => loadSeries({ append: true }).catch(handleError));
document.querySelectorAll('[data-scroll-target]').forEach((button) => {
  button.addEventListener('click', () => {
    const rail = document.querySelector(`#${button.dataset.scrollTarget}`);
    const direction = Number(button.dataset.direction || 1);
    rail?.scrollBy({ left: rail.clientWidth * .82 * direction, behavior: 'smooth' });
  });
});
document.addEventListener('click', closeFiltersPanel);
elements.detailBack.addEventListener('click', () => {
  state.paletteRequest += 1;
  state.similarRequest += 1;
  state.similarSeries = [];
  elements.similarSection.hidden = true;
  elements.similarRail.replaceChildren();
  state.activeSeries = null;
  elements.detail.hidden = true;
  elements.browse.hidden = false;
});
elements.season.addEventListener('change', renderEpisodes);
elements.resume.addEventListener('click', () => startPlayback(episodeById(state.activeSeries?.resumeEpisodeId) || firstEpisode(), { restart: false }).catch(handleError));
elements.restart.addEventListener('click', () => startPlayback(firstEpisode(), { restart: true }).catch(handleError));
elements.closePlayerButton.addEventListener('click', () => closePlayer().catch(handleError));
elements.previousEpisodeButton.addEventListener('click', () => {
  showPlayerControls();
  stepEpisode(-1).catch(handleError);
});
elements.nextEpisodeButton.addEventListener('click', () => {
  showPlayerControls();
  stepEpisode(1).catch(handleError);
});
elements.playPauseButton.addEventListener('click', () => togglePlayback());
elements.fullscreenButton.addEventListener('click', () => toggleFullscreen().catch(handleError));
elements.videoPlayer.addEventListener('loadstart', () => setPlayerLoading(true));
elements.videoPlayer.addEventListener('waiting', () => setPlayerLoading(true, { delayed: true }));
elements.videoPlayer.addEventListener('stalled', () => setPlayerLoading(true, { delayed: true }));
elements.videoPlayer.addEventListener('seeking', () => setPlayerLoading(true, { delayed: true }));
['loadeddata', 'canplay', 'canplaythrough', 'playing', 'seeked', 'ended', 'error', 'abort', 'emptied'].forEach((eventName) => {
  elements.videoPlayer.addEventListener(eventName, () => setPlayerLoading(false));
});
elements.videoPlayer.addEventListener('play', () => {
  state.progressLastObservedSeconds = Number.isFinite(elements.videoPlayer.currentTime)
    ? elements.videoPlayer.currentTime
    : null;
  updatePlayPauseControl();
  syncPlayerControlsVisibility();
  requestPlayerWakeLock();
});
elements.videoPlayer.addEventListener('pause', () => {
  updatePlayPauseControl();
  showPlayerControls({ restartTimer: false });
  releasePlayerWakeLock();
  if (!state.scrubbing) saveProgress(true);
});
elements.videoPlayer.addEventListener('ended', () => {
  updatePlayPauseControl();
  showPlayerControls({ restartTimer: false });
  updatePlayerTimeline();
  releasePlayerWakeLock();
  saveProgress(true);
});
elements.videoPlayer.addEventListener('durationchange', () => updatePlayerTimeline());
elements.videoPlayer.addEventListener('seeked', () => {
  state.progressLastObservedSeconds = Number.isFinite(elements.videoPlayer.currentTime)
    ? elements.videoPlayer.currentTime
    : null;
});
elements.videoPlayer.addEventListener('timeupdate', () => {
  if (!state.scrubbing) updatePlayerTimeline();
  observeProgressPlayback();
});
elements.playerSeek.addEventListener('pointerdown', beginScrubbing);
elements.playerSeek.addEventListener('input', () => {
  beginScrubbing();
  const target = Number(elements.playerSeek.value);
  updatePlayerTimeline(target);
  state.pendingSeekSeconds = target;
  applyQueuedSeek(false);
});
elements.playerSeek.addEventListener('change', () => finishScrubbing().catch(handleError));
elements.playerSeek.addEventListener('pointerup', () => finishScrubbing().catch(handleError));
elements.playerSeek.addEventListener('pointercancel', () => finishScrubbing().catch(handleError));
elements.playerStage.addEventListener('pointermove', (event) => {
  if (event.pointerType === 'touch') return;
  showPlayerControls();
});
elements.playerStage.addEventListener('pointerup', handlePlayerSurfacePointerUp);
elements.playerStage.addEventListener('focusin', () => showPlayerControls());
elements.playerVolume.addEventListener('input', () => {
  setPlayerVolume(elements.playerVolume.value);
  showPlayerVolumeThumb();
  showPlayerControls();
});
document.addEventListener('fullscreenchange', () => {
  updateFullscreenControl();
  syncPlayerControlsVisibility();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    state.progressLastObservedSeconds = Number.isFinite(elements.videoPlayer.currentTime)
      ? elements.videoPlayer.currentTime
      : null;
    requestPlayerWakeLock();
  } else {
    saveProgress(true);
    releasePlayerWakeLock();
  }
});

document.addEventListener('keydown', (event) => {
  if (!elements.playerView.hidden) {
    if (event.code === 'Space') {
      event.preventDefault();
      showPlayerControls();
      togglePlayback();
      return;
    }
    if (event.code === 'ArrowRight') {
      event.preventDefault();
      showPlayerControls();
      seekBy(10);
      return;
    }
    if (event.code === 'ArrowLeft') {
      event.preventDefault();
      showPlayerControls();
      seekBy(-10);
      return;
    }
    if ((event.code === 'ShiftLeft' || event.code === 'ShiftRight') && !event.repeat) {
      event.preventDefault();
      showPlayerControls({ restartTimer: false });
      enterFullscreen();
      return;
    }
    if (event.key === 'Escape' && isPlayerFullscreen()) {
      event.preventDefault();
      document.exitFullscreen().catch(() => {});
    }
    return;
  }
  if (event.key === 'Escape' && !elements.filtersPanel.hidden) {
    event.preventDefault();
    closeFiltersPanel();
    elements.filtersButton.focus({ preventScroll: true });
    return;
  }

  if (event.key === 'Escape' && state.mode === 'search') {
    event.preventDefault();
    exitSearchMode().catch(handleError);
    return;
  }

  if (event.key === 'Escape' && !elements.detail.hidden) {
    event.preventDefault();
    state.paletteRequest += 1;
    state.similarRequest += 1;
    state.similarSeries = [];
    elements.similarSection.hidden = true;
    elements.similarRail.replaceChildren();
    state.activeSeries = null;
    elements.detail.hidden = true;
    elements.browse.hidden = false;
  }
});

window.addEventListener('pagehide', saveProgressOnPageExit);
window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin) return;
  if (event.data?.type === 'shell-page-visibility') {
    if (event.data.active === false && !elements.playerView.hidden) saveProgress(true);
    if (event.data.active === true && !elements.playerView.hidden) {
      state.progressLastObservedSeconds = Number.isFinite(elements.videoPlayer.currentTime)
        ? elements.videoPlayer.currentTime
        : null;
    }
    if (event.data.active && state.mode === 'home' && elements.browse.hidden === false) {
      loadHome().catch(handleError);
    }
  }
  if (event.data?.type === 'library-metadata-updated') {
    Promise.all([
      state.mode === 'home' ? loadHome() : state.mode === 'catalog' ? loadSeries() : loadSearch(),
      loadFilters(),
    ]).catch(handleError);
  }
});
window.addEventListener('resize', syncSeriesViewport, { passive: true });
window.visualViewport?.addEventListener('resize', syncSeriesViewport, { passive: true });
window.visualViewport?.addEventListener('scroll', syncSeriesViewport, { passive: true });
touchLayoutMedia.addEventListener?.('change', syncSeriesViewport);
restorePlayerSettings();
syncSeriesViewport();
setBrowseMode('home');
Promise.all([loadHome(), loadFilters()]).catch(handleError);
