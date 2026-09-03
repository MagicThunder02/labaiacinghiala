const elements = {
  form: document.querySelector('#movieUploadForm'),
  videoInput: document.querySelector('#videoInput'),
  videoFileName: document.querySelector('#videoFileName'),
  videoFileInfo: document.querySelector('#videoFileInfo'),
  videoPicker: document.querySelector('.video-picker'),
  posterInput: document.querySelector('#posterInput'),
  posterFileName: document.querySelector('#posterFileName'),
  posterPreview: document.querySelector('#posterPreview'),
  posterFallback: document.querySelector('#posterFallback'),
  posterPicker: document.querySelector('.poster-picker'),
  title: document.querySelector('#titleInput'),
  year: document.querySelector('#yearInput'),
  director: document.querySelector('#directorInput'),
  genre: document.querySelector('#genreInput'),
  destinationFileName: document.querySelector('#destinationFileName'),
  movieDestination: document.querySelector('#movieDestination'),
  uploadButton: document.querySelector('#uploadButton'),
  resetButton: document.querySelector('#resetButton'),
  progress: document.querySelector('#uploadProgress'),
  progressBar: document.querySelector('#progressBar'),
  progressLabel: document.querySelector('#progressLabel'),
  progressPercent: document.querySelector('#progressPercent'),
  message: document.querySelector('#uploadMessage'),
  totalItems: document.querySelector('#totalItems'),
  movieItems: document.querySelector('#movieItems'),
  seriesItems: document.querySelector('#seriesItems'),
  totalSize: document.querySelector('#totalSize'),
  storageStatus: document.querySelector('#storageStatus'),
  storageDetail: document.querySelector('#storageDetail'),
  unavailableItems: document.querySelector('#unavailableItems'),
  supportedFormats: document.querySelector('#supportedFormats'),
};

const state = {
  uploading: false,
  posterObjectUrl: null,
  nativeVideo: null,
  nativePoster: null,
  moviePath: '',
  maxVideoBytes: 0,
  maxPosterBytes: 6 * 1024 * 1024,
};

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const digits = index >= 3 ? 1 : 0;
  return `${(bytes / (1024 ** index)).toFixed(digits)} ${units[index]}`;
}


function sanitizeFileStem(value) {
  let stem = String(value || '')
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' - ')
    .replace(/\s+-\s+/g, ' - ')
    .replace(/\s+/g, ' ')
    .replace(/-{2,}/g, '-')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 180)
    .trim();
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) stem = `_${stem}`;
  return stem;
}

function nativeUploadsEnabled() {
  return Boolean(window.BaiaPage.nativeUploadAvailable?.());
}

function releaseNativeTokens(tokens) {
  const values = (tokens || []).filter(Boolean);
  if (values.length) void window.BaiaPage.releaseNativeUploadFiles(values).catch(() => {});
}

function movieVideoSelection() {
  return nativeUploadsEnabled() ? state.nativeVideo : elements.videoInput.files?.[0] || null;
}

function moviePosterSelection() {
  return nativeUploadsEnabled() ? state.nativePoster : elements.posterInput.files?.[0] || null;
}

function videoExtension() {
  const file = movieVideoSelection();
  const match = file?.name?.match(/(\.[^.]+)$/);
  return match ? match[1].toLowerCase() : '';
}

function renderDestinationPreview() {
  const title = sanitizeFileStem(elements.title.value.trim());
  const extension = videoExtension();
  elements.destinationFileName.textContent = title
    ? `${title}${extension || '.[formato video]'}`
    : 'Il nome verrà generato dal titolo';
  elements.movieDestination.textContent = state.moviePath || 'Cartella Film';
}

function clearPosterPreview() {
  if (state.posterObjectUrl) URL.revokeObjectURL(state.posterObjectUrl);
  state.posterObjectUrl = null;
  elements.posterPreview.hidden = true;
  elements.posterPreview.removeAttribute('src');
  elements.posterFallback.hidden = false;
}

function showMessage(message, isError = false) {
  if (!message) {
    elements.message.hidden = true;
    elements.message.textContent = '';
    elements.message.classList.remove('error');
    return;
  }
  elements.message.textContent = message;
  elements.message.classList.toggle('error', isError);
  elements.message.hidden = false;
}

function formIsComplete() {
  const video = movieVideoSelection();
  const poster = moviePosterSelection();
  return Boolean(
    video
    && poster
    && elements.title.value.trim()
    && elements.genre.value.trim()
    && elements.director.value.trim()
    && elements.year.value
    && elements.form.checkValidity()
  );
}

function updateFormState() {
  elements.uploadButton.disabled = state.uploading || !formIsComplete();
  elements.resetButton.disabled = state.uploading;
  renderDestinationPreview();
}

function resetUploadForm({ preserveMessage = false } = {}) {
  releaseNativeTokens([state.nativeVideo?.token, state.nativePoster?.token]);
  state.nativeVideo = null;
  state.nativePoster = null;
  elements.form.reset();
  clearPosterPreview();
  elements.videoFileName.textContent = 'Seleziona il film';
  elements.videoFileInfo.textContent = 'MP4, MKV, WebM, MOV, AVI e altri formati supportati';
  elements.posterFileName.textContent = 'Seleziona un’immagine';
  elements.videoPicker.classList.remove('has-file');
  elements.posterPicker.classList.remove('has-file');
  elements.progress.hidden = true;
  elements.progressBar.style.width = '0%';
  elements.progressPercent.textContent = '0%';
  elements.progressLabel.textContent = 'Preparazione caricamento…';
  if (!preserveMessage) showMessage('');
  updateFormState();
}

function handleVideoSelection() {
  const file = elements.videoInput.files?.[0];
  if (!file) {
    elements.videoFileName.textContent = 'Seleziona il film';
    elements.videoFileInfo.textContent = 'MP4, MKV, WebM, MOV, AVI e altri formati supportati';
    elements.videoPicker.classList.remove('has-file');
  } else {
    elements.videoFileName.textContent = file.name;
    elements.videoFileInfo.textContent = formatBytes(file.size);
    elements.videoPicker.classList.add('has-file');
  }
  showMessage('');
  updateFormState();
}

function handlePosterSelection() {
  const file = elements.posterInput.files?.[0];
  clearPosterPreview();
  if (!file) {
    elements.posterFileName.textContent = 'Seleziona un’immagine';
    elements.posterPicker.classList.remove('has-file');
    updateFormState();
    return;
  }
  if (file.size > state.maxPosterBytes) {
    elements.posterInput.value = '';
    elements.posterFileName.textContent = 'Seleziona un’immagine';
    elements.posterPicker.classList.remove('has-file');
    showMessage('La copertina supera il limite di 6 MB.', true);
    updateFormState();
    return;
  }

  state.posterObjectUrl = URL.createObjectURL(file);
  elements.posterPreview.src = state.posterObjectUrl;
  elements.posterPreview.hidden = false;
  elements.posterFallback.hidden = true;
  elements.posterFileName.textContent = file.name;
  elements.posterPicker.classList.add('has-file');
  showMessage('');
  updateFormState();
}

