const state = {
  mode: 'home',
  genre: '',
  director: '',
  year: 0,
  filters: { genres: [], directors: [], years: [] },
  home: { recent: [], latest: [], recommended: [] },
  catalog: [],
  catalogTotal: 0,
  catalogLoading: false,
  searchResults: [],
  activeMovie: null,
  searchTimer: null,
  returnScrollY: 0,
  paletteRequest: 0,
  playerReady: false,
  suppressProgressEvents: false,
  scrubbing: false,
  resumeAfterScrub: false,
  pendingSeekSeconds: null,
  seekTimer: null,
  lastSeekAppliedAt: 0,
  similarMovies: [],
  similarRequest: 0,
  controlsHideTimer: null,
  playerLoadingTimer: null,
  volumeThumbTimer: null,
  wakeLockSentinel: null,
  touchTap: null,
  touchTapTimer: null,
  touchFeedbackTimer: null,
  detailSwipe: null,
  progressPlaybackSinceSave: 0,
  progressLastObservedSeconds: null,
  progressLastSavedSeconds: null,
  progressLastSavedDuration: null,
  progressSaveQueue: Promise.resolve(),
};

const TOUCH_LAYOUT_QUERY = '(hover: none) and (pointer: coarse)';
const touchLayoutMedia = window.matchMedia(TOUCH_LAYOUT_QUERY);
const PLAYER_VOLUME_STORAGE_KEY = 'baia-player-volume';
const CATALOG_PAGE_SIZE = 50;
const PROGRESS_CHECKPOINT_SECONDS = 30;

function usesTouchLayout() {
  return touchLayoutMedia.matches;
}

function syncFilmViewport() {
  const viewportHeight = Math.round(window.visualViewport?.height || window.innerHeight || document.documentElement.clientHeight);
  if (viewportHeight > 0) document.documentElement.style.setProperty('--baia-viewport-height', `${viewportHeight}px`);
}

const elements = {
  browseView: document.querySelector('#browseView'),
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
  directorButton: document.querySelector('#directorButton'),
  directorMenu: document.querySelector('#directorMenu'),
  directorFilterSearch: document.querySelector('#directorFilterSearch'),
  directorOptions: document.querySelector('#directorOptions'),
  directorFilterEmpty: document.querySelector('#directorFilterEmpty'),
  yearButton: document.querySelector('#yearButton'),
  yearMenu: document.querySelector('#yearMenu'),
  yearFilterSearch: document.querySelector('#yearFilterSearch'),
  yearOptions: document.querySelector('#yearOptions'),
  yearFilterEmpty: document.querySelector('#yearFilterEmpty'),
  clearFiltersButton: document.querySelector('#clearFiltersButton'),
  homeView: document.querySelector('#homeView'),
  catalogView: document.querySelector('#catalogView'),
  searchView: document.querySelector('#searchView'),
  recentRail: document.querySelector('#recentRail'),
  latestRail: document.querySelector('#latestRail'),
  recommendedRail: document.querySelector('#recommendedRail'),
  recentEmpty: document.querySelector('#recentEmpty'),
  latestEmpty: document.querySelector('#latestEmpty'),
  recommendedEmpty: document.querySelector('#recommendedEmpty'),
  catalogGrid: document.querySelector('#catalogGrid'),
  catalogCount: document.querySelector('#catalogCount'),
  catalogEmpty: document.querySelector('#catalogEmpty'),
  catalogLoadMoreButton: document.querySelector('#catalogLoadMoreButton'),
  clearYearButton: document.querySelector('#clearYearButton'),
  searchInput: document.querySelector('#searchInput'),
  searchCount: document.querySelector('#searchCount'),
  searchResults: document.querySelector('#searchResults'),
  searchEmpty: document.querySelector('#searchEmpty'),
  detailView: document.querySelector('#detailView'),
  detailBackdropImage: document.querySelector('#detailBackdropImage'),
  detailColorWash: document.querySelector('#detailColorWash'),
  detailBackButton: document.querySelector('#detailBackButton'),
  detailTitle: document.querySelector('#detailTitle'),
  detailMeta: document.querySelector('#detailMeta'),
  detailPoster: document.querySelector('#detailPoster'),
  detailPosterFallback: document.querySelector('#detailPosterFallback'),
  similarSection: document.querySelector('#similarSection'),
  similarRail: document.querySelector('#similarRail'),
  resumeButton: document.querySelector('#resumeButton'),
  restartButton: document.querySelector('#restartButton'),
  playerView: document.querySelector('#playerView'),
  playerStage: document.querySelector('.player-stage'),
  playerTopbar: document.querySelector('.player-topbar'),
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
};

