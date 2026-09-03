const pageConfig = {
  mediaType: document.body.dataset.mediaType || 'movie',
  emptyTitle: document.body.dataset.emptyTitle || 'Nessun contenuto indicizzato',
};

const state = {
  movies: [],
  activeMovie: null,
  searchTimer: null,
  favoritesOnly: false,
};

const elements = {
  movieGrid: document.querySelector('#movieGrid'),
  continueGrid: document.querySelector('#continueGrid'),
  continueSection: document.querySelector('#continueSection'),
  movieCount: document.querySelector('#movieCount'),
  emptyState: document.querySelector('#emptyState'),
  emptyTitle: document.querySelector('#emptyTitle'),
  searchInput: document.querySelector('#searchInput'),
  favoritesButton: document.querySelector('#favoritesButton'),
  playerDialog: document.querySelector('#playerDialog'),
  playerTitle: document.querySelector('#playerTitle'),
  playerMeta: document.querySelector('#playerMeta'),
  videoPlayer: document.querySelector('#videoPlayer'),
  closePlayerButton: document.querySelector('#closePlayerButton'),
  compatibilityNotice: document.querySelector('#compatibilityNotice'),
};

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** index)).toFixed(index >= 3 ? 1 : 0)} ${units[index]}`;
}
function initials(title) {
  return String(title || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((word) => word.charAt(0).toUpperCase())
    .join('');
}
function progressPercent(movie) {
  if (!movie.durationSeconds) return 0;
  return Math.max(0, Math.min(100, movie.progressSeconds / movie.durationSeconds * 100));
}
function episodeLabel(movie) {
  if (movie.mediaType !== 'series') return '';
  const season = movie.seasonNumber ? `S${String(movie.seasonNumber).padStart(2, '0')}` : '';
  const episode = movie.episodeNumber ? `E${String(movie.episodeNumber).padStart(2, '0')}` : '';
  return `${season}${episode}`;
}

function createMovieCard(movie) {
  const article = document.createElement('article');
  article.className = 'movie-card';
  const percent = progressPercent(movie);
  const seriesInfo = movie.mediaType === 'series'
    ? `<p class="movie-series">${escapeHtml(movie.seriesTitle || 'Serie')} ${escapeHtml(episodeLabel(movie))}</p>`
    : '';

  article.innerHTML = `
    <button class="favorite-button ${movie.favorite ? 'active' : ''}" type="button" aria-label="Preferito">
      <span class="catalog-icon favorite-icon" aria-hidden="true"></span>
    </button>
    <button class="poster-button" type="button" aria-label="Riproduci ${escapeHtml(movie.title)}">
      <div class="poster">
        <span class="poster-initials">${escapeHtml(initials(movie.seriesTitle || movie.title))}</span>
        <span class="play-badge"><span class="catalog-icon play-icon" aria-hidden="true"></span></span>
      </div>
      <div class="movie-info">
        <p class="movie-title" title="${escapeHtml(movie.title)}">${escapeHtml(movie.title)}</p>
        ${seriesInfo}
        <div class="movie-meta">
          <span>${escapeHtml(movie.year || movie.extension.replace('.', '').toUpperCase())}</span>
          <span>${escapeHtml(formatBytes(movie.sizeBytes))}</span>
        </div>
        ${percent > 0 && !movie.completed ? `<div class="progress-track"><div class="progress-bar" style="width:${percent}%"></div></div>` : ''}
      </div>
    </button>
  `;

  article.querySelector('.poster-button').addEventListener('click', () => openPlayer(movie));
  article.querySelector('.favorite-button').addEventListener('click', (event) => {
    event.stopPropagation();
    toggleFavorite(movie);
  });
  return article;
}

function renderMovies() {
  elements.movieGrid.replaceChildren(...state.movies.map(createMovieCard));
  elements.movieCount.textContent = state.movies.length === 1 ? '1 titolo' : `${state.movies.length} titoli`;
  elements.emptyState.hidden = state.movies.length !== 0;
  elements.emptyTitle.textContent = pageConfig.emptyTitle;

  const continueMovies = state.movies
    .filter((movie) => movie.progressSeconds > 10 && !movie.completed)
    .sort((a, b) => b.progressSeconds - a.progressSeconds);
  elements.continueSection.hidden = continueMovies.length === 0;
  elements.continueGrid.replaceChildren(...continueMovies.map(createMovieCard));
}

async function loadMovies() {
  const params = new URLSearchParams({
    type: pageConfig.mediaType,
    search: elements.searchInput.value.trim(),
  });
  if (state.favoritesOnly) params.set('favorite', '1');
  const payload = await window.BaiaPage.apiRequest(`/api/movies?${params}`);
  state.movies = payload.movies;
  renderMovies();
}

async function toggleFavorite(movie) {
  try {
    const payload = await window.BaiaPage.apiRequest(`/api/movies/${movie.id}/favorite`, {
      method: 'PUT',
      body: JSON.stringify({ favorite: !movie.favorite }),
    });
    movie.favorite = payload.favorite;
    if (state.favoritesOnly && !movie.favorite) {
      state.movies = state.movies.filter((item) => item.id !== movie.id);
    }
    renderMovies();
  } catch (error) {
    window.BaiaPage.shellToast(error.message);
  }
}

async function openPlayer(movie) {
  state.activeMovie = movie;
  elements.playerTitle.textContent = movie.title;
  const meta = [movie.seriesTitle, episodeLabel(movie), movie.year, movie.extension.replace('.', '').toUpperCase()].filter(Boolean);
  elements.playerMeta.textContent = meta.join(' · ');
  elements.compatibilityNotice.hidden = !['.mkv', '.avi', '.mpeg', '.mpg'].includes(movie.extension);
  elements.videoPlayer.src = await window.BaiaPage.mediaUrl(movie.streamUrl);
  elements.playerDialog.showModal();
  elements.videoPlayer.addEventListener('loadedmetadata', restoreProgress, { once: true });
  try { await elements.videoPlayer.play(); } catch {}
}
function restoreProgress() {
  const movie = state.activeMovie;
  if (!movie || movie.completed) return;
  if (movie.progressSeconds > 5 && movie.progressSeconds < elements.videoPlayer.duration - 5) {
    elements.videoPlayer.currentTime = movie.progressSeconds;
  }
}
async function saveProgress(force = false) {
  const movie = state.activeMovie;
  const player = elements.videoPlayer;
  if (!movie || !Number.isFinite(player.currentTime)) return;
  if (!force && Date.now() - (saveProgress.lastSavedAt || 0) < 5000) return;
  saveProgress.lastSavedAt = Date.now();
  try {
    const payload = await window.BaiaPage.apiRequest(`/api/movies/${movie.id}/progress`, {
      method: 'PUT',
      body: JSON.stringify({
        seconds: player.currentTime,
        durationSeconds: Number.isFinite(player.duration) ? player.duration : 0,
      }),
    });
    Object.assign(movie, {
      progressSeconds: payload.progress.seconds,
      durationSeconds: payload.progress.durationSeconds,
      completed: payload.progress.completed,
    });
  } catch (error) { console.error(error); }
}
async function closePlayer() {
  await saveProgress(true);
  elements.videoPlayer.pause();
  elements.videoPlayer.removeAttribute('src');
  elements.videoPlayer.load();
  state.activeMovie = null;
  if (elements.playerDialog.open) elements.playerDialog.close();
  renderMovies();
}

elements.searchInput.addEventListener('input', () => {
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => loadMovies().catch((error) => window.BaiaPage.shellToast(error.message)), 180);
});
elements.favoritesButton.addEventListener('click', () => {
  state.favoritesOnly = !state.favoritesOnly;
  elements.favoritesButton.classList.toggle('active', state.favoritesOnly);
  elements.favoritesButton.textContent = state.favoritesOnly ? 'Tutti i titoli' : 'Preferiti';
  loadMovies().catch((error) => window.BaiaPage.shellToast(error.message));
});
elements.closePlayerButton.addEventListener('click', closePlayer);
elements.playerDialog.addEventListener('cancel', (event) => { event.preventDefault(); closePlayer(); });
elements.playerDialog.addEventListener('click', (event) => { if (event.target === elements.playerDialog) closePlayer(); });
elements.videoPlayer.addEventListener('timeupdate', () => saveProgress(false));
elements.videoPlayer.addEventListener('ended', () => saveProgress(true));
window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin) return;
  if (event.data?.type === 'shell-page-visibility' && event.data.active === false && state.activeMovie) {
    saveProgress(true);
    elements.videoPlayer.pause();
  }
  if (event.data?.type === 'library-metadata-updated') {
    loadMovies().catch((error) => window.BaiaPage.shellToast(error.message));
  }
});
window.addEventListener('beforeunload', () => {
  if (!state.activeMovie) return;
  const payload = JSON.stringify({
    seconds: elements.videoPlayer.currentTime || 0,
    durationSeconds: Number.isFinite(elements.videoPlayer.duration) ? elements.videoPlayer.duration : 0,
  });
  window.BaiaPage.apiRequest(`/api/movies/${state.activeMovie.id}/progress`, {
    method: 'PUT',
    body: payload,
    keepalive: true,
  }).catch(() => {});
});

loadMovies().catch((error) => window.BaiaPage.shellToast(error.message));