async function pickNativeMovieVideo(event) {
  if (!nativeUploadsEnabled()) return;
  event.preventDefault();
  try {
    const [selection] = await window.BaiaPage.pickNativeUploadFiles('movie-video');
    if (!selection) return;
    if (state.maxVideoBytes > 0 && selection.size > state.maxVideoBytes) {
      releaseNativeTokens([selection.token]);
      throw new Error(`“${selection.name}” supera il limite di ${formatBytes(state.maxVideoBytes)}.`);
    }
    releaseNativeTokens([state.nativeVideo?.token]);
    state.nativeVideo = selection;
    elements.videoInput.value = '';
    elements.videoFileName.textContent = selection.name;
    elements.videoFileInfo.textContent = formatBytes(selection.size);
    elements.videoPicker.classList.add('has-file');
    showMessage('');
    updateFormState();
  } catch (error) {
    showMessage(error.message, true);
  }
}

async function pickNativeMoviePoster(event) {
  if (!nativeUploadsEnabled()) return;
  event.preventDefault();
  try {
    const [selection] = await window.BaiaPage.pickNativeUploadFiles('poster');
    if (!selection) return;
    releaseNativeTokens([state.nativePoster?.token]);
    state.nativePoster = selection;
    elements.posterInput.value = '';
    clearPosterPreview();
    elements.posterPreview.src = selection.previewDataUrl;
    elements.posterPreview.hidden = false;
    elements.posterFallback.hidden = true;
    elements.posterFileName.textContent = selection.name;
    elements.posterPicker.classList.add('has-file');
    showMessage('');
    updateFormState();
  } catch (error) {
    showMessage(error.message, true);
  }
}

function setUploadProgress(loaded, total) {
  const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
  elements.progressBar.style.width = `${percent}%`;
  elements.progressPercent.textContent = `${percent}%`;
  elements.progressLabel.textContent = percent >= 100
    ? 'Salvataggio nella libreria…'
    : `Caricamento del film · ${formatBytes(loaded)} di ${formatBytes(total)}`;
}

async function uploadMovie(formData) {
  const target = window.BaiaPage.apiUrl('/api/uploads/movies');
  const authHeaders = await window.BaiaApi.requestAuthHeaders('POST', target);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', target);
    xhr.responseType = 'json';
    Object.entries(authHeaders).forEach(([name, value]) => xhr.setRequestHeader(name, value));
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) setUploadProgress(event.loaded, event.total);
    });
    xhr.addEventListener('load', () => {
      const payload = xhr.response || (() => {
        try { return JSON.parse(xhr.responseText); } catch { return null; }
      })();
      window.BaiaPage.reportAccountAuthFailure(payload, xhr.status);
      if (xhr.status >= 200 && xhr.status < 300) resolve(payload);
      else reject(new Error(payload?.error || `Errore HTTP ${xhr.status}`));
    });
    xhr.addEventListener('error', () => reject(new Error('Connessione al server interrotta durante il caricamento.')));
    xhr.addEventListener('abort', () => reject(new Error('Caricamento annullato.')));
    xhr.send(formData);
  });
}

async function uploadMovieNative(fields) {
  return window.BaiaPage.nativeUpload({
    kind: 'movie',
    fields,
    files: {
      video: state.nativeVideo.token,
      poster: state.nativePoster.token,
    },
  }, ({ loaded = 0, total = 0 }) => setUploadProgress(loaded, total));
}

async function submitMovie(event) {
  event.preventDefault();
  if (state.uploading || !formIsComplete()) {
    elements.form.reportValidity();
    updateFormState();
    return;
  }

  state.uploading = true;
  updateFormState();
  showMessage('');
  elements.progress.hidden = false;
  elements.progressBar.style.width = '0%';
  elements.progressPercent.textContent = '0%';
  elements.progressLabel.textContent = 'Preparazione caricamento…';
  elements.uploadButton.textContent = 'Caricamento…';

  const fields = {
    title: elements.title.value.trim(),
    year: elements.year.value,
    director: elements.director.value.trim(),
    genre: elements.genre.value.trim(),
  };

  try {
    let payload;
    if (nativeUploadsEnabled()) {
      payload = await uploadMovieNative(fields);
    } else {
      const formData = new FormData();
      formData.append('video', elements.videoInput.files[0]);
      formData.append('poster', elements.posterInput.files[0]);
      Object.entries(fields).forEach(([name, value]) => formData.append(name, value));
      payload = await uploadMovie(formData);
    }
    const movie = payload.movie;
    setUploadProgress(1, 1);
    showMessage(`“${movie.title}” è stato caricato ed è già disponibile nel catalogo.`);
    window.BaiaPage.shellToast('Film caricato sul server');
    if (window.parent !== window) {
      window.parent.postMessage({
        type: 'shell-metadata-updated',
        itemId: movie.id,
      }, window.location.origin);
    }
    resetUploadForm({ preserveMessage: true });
    await loadLibraryStatus().catch(() => {});
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    state.uploading = false;
    elements.uploadButton.textContent = 'Carica sul server';
    updateFormState();
  }
}

function renderLibraryStatus(payload) {
  const stats = payload.stats || {};
  elements.totalItems.textContent = stats.totalItems ?? 0;
  elements.movieItems.textContent = stats.movies ?? 0;
  elements.seriesItems.textContent = stats.episodes ?? 0;
  elements.totalSize.textContent = formatBytes(Number(stats.totalBytes || 0));
  elements.unavailableItems.textContent = stats.unavailable ?? 0;

  const storageAvailable = Boolean(payload.storageAvailable);
  elements.storageStatus.textContent = storageAvailable ? 'Disponibile' : 'Non disponibile';
  elements.storageStatus.classList.toggle('library-info-error', !storageAvailable);
  elements.storageDetail.textContent = storageAvailable
    ? 'Archivio multimediale raggiungibile'
    : (payload.storageError || 'Archivio multimediale non raggiungibile');

  const formats = Array.isArray(payload.supportedExtensions) ? payload.supportedExtensions : [];
  elements.supportedFormats.textContent = formats.length
    ? formats.map((extension) => String(extension).replace(/^\./, '').toUpperCase()).join(' · ')
    : '—';
}

async function loadLibraryStatus() {
  const payload = await window.BaiaPage.apiRequest('/api/library/status');
  renderLibraryStatus(payload);
}