function titleInitials(title) {
  return String(title || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
    .map((word) => word.charAt(0).toUpperCase())
    .join('');
}

function progressPercent(movie) {
  if (!movie.durationSeconds) return 0;
  return Math.max(0, Math.min(100, movie.progressSeconds / movie.durationSeconds * 100));
}

function hasResumableProgress(movie) {
  return Boolean(
    movie
    && !movie.completed
    && Number(movie.progressSeconds) > 5
    && (
      !Number(movie.durationSeconds)
      || Number(movie.progressSeconds) < Number(movie.durationSeconds) - 5
    )
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

  if (delayed) {
    state.playerLoadingTimer = window.setTimeout(showLoading, 160);
  } else {
    showLoading();
  }
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
  try {
    await elements.playerView.requestFullscreen();
  } catch (error) {
    console.warn('Schermo intero non disponibile.', error);
  }
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

function movieMeta(movie, { includeDirector = true } = {}) {
  const values = [];
  if (Array.isArray(movie.genres) && movie.genres.length) values.push(movie.genres.join(', '));
  if (movie.year) values.push(String(movie.year));
  if (includeDirector && movie.director) values.push(`Regia: ${movie.director}`);
  return values.join(' · ') || 'Informazioni non disponibili';
}

function movieDetailMeta(movie) {
  const lines = [];
  if (Array.isArray(movie.genres) && movie.genres.length) lines.push(movie.genres.join(', '));
  if (movie.year) lines.push(String(movie.year));
  if (movie.director) lines.push(`Regia: ${movie.director}`);
  return lines.join('\n') || 'Informazioni non disponibili';
}

function createPosterCard(movie, { onSelect = openDetails } = {}) {
  const article = document.createElement('article');
  article.className = 'poster-card';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'poster-card-button';
  button.setAttribute('aria-label', `Apri la scheda di ${movie.title}`);
  button.title = [movie.title, movie.year].filter(Boolean).join(' — ');

  const frame = document.createElement('div');
  frame.className = 'poster-frame';

  const fallback = document.createElement('div');
  fallback.className = 'poster-fallback';
  const fallbackTitle = document.createElement('strong');
  fallbackTitle.textContent = titleInitials(movie.title) || movie.title;
  fallback.appendChild(fallbackTitle);
  frame.appendChild(fallback);

  if (movie.posterUrl) {
    const image = document.createElement('img');
    image.className = 'poster-image';
    window.BaiaPage.setMediaSrc(image, movie.posterUrl);
    image.alt = '';
    image.loading = 'lazy';
    image.addEventListener('error', () => image.remove(), { once: true });
    frame.appendChild(image);
  }

  const shade = document.createElement('div');
  shade.className = 'poster-shade';
  frame.appendChild(shade);

  const caption = document.createElement('div');
  caption.className = 'poster-caption';
  const title = document.createElement('strong');
  title.textContent = movie.title;
  caption.appendChild(title);
  const meta = [movie.year, movie.genres?.[0]].filter(Boolean).join(' · ');
  if (meta) {
    const metaElement = document.createElement('span');
    metaElement.textContent = meta;
    caption.appendChild(metaElement);
  }
  frame.appendChild(caption);

  const percent = progressPercent(movie);
  if (percent > 0 && !movie.completed) {
    const track = document.createElement('div');
    track.className = 'progress-track';
    const bar = document.createElement('div');
    bar.className = 'progress-bar';
    bar.style.width = `${percent}%`;
    track.appendChild(bar);
    frame.appendChild(track);
  }

  button.appendChild(frame);
  button.addEventListener('click', () => onSelect(movie));
  article.appendChild(button);
  return article;
}

function renderRail(container, emptyElement, movies) {
  container.replaceChildren(...movies.map((movie) => createPosterCard(movie)));
  emptyElement.hidden = movies.length !== 0;
  container.closest('.showcase-shell').hidden = movies.length === 0;
}

function renderCatalog() {
  elements.catalogGrid.replaceChildren(...state.catalog.map((movie) => createPosterCard(movie)));
  elements.catalogCount.textContent = state.catalogTotal === 1
    ? '1 film'
    : `${state.catalogTotal} film`;
  elements.catalogEmpty.hidden = state.catalogTotal !== 0 || state.catalogLoading;
  elements.catalogGrid.hidden = state.catalogTotal === 0;
  elements.catalogLoadMoreButton.hidden = state.catalog.length >= state.catalogTotal || state.catalogTotal === 0;
  elements.catalogLoadMoreButton.disabled = state.catalogLoading;
  elements.catalogLoadMoreButton.textContent = state.catalogLoading ? 'Caricamento…' : 'Mostra altro';
  elements.clearYearButton.hidden = !state.year;
  elements.clearYearButton.textContent = state.year ? String(state.year) : '';
}

function createSearchResult(movie) {
  const item = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'search-result-button';

  const title = document.createElement('span');
  title.className = 'search-result-title';
  title.textContent = movie.title;

  const meta = document.createElement('span');
  meta.className = 'search-result-meta';
  meta.textContent = [movie.year, ...(movie.genres || []).slice(0, 2)].filter(Boolean).join(' · ');

  button.append(title, meta);
  button.addEventListener('click', () => openDetails(movie));
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
  const activeFilterCount = [state.genre, state.director, state.year].filter(Boolean).length;
  // In ricerca la Home resta dietro al pannello glass e viene sfocata via CSS.
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
  elements.directorButton.classList.toggle('has-filter', Boolean(state.director));
  elements.yearButton.classList.toggle('has-filter', Boolean(state.year));
  elements.pageTitle.textContent = state.genre || state.director || 'Film';
  elements.directorButton.title = state.director || 'Filtra per regista';
  elements.yearButton.textContent = state.year ? String(state.year) : 'Anno';
  elements.clearFiltersButton.disabled = !(state.genre || state.director || state.year);
  if (searchOpen) closeFiltersPanel();
  else closeMenus();
}

function closeMenus() {
  for (const [button, menu] of [
    [elements.genreButton, elements.genreMenu],
    [elements.directorButton, elements.directorMenu],
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
    director: [elements.directorButton, elements.directorMenu, elements.directorFilterSearch],
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
    container: elements.directorOptions,
    emptyElement: elements.directorFilterEmpty,
    values: state.filters.directors,
    query: elements.directorFilterSearch.value,
    allLabel: 'Tutti i registi',
    allValue: '',
    selectedValue: state.director,
    onSelect: selectDirector,
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
    directors: Array.isArray(filters.directors) ? filters.directors : [],
    years: Array.isArray(filters.years) ? filters.years : [],
  };
  renderFilterMenus();
}

async function loadFilters() {
  const params = new URLSearchParams();
  if (state.genre) params.set('genre', state.genre);
  if (state.director) params.set('director', state.director);
  if (state.year) params.set('year', String(state.year));
  const query = params.toString();
  const suffix = query ? `?${query}` : '';
  const filters = await window.BaiaPage.apiRequest(`/api/movies/filters${suffix}`);
  renderFilters(filters);
}

async function loadHome() {
  const payload = await window.BaiaPage.apiRequest('/api/movies/home');
  state.home = payload;
  renderRail(elements.recentRail, elements.recentEmpty, payload.recent || []);
  renderRail(elements.latestRail, elements.latestEmpty, payload.latest || []);
  renderRail(elements.recommendedRail, elements.recommendedEmpty, payload.recommended || []);
}

async function loadCatalog({ append = false } = {}) {
  if (state.catalogLoading) return;
  state.catalogLoading = true;
  renderCatalog();

  const params = new URLSearchParams({
    type: 'movie',
    limit: String(CATALOG_PAGE_SIZE),
    offset: String(append ? state.catalog.length : 0),
  });
  if (state.genre) params.set('genre', state.genre);
  if (state.director) params.set('director', state.director);
  if (state.year) params.set('year', String(state.year));

  try {
    const payload = await window.BaiaPage.apiRequest(`/api/movies?${params}`);
    const incoming = Array.isArray(payload.movies) ? payload.movies : [];
    state.catalog = append ? [...state.catalog, ...incoming] : incoming;
    state.catalogTotal = Number(payload.count || 0);
  } finally {
    state.catalogLoading = false;
    renderCatalog();
  }
}

async function loadSearch() {
  const params = new URLSearchParams({
    type: 'movie',
    search: elements.searchInput.value.trim(),
  });
  const payload = await window.BaiaPage.apiRequest(`/api/movies?${params}`);
  state.searchResults = payload.movies;
  renderSearchResults();
}

async function showHome() {
  state.genre = '';
  state.director = '';
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
  await Promise.all([loadCatalog(), loadFilters()]);
}

async function selectDirector(value) {
  state.director = String(value || '');
  setBrowseMode('catalog');
  await Promise.all([loadCatalog(), loadFilters()]);
}

async function selectYear(value) {
  state.year = Number(value) || 0;
  setBrowseMode('catalog');
  await Promise.all([loadCatalog(), loadFilters()]);
}

async function clearAllFilters() {
  if (!(state.genre || state.director || state.year)) return;
  state.genre = '';
  state.director = '';
  state.year = 0;
  setBrowseMode('catalog');
  await Promise.all([loadCatalog(), loadFilters()]);
}

function updateMovieEverywhere(updatedMovie) {
  const updateList = (list) => list.forEach((movie) => {
    if (movie.id === updatedMovie.id) Object.assign(movie, updatedMovie);
  });
  updateList(state.home.recent);
  updateList(state.home.recommended);
  updateList(state.catalog);
  updateList(state.searchResults);
  if (state.activeMovie?.id === updatedMovie.id) Object.assign(state.activeMovie, updatedMovie);
}

function renderSimilarMovies(movies) {
  state.similarMovies = movies;
  elements.similarRail.replaceChildren(...movies.map((movie) => createPosterCard(movie, {
    onSelect: (selectedMovie) => openDetails(selectedMovie, { preserveReturnPosition: true }),
  })));
  elements.similarSection.hidden = movies.length === 0;
}

async function loadSimilarMovies(movieId) {
  const request = ++state.similarRequest;
  elements.similarSection.hidden = true;
  elements.similarRail.replaceChildren();

  try {
    const payload = await window.BaiaPage.apiRequest(`/api/movies/${movieId}/similar`);
    if (request !== state.similarRequest || state.activeMovie?.id !== movieId) return;
    renderSimilarMovies(Array.isArray(payload.movies) ? payload.movies : []);
  } catch (error) {
    if (request !== state.similarRequest || state.activeMovie?.id !== movieId) return;
    renderSimilarMovies([]);
    console.error(error);
  }
}

function setDetailPoster(movie) {
  elements.detailPoster.alt = `Copertina di ${movie.title}`;
  elements.detailPosterFallback.textContent = titleInitials(movie.title) || movie.title;

  if (!movie.posterUrl) {
    elements.detailPoster.hidden = true;
    elements.detailPoster.removeAttribute('src');
    elements.detailPosterFallback.hidden = false;
    elements.detailBackdropImage.hidden = true;
    elements.detailBackdropImage.removeAttribute('src');
    return;
  }

  elements.detailPosterFallback.hidden = true;
  elements.detailPoster.hidden = false;
  window.BaiaPage.setMediaSrc(elements.detailPoster, movie.posterUrl);
  elements.detailPoster.onerror = () => {
    elements.detailPoster.hidden = true;
    elements.detailPosterFallback.hidden = false;
  };

  elements.detailBackdropImage.hidden = false;
  window.BaiaPage.setMediaSrc(elements.detailBackdropImage, movie.posterUrl);
  elements.detailBackdropImage.onerror = () => {
    elements.detailBackdropImage.hidden = true;
  };
}

const DETAIL_FALLBACK_PALETTE = window.BaiaMediaPalette?.DEFAULT_PALETTE || Object.freeze({
  base: [22, 25, 19],
  primary: [108, 139, 72],
  secondary: [55, 95, 130],
  accentA: [164, 88, 72],
  accentB: [126, 103, 176],
});

async function extractPosterPalette(url) {
  if (!window.BaiaMediaPalette) return DETAIL_FALLBACK_PALETTE;
  const mediaUrl = await window.BaiaPage.mediaUrl(url);
  return window.BaiaMediaPalette.extractFromUrl(mediaUrl, {
    width: 72,
    height: 104,
    crossOrigin: 'anonymous',
  });
}

function applyDetailPalette(palette = DETAIL_FALLBACK_PALETTE) {
  if (window.BaiaMediaPalette) {
    window.BaiaMediaPalette.applyCssVariables(elements.detailView, palette, 'detail-color');
    return;
  }
  elements.detailView.style.setProperty('--detail-color-base', palette.base.join(', '));
  elements.detailView.style.setProperty('--detail-color-a', palette.primary.join(', '));
  elements.detailView.style.setProperty('--detail-color-b', palette.secondary.join(', '));
  elements.detailView.style.setProperty('--detail-color-c', palette.accentA.join(', '));
  elements.detailView.style.setProperty('--detail-color-d', palette.accentB.join(', '));
}

async function applyPosterPalette(movie) {
  const request = ++state.paletteRequest;
  let palette = DETAIL_FALLBACK_PALETTE;

  if (movie.posterUrl) {
    try {
      palette = await extractPosterPalette(movie.posterUrl);
    } catch {
      palette = DETAIL_FALLBACK_PALETTE;
    }
  }

  if (request !== state.paletteRequest || state.activeMovie?.id !== movie.id) return;
  applyDetailPalette(palette);
}

function updateDetailActions() {
  elements.resumeButton.textContent = hasResumableProgress(state.activeMovie) ? 'Riprendi' : 'Riproduci';
}

function renderDetail(movie) {
  elements.detailTitle.textContent = movie.title;
  elements.detailMeta.textContent = movieDetailMeta(movie);
  setDetailPoster(movie);
  updateDetailActions();
  applyPosterPalette(movie);
}

function openDetails(movie, { preserveReturnPosition = false } = {}) {
  if (!preserveReturnPosition) state.returnScrollY = window.scrollY;
  state.activeMovie = movie;
  renderDetail(movie);
  elements.browseView.hidden = true;
  elements.playerView.hidden = true;
  elements.detailView.hidden = false;
  document.body.classList.add('film-overlay-open');
  elements.detailView.scrollTop = 0;
  loadSimilarMovies(movie.id);
  requestAnimationFrame(() => elements.detailBackButton.focus({ preventScroll: true }));
}

async function refreshCurrentView() {
  if (state.mode === 'home') await loadHome();
  else if (state.mode === 'catalog') await loadCatalog();
  else if (state.mode === 'search') await loadSearch();
}

async function returnToBrowse() {
  const scrollY = state.returnScrollY;
  elements.detailView.hidden = true;
  elements.playerView.hidden = true;
  elements.browseView.hidden = false;
  document.body.classList.remove('film-overlay-open');
  state.paletteRequest += 1;
  state.similarRequest += 1;
  state.similarMovies = [];
  elements.similarSection.hidden = true;
  elements.similarRail.replaceChildren();
  state.activeMovie = null;

  try {
    await refreshCurrentView();
  } catch (error) {
    window.BaiaPage.shellToast(error.message);
  }
  requestAnimationFrame(() => window.scrollTo({ top: scrollY, behavior: 'instant' }));
}

function restorePlaybackPosition(restart) {
  const movie = state.activeMovie;
  if (!movie) return;

  if (!restart && hasResumableProgress(movie)) {
    const maximum = Number.isFinite(elements.videoPlayer.duration)
      ? Math.max(0, elements.videoPlayer.duration - 2)
      : movie.progressSeconds;
    elements.videoPlayer.currentTime = Math.min(movie.progressSeconds, maximum);
  } else {
    elements.videoPlayer.currentTime = 0;
  }
}

function resetProgressTracking(movie = null) {
  state.progressPlaybackSinceSave = 0;
  state.progressLastObservedSeconds = null;
  state.progressLastSavedSeconds = movie && Number.isFinite(Number(movie.progressSeconds))
    ? Number(movie.progressSeconds)
    : null;
  state.progressLastSavedDuration = movie && Number.isFinite(Number(movie.durationSeconds))
    ? Number(movie.durationSeconds)
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
  const movie = state.activeMovie;
  const player = elements.videoPlayer;
  if (!state.playerReady || !movie || !Number.isFinite(player.currentTime)) return;

  const seconds = Number(player.currentTime);
  const durationSeconds = Number.isFinite(player.duration) ? Number(player.duration) : 0;
  const sameSeconds = Number.isFinite(state.progressLastSavedSeconds)
    && Math.abs(seconds - state.progressLastSavedSeconds) < 0.25;
  const sameDuration = Number.isFinite(state.progressLastSavedDuration)
    && Math.abs(durationSeconds - state.progressLastSavedDuration) < 0.25;
  if (sameSeconds && sameDuration) return;

  window.BaiaPage.apiRequest(`/api/movies/${movie.id}/progress`, {
    method: 'PUT',
    body: JSON.stringify({ seconds, durationSeconds }),
    keepalive: true,
  }).catch(() => {});
}

async function startPlayback({ restart = false } = {}) {
  const movie = state.activeMovie;
  if (!movie) return;

  resetProgressTracking(movie);
  state.playerReady = false;
  state.suppressProgressEvents = true;
  clearPlayerControlsTimer();
  elements.playerStage.classList.remove('player-controls-hidden');
  state.scrubbing = false;
  state.resumeAfterScrub = false;
  state.pendingSeekSeconds = null;
  clearTimeout(state.seekTimer);
  state.seekTimer = null;
  elements.playerTitle.textContent = movie.title;
  elements.playerMeta.textContent = movieMeta(movie);
  elements.detailView.hidden = true;
  elements.playerView.hidden = false;
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
  elements.videoPlayer.src = await window.BaiaPage.mediaUrl(movie.streamUrl);
  elements.videoPlayer.load();
  state.suppressProgressEvents = false;
}

async function saveProgress(force = false) {
  const movie = state.activeMovie;
  const player = elements.videoPlayer;
  if (state.suppressProgressEvents || !state.playerReady || !movie || !Number.isFinite(player.currentTime)) return;
  if (!force && state.progressPlaybackSinceSave < PROGRESS_CHECKPOINT_SECONDS) return;

  const movieId = movie.id;
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
      const payload = await window.BaiaPage.apiRequest(`/api/movies/${movieId}/progress`, {
        method: 'PUT',
        body: JSON.stringify({ seconds, durationSeconds }),
      });
      state.progressLastSavedSeconds = payload.progress.seconds;
      state.progressLastSavedDuration = payload.progress.durationSeconds;
      const updated = {
        progressSeconds: payload.progress.seconds,
        durationSeconds: payload.progress.durationSeconds,
        completed: payload.progress.completed,
        lastWatchedAt: new Date().toISOString(),
      };
      updateMovieEverywhere({ id: movieId, ...updated });
    } catch (error) {
      console.error(error);
      if (!force && state.activeMovie?.id === movieId) {
        state.progressPlaybackSinceSave = Math.max(state.progressPlaybackSinceSave, PROGRESS_CHECKPOINT_SECONDS);
      }
    }
  };

  state.progressSaveQueue = state.progressSaveQueue.catch(() => {}).then(performSave);
  return state.progressSaveQueue;
}

async function closePlayer() {
  await saveProgress(true);
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
  elements.playerView.hidden = true;
  elements.detailView.hidden = false;
  updateDetailActions();
  requestAnimationFrame(() => elements.resumeButton.focus({ preventScroll: true }));
}

async function refreshActiveMovie() {
  if (!state.activeMovie) return;
  const payload = await window.BaiaPage.apiRequest(`/api/movies/${state.activeMovie.id}`);
  state.activeMovie = payload.movie;
  updateMovieEverywhere(payload.movie);
  renderDetail(payload.movie);
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

function beginDetailSwipe(event) {
  if (!usesTouchLayout() || event.pointerType === 'mouse' || elements.detailView.hidden) return;
  if (event.clientX > 72 || event.target.closest('button, input, .poster-rail')) return;
  state.detailSwipe = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
}

function finishDetailSwipe(event) {
  const swipe = state.detailSwipe;
  state.detailSwipe = null;
  if (!swipe || swipe.pointerId !== event.pointerId || elements.detailView.hidden) return;
  const deltaX = event.clientX - swipe.x;
  const deltaY = event.clientY - swipe.y;
  if (deltaX > 90 && Math.abs(deltaX) > Math.abs(deltaY) * 1.35) {
    returnToBrowse().catch(handleError);
  }
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
elements.directorButton.addEventListener('click', (event) => {
  event.stopPropagation();
  toggleMenu('director');
});
elements.yearButton.addEventListener('click', (event) => {
  event.stopPropagation();
  toggleMenu('year');
});
elements.genreMenu.addEventListener('click', (event) => event.stopPropagation());
elements.directorMenu.addEventListener('click', (event) => event.stopPropagation());
elements.yearMenu.addEventListener('click', (event) => event.stopPropagation());
for (const input of [elements.genreFilterSearch, elements.directorFilterSearch, elements.yearFilterSearch]) {
  input.addEventListener('input', renderFilterMenus);
  input.addEventListener('keydown', (event) => event.stopPropagation());
}
elements.clearFiltersButton.addEventListener('click', () => clearAllFilters().catch(handleError));
elements.clearYearButton.addEventListener('click', () => selectYear(0).catch(handleError));
elements.catalogLoadMoreButton.addEventListener('click', () => loadCatalog({ append: true }).catch(handleError));
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

document.querySelectorAll('[data-scroll-target]').forEach((button) => {
  button.addEventListener('click', () => {
    const rail = document.querySelector(`#${button.dataset.scrollTarget}`);
    const direction = Number(button.dataset.direction) || 1;
    rail?.scrollBy({ left: rail.clientWidth * .82 * direction, behavior: 'smooth' });
  });
});
document.addEventListener('click', closeFiltersPanel);
elements.detailBackButton.addEventListener('click', () => returnToBrowse().catch(handleError));
elements.detailView.addEventListener('pointerdown', beginDetailSwipe);
elements.detailView.addEventListener('pointerup', finishDetailSwipe);
elements.detailView.addEventListener('pointercancel', () => { state.detailSwipe = null; });
elements.resumeButton.addEventListener('click', () => startPlayback({ restart: false }).catch(handleError));
elements.restartButton.addEventListener('click', () => startPlayback({ restart: true }).catch(handleError));
elements.closePlayerButton.addEventListener('click', () => closePlayer().catch(handleError));
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

  if (event.key === 'Escape' && !elements.detailView.hidden) {
    event.preventDefault();
    returnToBrowse().catch(handleError);
  }
});

window.addEventListener('pagehide', saveProgressOnPageExit);
window.addEventListener('resize', syncFilmViewport, { passive: true });
window.addEventListener('orientationchange', () => {
  closeFiltersPanel();
  requestAnimationFrame(syncFilmViewport);
});
window.visualViewport?.addEventListener('resize', syncFilmViewport, { passive: true });
window.visualViewport?.addEventListener('scroll', syncFilmViewport, { passive: true });
touchLayoutMedia.addEventListener?.('change', syncFilmViewport);
restorePlayerSettings();
syncFilmViewport();

window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin) return;
  if (event.data?.type === 'shell-page-visibility') {
    if (event.data.active === false && !elements.playerView.hidden) saveProgress(true);
    if (event.data.active === true && !elements.playerView.hidden) {
      state.progressLastObservedSeconds = Number.isFinite(elements.videoPlayer.currentTime)
        ? elements.videoPlayer.currentTime
        : null;
    }
    if (event.data.active && state.mode === 'home' && elements.browseView.hidden === false) {
      loadHome().catch(handleError);
    }
  }
  if (event.data?.type === 'library-metadata-updated') {
    Promise.all([
      refreshCurrentView(),
      state.activeMovie ? refreshActiveMovie() : Promise.resolve(),
      loadFilters(),
    ]).catch(handleError);
  }
});

Promise.all([loadFilters(), loadHome()]).catch(handleError);