async function loadUploadStatus() {
  const payload = await window.BaiaPage.apiRequest('/api/uploads/status');
  state.moviePath = payload.moviePath || '';
  state.seriesPath = payload.seriesPath || '';
  state.maxVideoBytes = Number(payload.maxVideoBytes || 0);
  state.uploadSeries = payload.series || [];
  state.readingPaths = payload.readingPaths || {};
  state.supportedReadingExtensions = payload.supportedReadingExtensions || {};
  state.maxReadingBytes = Number(payload.maxReadingBytes || 0);
  state.maxPosterBytes = Number(payload.maxPosterBytes || state.maxPosterBytes);
  renderDestinationPreview();
  if (typeof renderSeriesOptions === 'function') { renderSeriesOptions(); updateSeriesMode(); }
  if (typeof updateReadingCategoryUi === 'function') updateReadingCategoryUi();
}


const maximumYear = new Date().getFullYear() + 2;
elements.year.max = String(maximumYear);
if (nativeUploadsEnabled()) {
  elements.videoInput.required = false;
  elements.posterInput.required = false;
  elements.videoInput.addEventListener('click', pickNativeMovieVideo);
  elements.posterInput.addEventListener('click', pickNativeMoviePoster);
}
elements.videoInput.addEventListener('change', handleVideoSelection);
elements.posterInput.addEventListener('change', handlePosterSelection);
[elements.title, elements.year, elements.director, elements.genre].forEach((input) => {
  input.addEventListener('input', () => {
    showMessage('');
    updateFormState();
  });
});
elements.form.addEventListener('submit', submitMovie);
elements.resetButton.addEventListener('click', () => resetUploadForm());
window.addEventListener('beforeunload', () => {
  clearPosterPreview();
  releaseNativeTokens([state.nativeVideo?.token, state.nativePoster?.token]);
});

Promise.allSettled([loadUploadStatus(), loadLibraryStatus()]).then(() => updateFormState());


const seriesElements = {
  tabs: [...document.querySelectorAll('.category-tab[data-category]')],
  moviePanel: document.querySelector('#movieUploadPanel'),
  panel: document.querySelector('#seriesUploadPanel'),
  musicPanel: document.querySelector('#musicUploadPanel'),
  form: document.querySelector('#seriesUploadForm'),
  mode: document.querySelector('#seriesModeSelect'),
  existingField: document.querySelector('#existingSeriesField'),
  existingSelect: document.querySelector('#existingSeriesSelect'),
  itemList: document.querySelector('#seriesUploadItemList'),
  addFiles: document.querySelector('#seriesAddFilesButton'),
  videos: document.querySelector('#seriesVideosInput'),
  filesSummary: document.querySelector('#seriesFilesSummary'),
  generalEditor: document.querySelector('#seriesGeneralEditor'),
  episodeEditor: document.querySelector('#seriesEpisodeEditor'),
  title: document.querySelector('#seriesTitleInput'),
  year: document.querySelector('#seriesYearInput'),
  genre: document.querySelector('#seriesGenreInput'),
  poster: document.querySelector('#seriesPosterInput'),
  posterPicker: document.querySelector('#seriesPosterPicker'),
  posterPreview: document.querySelector('#seriesPosterPreview'),
  posterFallback: document.querySelector('#seriesPosterFallback'),
  posterFileName: document.querySelector('#seriesPosterFileName'),
  posterHint: document.querySelector('#seriesPosterHint'),
  destinationName: document.querySelector('#seriesDestinationName'),
  destination: document.querySelector('#seriesDestination'),
  episodeEditorTitle: document.querySelector('#seriesEpisodeEditorTitle'),
  episodeFileInfo: document.querySelector('#seriesEpisodeFileInfo'),
  episodeSeason: document.querySelector('#seriesEpisodeSeasonInput'),
  episodeNumber: document.querySelector('#seriesEpisodeNumberInput'),
  episodeTitle: document.querySelector('#seriesEpisodeTitleInput'),
  removeEpisode: document.querySelector('#seriesRemoveEpisodeButton'),
  progress: document.querySelector('#seriesUploadProgress'),
  progressBar: document.querySelector('#seriesProgressBar'),
  progressLabel: document.querySelector('#seriesProgressLabel'),
  progressPercent: document.querySelector('#seriesProgressPercent'),
  message: document.querySelector('#seriesUploadMessage'),
  reset: document.querySelector('#seriesResetButton'),
  upload: document.querySelector('#seriesUploadButton'),
};

const seriesState = {
  uploading: false,
  posterObjectUrl: null,
  nativePoster: null,
  episodes: [],
  selectedKey: 'general',
  nextEpisodeId: 1,
};

function showSeriesMessage(message, isError = false) {
  seriesElements.message.hidden = !message;
  seriesElements.message.textContent = message || '';
  seriesElements.message.classList.toggle('error', Boolean(isError));
}

function clearSeriesPosterObjectUrl() {
  if (seriesState.posterObjectUrl) URL.revokeObjectURL(seriesState.posterObjectUrl);
  seriesState.posterObjectUrl = null;
}

function showSeriesPoster(url = null) {
  if (!url) {
    seriesElements.posterPreview.hidden = true;
    seriesElements.posterPreview.removeAttribute('src');
    seriesElements.posterFallback.hidden = false;
    return;
  }
  window.BaiaPage.setMediaSrc(seriesElements.posterPreview, url);
  seriesElements.posterPreview.hidden = false;
  seriesElements.posterFallback.hidden = true;
}

function clearSeriesPosterSelection({ keepPreview = false } = {}) {
  clearSeriesPosterObjectUrl();
  releaseNativeTokens([seriesState.nativePoster?.token]);
  seriesState.nativePoster = null;
  seriesElements.poster.value = '';
  seriesElements.posterFileName.textContent = 'Seleziona un’immagine';
  if (!keepPreview) showSeriesPoster(null);
}

function selectedExistingSeries() {
  return (state.uploadSeries || []).find((item) => item.seriesUuid === seriesElements.existingSelect.value) || null;
}

function renderSeriesOptions() {
  const previous = seriesElements.existingSelect.value;
  const items = state.uploadSeries || [];
  const options = items.map((item) => {
    const option = document.createElement('option');
    option.value = item.seriesUuid;
    option.textContent = [item.title, item.year].filter(Boolean).join(' · ');
    return option;
  });
  if (!options.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Nessuna serie presente';
    options.push(option);
  }
  seriesElements.existingSelect.replaceChildren(...options);
  if (items.some((item) => item.seriesUuid === previous)) seriesElements.existingSelect.value = previous;
}

function populateExistingSeriesGeneral() {
  const selected = selectedExistingSeries();
  if (!selected) {
    seriesElements.title.value = '';
    seriesElements.year.value = '';
    seriesElements.genre.value = '';
    clearSeriesPosterSelection();
    return;
  }
  seriesElements.title.value = selected.title || '';
  seriesElements.year.value = selected.year ?? '';
  seriesElements.genre.value = Array.isArray(selected.genres) ? selected.genres.join(', ') : '';
  clearSeriesPosterSelection({ keepPreview: true });
  showSeriesPoster(selected.posterUrl ? `${selected.posterUrl}${selected.posterUrl.includes('?') ? '&' : '?'}t=${Date.now()}` : null);
  seriesElements.posterFileName.textContent = 'Mantieni copertina attuale';
}

function parseEpisodeFromName(fileName, fallbackEpisode) {
  const stem = String(fileName || '').replace(/\.[^.]+$/, '');
  const match = stem.match(/(?:^|[._ -])S(\d{1,3})E(\d{1,3})(?:[._ -]|$)/i)
    || stem.match(/(?:^|[._ -])(\d{1,3})x(\d{1,3})(?:[._ -]|$)/i)
    || stem.match(/(?:^|[._ -])x\s*(\d{1,3})\s*x\s*(\d{1,3})(?:[._ -]|$)/i);
  return match
    ? { seasonNumber: Number(match[1]), episodeNumber: Number(match[2]) }
    : { seasonNumber: 1, episodeNumber: fallbackEpisode };
}

function nextFallbackEpisode() {
  const used = new Set(seriesState.episodes.filter((item) => item.seasonNumber === 1).map((item) => item.episodeNumber));
  let candidate = 1;
  while (used.has(candidate)) candidate += 1;
  return candidate;
}

function addSeriesFiles(files) {
  const incoming = [...(files || [])];
  for (const [index, entry] of incoming.entries()) {
    const file = entry?.file || entry;
    const nativeToken = entry?.nativeToken || entry?.token || null;
    if (seriesState.episodes.length >= 100) {
      releaseNativeTokens(incoming.slice(index).map((item) => item?.nativeToken || item?.token));
      showSeriesMessage('Puoi caricare al massimo 100 episodi in una sessione.', true);
      break;
    }
    const fallback = nextFallbackEpisode();
    const inferred = parseEpisodeFromName(file.name, fallback);
    const id = `episode-${seriesState.nextEpisodeId++}`;
    seriesState.episodes.push({
      id,
      file,
      nativeToken,
      seasonNumber: inferred.seasonNumber,
      episodeNumber: inferred.episodeNumber,
      title: '',
    });
    seriesState.selectedKey = id;
  }
  renderSeriesItemList();
  renderSelectedSeriesEditor();
  updateSeriesFormState();
}

function selectedEpisodeDraft() {
  return seriesState.episodes.find((item) => item.id === seriesState.selectedKey) || null;
}

function episodeToken(item) {
  const season = Number.isInteger(Number(item.seasonNumber)) ? Number(item.seasonNumber) : 0;
  const episode = Number.isInteger(Number(item.episodeNumber)) ? Number(item.episodeNumber) : 0;
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
}

function renderSeriesItemList() {
  const fragment = document.createDocumentFragment();
  const general = document.createElement('button');
  general.type = 'button';
  general.className = 'series-upload-item general';
  general.classList.toggle('active', seriesState.selectedKey === 'general');
  general.setAttribute('role', 'option');
  general.setAttribute('aria-selected', String(seriesState.selectedKey === 'general'));
  general.innerHTML = '<span class="series-upload-item-copy"><strong>Generale</strong><span>Dati e copertina della serie</span></span>';
  general.addEventListener('click', () => {
    seriesState.selectedKey = 'general';
    renderSeriesItemList();
    renderSelectedSeriesEditor();
  });
  fragment.appendChild(general);

  for (const item of seriesState.episodes) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'series-upload-item';
    button.classList.toggle('active', item.id === seriesState.selectedKey);
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(item.id === seriesState.selectedKey));
    const copy = document.createElement('span');
    copy.className = 'series-upload-item-copy';
    const strong = document.createElement('strong');
    strong.textContent = item.title || item.file.name;
    const name = document.createElement('span');
    name.textContent = item.title ? item.file.name : 'Titolo episodio non impostato';
    copy.append(strong, name);
    const token = document.createElement('span');
    token.className = 'series-upload-item-token';
    token.textContent = episodeToken(item);
    button.append(copy, token);
    button.addEventListener('click', () => {
      seriesState.selectedKey = item.id;
      renderSeriesItemList();
      renderSelectedSeriesEditor();
    });
    fragment.appendChild(button);
  }
  seriesElements.itemList.replaceChildren(fragment);
  const totalBytes = seriesState.episodes.reduce((sum, item) => sum + Number(item.file.size || 0), 0);
  seriesElements.filesSummary.textContent = seriesState.episodes.length
    ? `${seriesState.episodes.length} ${seriesState.episodes.length === 1 ? 'episodio' : 'episodi'} · ${formatBytes(totalBytes)}`
    : 'Nessun episodio aggiunto.';
}

function renderSelectedSeriesEditor() {
  const episode = selectedEpisodeDraft();
  const generalSelected = seriesState.selectedKey === 'general' || !episode;
  seriesElements.generalEditor.hidden = !generalSelected;
  seriesElements.episodeEditor.hidden = generalSelected;
  if (generalSelected) return;
  seriesElements.episodeEditorTitle.textContent = episode.file.name;
  seriesElements.episodeFileInfo.textContent = formatBytes(episode.file.size);
  seriesElements.episodeSeason.value = episode.seasonNumber;
  seriesElements.episodeNumber.value = episode.episodeNumber;
  seriesElements.episodeTitle.value = episode.title || '';
}

function updateSelectedEpisodeDraft() {
  const episode = selectedEpisodeDraft();
  if (!episode) return;
  episode.seasonNumber = Number(seriesElements.episodeSeason.value);
  episode.episodeNumber = Number(seriesElements.episodeNumber.value);
  episode.title = seriesElements.episodeTitle.value.trim();
  renderSeriesItemList();
  updateSeriesFormState();
}

function removeSelectedEpisode() {
  const index = seriesState.episodes.findIndex((item) => item.id === seriesState.selectedKey);
  if (index < 0) return;
  releaseNativeTokens([seriesState.episodes[index].nativeToken]);
  seriesState.episodes.splice(index, 1);
  seriesState.selectedKey = seriesState.episodes[index]?.id || seriesState.episodes[index - 1]?.id || 'general';
  renderSeriesItemList();
  renderSelectedSeriesEditor();
  updateSeriesFormState();
}

function seriesEpisodePlan() {
  return seriesState.episodes.map((item) => ({
    seasonNumber: Number(item.seasonNumber),
    episodeNumber: Number(item.episodeNumber),
    title: String(item.title || '').trim(),
  }));
}

function episodePlanValid() {
  if (!seriesState.episodes.length) return false;
  const seen = new Set();
  for (const item of seriesEpisodePlan()) {
    if (!Number.isInteger(item.seasonNumber) || item.seasonNumber < 1 || item.seasonNumber > 999) return false;
    if (!Number.isInteger(item.episodeNumber) || item.episodeNumber < 1 || item.episodeNumber > 999) return false;
    const key = `${item.seasonNumber}:${item.episodeNumber}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function renderSeriesDestination() {
  seriesElements.destinationName.textContent = seriesElements.title.value.trim() || 'Nome serie';
  const selected = selectedExistingSeries();
  seriesElements.destination.textContent = seriesElements.mode.value === 'existing' && selected
    ? `Serie esistente · ${state.seriesPath || 'Cartella Serie'}`
    : state.seriesPath || 'Cartella Serie';
}

function seriesFormComplete() {
  const existing = seriesElements.mode.value === 'existing';
  const nativeMode = nativeUploadsEnabled();
  const episodesReady = !nativeMode || seriesState.episodes.every((item) => item.nativeToken);
  const posterReady = existing || (nativeMode ? seriesState.nativePoster : seriesElements.poster.files?.[0]);
  return Boolean(
    episodePlanValid()
    && episodesReady
    && (!existing || selectedExistingSeries())
    && seriesElements.title.value.trim()
    && seriesElements.year.value
    && seriesElements.genre.value.trim()
    && posterReady
  );
}

function updateSeriesMode({ clearNewGeneral = false } = {}) {
  const existing = seriesElements.mode.value === 'existing';
  seriesElements.existingField.hidden = !existing;
  seriesElements.posterHint.textContent = existing
    ? 'Facoltativa: scegli un’immagine solo per sostituire la copertina attuale · massimo 6 MB'
    : 'Obbligatoria per una nuova serie · massimo 6 MB';
  if (existing) {
    populateExistingSeriesGeneral();
  } else if (clearNewGeneral) {
    seriesElements.title.value = '';
    seriesElements.year.value = '';
    seriesElements.genre.value = '';
    clearSeriesPosterSelection();
  } else if (!seriesState.nativePoster && !seriesElements.poster.files?.[0]) {
    clearSeriesPosterSelection();
  }
  renderSeriesDestination();
  renderSeriesItemList();
  renderSelectedSeriesEditor();
  updateSeriesFormState();
}

function updateSeriesFormState() {
  seriesElements.upload.disabled = seriesState.uploading || !seriesFormComplete();
  seriesElements.reset.disabled = seriesState.uploading;
  seriesElements.addFiles.disabled = seriesState.uploading || seriesState.episodes.length >= 100;
  seriesElements.mode.disabled = seriesState.uploading;
  seriesElements.existingSelect.disabled = seriesState.uploading;
  renderSeriesDestination();
}

function resetSeriesForm({ preserveMessage = false } = {}) {
  releaseNativeTokens(seriesState.episodes.map((item) => item.nativeToken));
  seriesElements.form.reset();
  seriesState.episodes = [];
  seriesState.selectedKey = 'general';
  seriesState.nextEpisodeId = 1;
  clearSeriesPosterSelection();
  seriesElements.progress.hidden = true;
  seriesElements.progressBar.style.width = '0%';
  seriesElements.progressPercent.textContent = '0%';
  seriesElements.progressLabel.textContent = 'Preparazione caricamento…';
  if (!preserveMessage) showSeriesMessage('');
  renderSeriesOptions();
  renderSeriesItemList();
  renderSelectedSeriesEditor();
  updateSeriesMode({ clearNewGeneral: true });
}

function setSeriesProgress(loaded, total) {
  const percent = total > 0 ? Math.min(100, Math.round(loaded / total * 100)) : 0;
  seriesElements.progressBar.style.width = `${percent}%`;
  seriesElements.progressPercent.textContent = `${percent}%`;
  seriesElements.progressLabel.textContent = percent >= 100 ? 'Organizzazione episodi nella libreria…' : `Caricamento episodi · ${percent}%`;
}

async function uploadSeries(formData) {
  const target = window.BaiaPage.apiUrl('/api/uploads/series');
  const authHeaders = await window.BaiaApi.requestAuthHeaders('POST', target);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', target);
    xhr.responseType = 'json';
    Object.entries(authHeaders).forEach(([name, value]) => xhr.setRequestHeader(name, value));
    xhr.upload.addEventListener('progress', (event) => { if (event.lengthComputable) setSeriesProgress(event.loaded, event.total); });
    xhr.addEventListener('load', () => {
      const payload = xhr.response || (() => { try { return JSON.parse(xhr.responseText); } catch { return null; } })();
      window.BaiaPage.reportAccountAuthFailure(payload, xhr.status);
      if (xhr.status >= 200 && xhr.status < 300) resolve(payload);
      else reject(new Error(payload?.error || `Errore HTTP ${xhr.status}`));
    });
    xhr.addEventListener('error', () => reject(new Error('Connessione al server interrotta durante il caricamento.')));
    xhr.send(formData);
  });
}

async function uploadSeriesNative(fields) {
  return window.BaiaPage.nativeUpload({
    kind: 'series',
    fields,
    files: {
      videos: seriesState.episodes.map((item) => item.nativeToken),
      poster: seriesState.nativePoster?.token || null,
    },
  }, ({ loaded = 0, total = 0 }) => setSeriesProgress(loaded, total));
}

async function submitSeries(event) {
  event.preventDefault();
  if (seriesState.uploading || !seriesFormComplete()) {
    updateSeriesFormState();
    if (!episodePlanValid() && seriesState.episodes.length) showSeriesMessage('Controlla la numerazione: stagione ed episodio devono essere validi e non duplicati.', true);
    return;
  }
  seriesState.uploading = true;
  updateSeriesFormState();
  showSeriesMessage('');
  seriesElements.progress.hidden = false;
  setSeriesProgress(0, 1);
  seriesElements.upload.textContent = 'Caricamento…';

  const fields = {
    episodes: JSON.stringify(seriesEpisodePlan()),
    title: seriesElements.title.value.trim(),
    year: seriesElements.year.value,
    genre: seriesElements.genre.value.trim(),
  };
  if (seriesElements.mode.value === 'existing') fields.seriesUuid = seriesElements.existingSelect.value;

  const requestedCount = seriesState.episodes.length;
  try {
    let payload;
    if (nativeUploadsEnabled()) {
      payload = await uploadSeriesNative(fields);
    } else {
      const data = new FormData();
      seriesState.episodes.forEach((item) => data.append('videos', item.file));
      Object.entries(fields).forEach(([name, value]) => data.append(name, value));
      if (seriesElements.poster.files?.[0]) data.append('poster', seriesElements.poster.files[0]);
      payload = await uploadSeries(data);
    }
    const count = payload.uploadedEpisodes?.length || requestedCount;
    showSeriesMessage(`${count} ${count === 1 ? 'episodio caricato' : 'episodi caricati'} in “${payload.series.title}”.`);
    window.BaiaPage.shellToast('Episodi caricati sul server');
    await loadUploadStatus();
    await loadLibraryStatus();
    resetSeriesForm({ preserveMessage: true });
  } catch (error) {
    showSeriesMessage(error.message, true);
  } finally {
    seriesState.uploading = false;
    seriesElements.upload.textContent = 'Carica episodi';
    updateSeriesFormState();
  }
}

async function pickNativeSeriesVideos() {
  try {
    const selections = await window.BaiaPage.pickNativeUploadFiles('series-videos');
    const oversized = selections.find((selection) => state.maxVideoBytes > 0 && selection.size > state.maxVideoBytes);
    if (oversized) {
      releaseNativeTokens(selections.map((selection) => selection.token));
      throw new Error(`“${oversized.name}” supera il limite di ${formatBytes(state.maxVideoBytes)}.`);
    }
    addSeriesFiles(selections);
    showSeriesMessage('');
  } catch (error) {
    showSeriesMessage(error.message, true);
  }
}

async function pickNativeSeriesPoster(event) {
  if (!nativeUploadsEnabled()) return;
  event.preventDefault();
  try {
    const [selection] = await window.BaiaPage.pickNativeUploadFiles('poster');
    if (!selection) return;
    releaseNativeTokens([seriesState.nativePoster?.token]);
    seriesState.nativePoster = selection;
    seriesElements.poster.value = '';
    clearSeriesPosterObjectUrl();
    showSeriesPoster(selection.previewDataUrl);
    seriesElements.posterFileName.textContent = selection.name;
    showSeriesMessage('');
    updateSeriesFormState();
  } catch (error) {
    showSeriesMessage(error.message, true);
  }
}

function switchUploadCategory(category) {
  if (!['movie', 'series', 'music', 'books', 'comics', 'manga'].includes(category)) return;
  seriesElements.tabs.forEach((tab) => {
    const active = tab.dataset.category === category;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-pressed', String(active));
  });
  seriesElements.moviePanel.hidden = category !== 'movie';
  seriesElements.panel.hidden = category !== 'series';
  seriesElements.musicPanel.hidden = category !== 'music';
  readingElements.panel.hidden = !['books', 'comics', 'manga'].includes(category);
  if (!readingElements.panel.hidden) setReadingCategory(category);
}

seriesElements.tabs.forEach((tab) => tab.addEventListener('click', () => switchUploadCategory(tab.dataset.category)));
seriesElements.mode.addEventListener('change', () => updateSeriesMode({ clearNewGeneral: seriesElements.mode.value === 'new' }));
seriesElements.existingSelect.addEventListener('change', () => {
  populateExistingSeriesGeneral();
  renderSeriesItemList();
  updateSeriesFormState();
});
seriesElements.addFiles.addEventListener('click', () => {
  if (nativeUploadsEnabled()) void pickNativeSeriesVideos();
  else seriesElements.videos.click();
});
if (nativeUploadsEnabled()) {
  seriesElements.videos.addEventListener('click', (event) => {
    event.preventDefault();
    void pickNativeSeriesVideos();
  });
  seriesElements.poster.addEventListener('click', pickNativeSeriesPoster);
}
seriesElements.videos.addEventListener('change', () => {
  addSeriesFiles(seriesElements.videos.files);
  seriesElements.videos.value = '';
  showSeriesMessage('');
});
seriesElements.poster.addEventListener('change', () => {
  const file = seriesElements.poster.files?.[0];
  releaseNativeTokens([seriesState.nativePoster?.token]);
  seriesState.nativePoster = null;
  clearSeriesPosterObjectUrl();
  if (!file) {
    if (seriesElements.mode.value === 'existing') populateExistingSeriesGeneral();
    else {
      seriesElements.posterFileName.textContent = 'Seleziona un’immagine';
      showSeriesPoster(null);
    }
    updateSeriesFormState();
    return;
  }
  if (file.size > state.maxPosterBytes) {
    seriesElements.poster.value = '';
    showSeriesMessage('La copertina supera il limite di 6 MB.', true);
    if (seriesElements.mode.value === 'existing') populateExistingSeriesGeneral();
    else showSeriesPoster(null);
    updateSeriesFormState();
    return;
  }
  seriesState.posterObjectUrl = URL.createObjectURL(file);
  showSeriesPoster(seriesState.posterObjectUrl);
  seriesElements.posterFileName.textContent = file.name;
  showSeriesMessage('');
  updateSeriesFormState();
});
[seriesElements.title, seriesElements.year, seriesElements.genre].forEach((input) => input.addEventListener('input', () => {
  renderSeriesItemList();
  showSeriesMessage('');
  updateSeriesFormState();
}));
[seriesElements.episodeSeason, seriesElements.episodeNumber, seriesElements.episodeTitle].forEach((input) => input.addEventListener('input', updateSelectedEpisodeDraft));
seriesElements.removeEpisode.addEventListener('click', removeSelectedEpisode);
seriesElements.form.addEventListener('submit', submitSeries);
seriesElements.reset.addEventListener('click', () => resetSeriesForm());
window.addEventListener('beforeunload', () => {
  clearSeriesPosterObjectUrl();
  releaseNativeTokens([seriesState.nativePoster?.token, ...seriesState.episodes.map((item) => item.nativeToken)]);
});

seriesElements.year.max = String(maximumYear);
renderSeriesItemList();
renderSelectedSeriesEditor();
setTimeout(() => {
  renderSeriesOptions();
  updateSeriesMode();
}, 0);


const readingElements = {
  panel: document.querySelector('#readingUploadPanel'),
  eyebrow: document.querySelector('#readingPanelEyebrow'),
  heading: document.querySelector('#readingPanelTitle'),
  form: document.querySelector('#readingUploadForm'),
  file: document.querySelector('#readingFileInput'),
  filePicker: document.querySelector('#readingFilePicker'),
  fileName: document.querySelector('#readingFileName'),
  fileInfo: document.querySelector('#readingFileInfo'),
  poster: document.querySelector('#readingPosterInput'),
  posterPicker: document.querySelector('#readingPosterPicker'),
  posterPreview: document.querySelector('#readingPosterPreview'),
  posterFallback: document.querySelector('#readingPosterFallback'),
  posterFileName: document.querySelector('#readingPosterFileName'),
  title: document.querySelector('#readingTitleInput'),
  year: document.querySelector('#readingYearInput'),
  author: document.querySelector('#readingAuthorInput'),
  genre: document.querySelector('#readingGenreInput'),
  destinationFileName: document.querySelector('#readingDestinationFileName'),
  destination: document.querySelector('#readingDestination'),
  progress: document.querySelector('#readingUploadProgress'),
  progressBar: document.querySelector('#readingProgressBar'),
  progressLabel: document.querySelector('#readingProgressLabel'),
  progressPercent: document.querySelector('#readingProgressPercent'),
  message: document.querySelector('#readingUploadMessage'),
  reset: document.querySelector('#readingResetButton'),
  upload: document.querySelector('#readingUploadButton'),
};

const readingState = {
  category: 'books',
  uploading: false,
  posterObjectUrl: null,
  nativeDocument: null,
  nativePoster: null,
};

const readingCategoryCopy = {
  books: { label: 'Libri', singular: 'libro', fallback: 'PDF o EPUB' },
  comics: { label: 'Fumetti', singular: 'fumetto', fallback: 'PDF o CBZ' },
  manga: { label: 'Manga', singular: 'manga', fallback: 'PDF o CBZ' },
};

function clearReadingPosterPreview() {
  if (readingState.posterObjectUrl) URL.revokeObjectURL(readingState.posterObjectUrl);
  readingState.posterObjectUrl = null;
  readingElements.posterPreview.hidden = true;
  readingElements.posterPreview.removeAttribute('src');
  readingElements.posterFallback.hidden = false;
}

function showReadingMessage(message, isError = false) {
  readingElements.message.hidden = !message;
  readingElements.message.textContent = message || '';
  readingElements.message.classList.toggle('error', Boolean(isError));
}

function readingExtension() {
  const selected = nativeUploadsEnabled() ? readingState.nativeDocument : readingElements.file.files?.[0];
  const match = selected?.name?.match(/(\.[^.]+)$/);
  return match ? match[1].toLowerCase() : '';
}

function readingAllowedExtensions() {
  const values = state.supportedReadingExtensions?.[readingState.category];
  return Array.isArray(values) && values.length ? values : readingState.category === 'books' ? ['.pdf', '.epub'] : ['.pdf', '.cbz'];
}

function renderReadingDestination() {
  const title = sanitizeFileStem(readingElements.title.value.trim());
  const extension = readingExtension();
  readingElements.destinationFileName.textContent = title
    ? `${title}${extension || '.[formato]'}`
    : 'Il nome verrà generato dal titolo';
  readingElements.destination.textContent = state.readingPaths?.[readingState.category]
    || `Cartella ${readingCategoryCopy[readingState.category].label}`;
}

function readingFormComplete() {
  const document = nativeUploadsEnabled() ? readingState.nativeDocument : readingElements.file.files?.[0];
  const poster = nativeUploadsEnabled() ? readingState.nativePoster : readingElements.poster.files?.[0];
  return Boolean(
    document
    && poster
    && readingElements.title.value.trim()
    && readingElements.year.value
    && readingElements.author.value.trim()
    && readingElements.genre.value.trim()
    && readingElements.form.checkValidity()
  );
}

function updateReadingFormState() {
  readingElements.upload.disabled = readingState.uploading || !readingFormComplete();
  readingElements.reset.disabled = readingState.uploading;
  renderReadingDestination();
}

function updateReadingCategoryUi() {
  const copy = readingCategoryCopy[readingState.category] || readingCategoryCopy.books;
  const extensions = readingAllowedExtensions();
  readingElements.eyebrow.textContent = copy.label;
  readingElements.heading.textContent = `Carica un ${copy.singular}`;
  readingElements.file.accept = extensions.join(',');
  if (!readingState.nativeDocument && !readingElements.file.files?.[0]) {
    readingElements.fileName.textContent = `Seleziona il ${copy.singular}`;
    readingElements.fileInfo.textContent = extensions.length
      ? extensions.map((value) => value.replace(/^\./, '').toUpperCase()).join(' · ')
      : copy.fallback;
  }
  renderReadingDestination();
}

function resetReadingForm({ preserveMessage = false } = {}) {
  releaseNativeTokens([readingState.nativeDocument?.token, readingState.nativePoster?.token]);
  readingState.nativeDocument = null;
  readingState.nativePoster = null;
  readingElements.form.reset();
  clearReadingPosterPreview();
  readingElements.filePicker.classList.remove('has-file');
  readingElements.posterPicker.classList.remove('has-file');
  readingElements.posterFileName.textContent = 'Seleziona un’immagine';
  readingElements.progress.hidden = true;
  readingElements.progressBar.style.width = '0%';
  readingElements.progressPercent.textContent = '0%';
  readingElements.progressLabel.textContent = 'Preparazione caricamento…';
  if (!preserveMessage) showReadingMessage('');
  updateReadingCategoryUi();
  updateReadingFormState();
}

function setReadingCategory(category) {
  if (!readingCategoryCopy[category]) return;
  if (readingState.category !== category) {
    readingState.category = category;
    resetReadingForm();
  } else {
    updateReadingCategoryUi();
    updateReadingFormState();
  }
}

function handleReadingFileSelection() {
  const file = readingElements.file.files?.[0];
  if (!file) {
    readingElements.filePicker.classList.remove('has-file');
    updateReadingCategoryUi();
  } else {
    const extension = readingExtension();
    if (!readingAllowedExtensions().includes(extension)) {
      readingElements.file.value = '';
      readingElements.filePicker.classList.remove('has-file');
      showReadingMessage('Formato di lettura non supportato per questa categoria.', true);
      updateReadingCategoryUi();
    } else {
      readingElements.fileName.textContent = file.name;
      readingElements.fileInfo.textContent = formatBytes(file.size);
      readingElements.filePicker.classList.add('has-file');
      showReadingMessage('');
    }
  }
  updateReadingFormState();
}

function handleReadingPosterSelection() {
  const file = readingElements.poster.files?.[0];
  clearReadingPosterPreview();
  if (!file) {
    readingElements.posterPicker.classList.remove('has-file');
    readingElements.posterFileName.textContent = 'Seleziona un’immagine';
    updateReadingFormState();
    return;
  }
  if (file.size > state.maxPosterBytes) {
    readingElements.poster.value = '';
    readingElements.posterPicker.classList.remove('has-file');
    readingElements.posterFileName.textContent = 'Seleziona un’immagine';
    showReadingMessage('La copertina supera il limite di 6 MB.', true);
    updateReadingFormState();
    return;
  }
  readingState.posterObjectUrl = URL.createObjectURL(file);
  readingElements.posterPreview.src = readingState.posterObjectUrl;
  readingElements.posterPreview.hidden = false;
  readingElements.posterFallback.hidden = true;
  readingElements.posterPicker.classList.add('has-file');
  readingElements.posterFileName.textContent = file.name;
  showReadingMessage('');
  updateReadingFormState();
}

async function pickNativeReadingDocument(event) {
  if (!nativeUploadsEnabled()) return;
  event.preventDefault();
  try {
    const [selection] = await window.BaiaPage.pickNativeUploadFiles('reading-document', readingState.category);
    if (!selection) return;
    if (state.maxReadingBytes > 0 && selection.size > state.maxReadingBytes) {
      releaseNativeTokens([selection.token]);
      throw new Error(`“${selection.name}” supera il limite di ${formatBytes(state.maxReadingBytes)}.`);
    }
    releaseNativeTokens([readingState.nativeDocument?.token]);
    readingState.nativeDocument = selection;
    readingElements.file.value = '';
    readingElements.fileName.textContent = selection.name;
    readingElements.fileInfo.textContent = formatBytes(selection.size);
    readingElements.filePicker.classList.add('has-file');
    showReadingMessage('');
    updateReadingFormState();
  } catch (error) {
    showReadingMessage(error.message, true);
  }
}

async function pickNativeReadingPoster(event) {
  if (!nativeUploadsEnabled()) return;
  event.preventDefault();
  try {
    const [selection] = await window.BaiaPage.pickNativeUploadFiles('poster');
    if (!selection) return;
    releaseNativeTokens([readingState.nativePoster?.token]);
    readingState.nativePoster = selection;
    readingElements.poster.value = '';
    clearReadingPosterPreview();
    readingElements.posterPreview.src = selection.previewDataUrl;
    readingElements.posterPreview.hidden = false;
    readingElements.posterFallback.hidden = true;
    readingElements.posterPicker.classList.add('has-file');
    readingElements.posterFileName.textContent = selection.name;
    showReadingMessage('');
    updateReadingFormState();
  } catch (error) {
    showReadingMessage(error.message, true);
  }
}

function setReadingProgress(loaded, total) {
  const percent = total > 0 ? Math.min(100, Math.round(loaded / total * 100)) : 0;
  readingElements.progressBar.style.width = `${percent}%`;
  readingElements.progressPercent.textContent = `${percent}%`;
  readingElements.progressLabel.textContent = percent >= 100
    ? 'Salvataggio nella libreria…'
    : `Caricamento · ${formatBytes(loaded)} di ${formatBytes(total)}`;
}

async function uploadReading(formData) {
  const target = window.BaiaPage.apiUrl(`/api/uploads/reading/${encodeURIComponent(readingState.category)}`);
  const authHeaders = await window.BaiaApi.requestAuthHeaders('POST', target);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', target);
    xhr.responseType = 'json';
    Object.entries(authHeaders).forEach(([name, value]) => xhr.setRequestHeader(name, value));
    xhr.upload.addEventListener('progress', (event) => { if (event.lengthComputable) setReadingProgress(event.loaded, event.total); });
    xhr.addEventListener('load', () => {
      const payload = xhr.response || (() => { try { return JSON.parse(xhr.responseText); } catch { return null; } })();
      window.BaiaPage.reportAccountAuthFailure(payload, xhr.status);
      if (xhr.status >= 200 && xhr.status < 300) resolve(payload);
      else reject(new Error(payload?.error || `Errore HTTP ${xhr.status}`));
    });
    xhr.addEventListener('error', () => reject(new Error('Connessione al server interrotta durante il caricamento.')));
    xhr.send(formData);
  });
}

async function uploadReadingNative(fields) {
  return window.BaiaPage.nativeUpload({
    kind: 'reading',
    category: readingState.category,
    fields,
    files: {
      document: readingState.nativeDocument.token,
      poster: readingState.nativePoster.token,
    },
  }, ({ loaded = 0, total = 0 }) => setReadingProgress(loaded, total));
}

async function submitReading(event) {
  event.preventDefault();
  if (readingState.uploading || !readingFormComplete()) {
    readingElements.form.reportValidity();
    updateReadingFormState();
    return;
  }
  readingState.uploading = true;
  updateReadingFormState();
  showReadingMessage('');
  readingElements.progress.hidden = false;
  setReadingProgress(0, 1);
  readingElements.upload.textContent = 'Caricamento…';

  const fields = {
    title: readingElements.title.value.trim(),
    year: readingElements.year.value,
    author: readingElements.author.value.trim(),
    genre: readingElements.genre.value.trim(),
  };

  try {
    let payload;
    if (nativeUploadsEnabled()) {
      payload = await uploadReadingNative(fields);
    } else {
      const data = new FormData();
      data.append('document', readingElements.file.files[0]);
      data.append('poster', readingElements.poster.files[0]);
      Object.entries(fields).forEach(([name, value]) => data.append(name, value));
      payload = await uploadReading(data);
    }
    setReadingProgress(1, 1);
    showReadingMessage(`“${payload.item.title}” è stato caricato in ${readingCategoryCopy[readingState.category].label}.`);
    window.BaiaPage.shellToast('Contenuto caricato sul server');
    if (window.parent !== window) {
      window.parent.postMessage({ type: 'shell-metadata-updated', itemId: `reading:${payload.item.id}` }, window.location.origin);
    }
    resetReadingForm({ preserveMessage: true });
    await loadLibraryStatus().catch(() => {});
  } catch (error) {
    showReadingMessage(error.message, true);
  } finally {
    readingState.uploading = false;
    readingElements.upload.textContent = 'Carica sul server';
    updateReadingFormState();
  }
}

readingElements.year.max = String(maximumYear);
if (nativeUploadsEnabled()) {
  readingElements.file.required = false;
  readingElements.poster.required = false;
  readingElements.file.addEventListener('click', pickNativeReadingDocument);
  readingElements.poster.addEventListener('click', pickNativeReadingPoster);
}
readingElements.file.addEventListener('change', () => {
  releaseNativeTokens([readingState.nativeDocument?.token]);
  readingState.nativeDocument = null;
  handleReadingFileSelection();
});
readingElements.poster.addEventListener('change', () => {
  releaseNativeTokens([readingState.nativePoster?.token]);
  readingState.nativePoster = null;
  handleReadingPosterSelection();
});
[readingElements.title, readingElements.year, readingElements.author, readingElements.genre].forEach((input) => input.addEventListener('input', () => {
  showReadingMessage('');
  updateReadingFormState();
}));
readingElements.form.addEventListener('submit', submitReading);
readingElements.reset.addEventListener('click', () => resetReadingForm());
window.addEventListener('beforeunload', () => {
  clearReadingPosterPreview();
  releaseNativeTokens([readingState.nativeDocument?.token, readingState.nativePoster?.token]);
});
updateReadingCategoryUi();
updateReadingFormState();

window.addEventListener('baia-library-scan-complete', () => {
  loadLibraryStatus().catch(() => {});
});
