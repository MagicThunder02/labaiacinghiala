const elements = {
  category: document.querySelector('#categorySelect'),
  search: document.querySelector('#metadataSearch'),
  count: document.querySelector('#resultCount'),
  results: document.querySelector('#metadataResults'),
  musicScopeToggle: document.querySelector('#musicScopeToggle'),
  musicScopeButtons: [...document.querySelectorAll('[data-music-scope]')],
  empty: document.querySelector('#editorEmpty'),
  form: document.querySelector('#metadataForm'),
  selectedCategory: document.querySelector('#selectedCategory'),
  selectedFile: document.querySelector('#selectedFile'),
  selectedPath: document.querySelector('#selectedPath'),
  title: document.querySelector('#titleInput'),
  titleLabel: document.querySelector('#titleLabel'),
  year: document.querySelector('#yearInput'),
  director: document.querySelector('#directorInput'),
  directorLabel: document.querySelector('#directorLabel'),
  genres: document.querySelector('#genresInput'),
  yearField: document.querySelector('#yearField'),
  directorField: document.querySelector('#directorField'),
  genresField: document.querySelector('#genresField'),
  seasonField: document.querySelector('#seasonField'),
  episodeField: document.querySelector('#episodeField'),
  season: document.querySelector('#seasonInput'),
  episode: document.querySelector('#episodeInput'),
  musicFields: document.querySelector('#musicFields'),
  musicArtistsField: document.querySelector('#musicArtistsField'),
  musicAlbumField: document.querySelector('#musicAlbumField'),
  musicAlbumArtistsField: document.querySelector('#musicAlbumArtistsField'),
  musicDateField: document.querySelector('#musicDateField'),
  musicTrackNumberField: document.querySelector('#musicTrackNumberField'),
  musicTrackTotalField: document.querySelector('#musicTrackTotalField'),
  musicDiscNumberField: document.querySelector('#musicDiscNumberField'),
  musicDiscTotalField: document.querySelector('#musicDiscTotalField'),
  musicComposersField: document.querySelector('#musicComposersField'),
  musicCommentField: document.querySelector('#musicCommentField'),
  musicCompilationField: document.querySelector('#musicCompilationField'),
  musicArtists: document.querySelector('#musicArtistsInput'),
  musicAlbum: document.querySelector('#musicAlbumInput'),
  musicAlbumArtists: document.querySelector('#musicAlbumArtistsInput'),
  musicDate: document.querySelector('#musicDateInput'),
  musicTrackNumber: document.querySelector('#musicTrackNumberInput'),
  musicTrackTotal: document.querySelector('#musicTrackTotalInput'),
  musicDiscNumber: document.querySelector('#musicDiscNumberInput'),
  musicDiscTotal: document.querySelector('#musicDiscTotalInput'),
  musicComposers: document.querySelector('#musicComposersInput'),
  musicComment: document.querySelector('#musicCommentInput'),
  musicCompilation: document.querySelector('#musicCompilationInput'),
  musicProperties: document.querySelector('#musicPropertiesText'),
  musicPropertiesHeading: document.querySelector('#musicPropertiesHeading'),
  musicAlbumTrackPreview: document.querySelector('#musicAlbumTrackPreview'),
  musicAlbumTrackCount: document.querySelector('#musicAlbumTrackCount'),
  musicAlbumMixedNotice: document.querySelector('#musicAlbumMixedNotice'),
  musicAlbumTrackList: document.querySelector('#musicAlbumTrackList'),
  posterEditor: document.querySelector('#posterEditor'),
  posterInput: document.querySelector('#posterInput'),
  posterPreview: document.querySelector('#posterPreview'),
  posterFallback: document.querySelector('#posterFallback'),
  posterFileName: document.querySelector('#posterFileName'),
  posterHeading: document.querySelector('#posterHeading'),
  posterDescription: document.querySelector('#posterDescription'),
  posterUploadControls: document.querySelector('#posterUploadControls'),
  musicCoverRemove: document.querySelector('#musicCoverRemoveButton'),
  musicCoverNotice: document.querySelector('#musicCoverNotice'),
  delete: document.querySelector('#deleteButton'),
  cancel: document.querySelector('#cancelButton'),
  save: document.querySelector('#saveButton'),
};
const musicInputs = [
  elements.musicArtists,
  elements.musicAlbum,
  elements.musicAlbumArtists,
  elements.musicDate,
  elements.musicTrackNumber,
  elements.musicTrackTotal,
  elements.musicDiscNumber,
  elements.musicDiscTotal,
  elements.musicComposers,
  elements.musicComment,
  elements.musicCompilation,
];
const state = {
  items: [], selectedId: null, selected: null, posterDataUrl: null,
  posterObjectUrl: null, musicCoverObjectUrl: null, coverRequestSerial: 0,
  searchTimer: null, requestSerial: 0, musicScope: 'track', musicCoverAction: 'keep',
};
function categoryLabel(value) {
  return ({ movie: 'Film', series: 'Serie', music: 'Musica', books: 'Libri', comics: 'Fumetti', manga: 'Manga' })[value] || 'Contenuto';
}
function suppressInputHistory() {
  const randomPart = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  document.querySelectorAll('[data-no-history]').forEach((input, index) => {
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('name', `metadata-field-${index}-${randomPart}`);
    input.setAttribute('data-lpignore', 'true');
    input.setAttribute('data-1p-ignore', 'true');
    input.setAttribute('data-bwignore', 'true');
  });
  elements.form?.setAttribute('autocomplete', 'off');
}
function updateMusicScopeVisibility() {
  const music = elements.category.value === 'music';
  elements.musicScopeToggle.hidden = !music;
  for (const button of elements.musicScopeButtons) {
    const active = button.dataset.musicScope === state.musicScope;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
}
function updateSearchPlaceholder() {
  elements.search.placeholder = elements.category.value === 'music'
    ? (state.musicScope === 'album' ? 'Cerca per album o artista…' : 'Cerca per titolo, album o artista…')
    : ' ';
  updateMusicScopeVisibility();
}
function renderCategories(categories) {
  if (!Array.isArray(categories) || !categories.length) return;
  const currentValue = elements.category.value || 'movie';
  const options = categories.map((category) => {
    const option = document.createElement('option');
    option.value = category.id;
    option.textContent = category.enabled ? category.label : `${category.label} · prossimamente`;
    option.disabled = !category.enabled;
    return option;
  });
  elements.category.replaceChildren(...options);
  elements.category.value = categories.some((category) => category.id === currentValue && category.enabled)
    ? currentValue : categories.find((category) => category.enabled)?.id || 'movie';
  updateSearchPlaceholder();
}
function itemDisplayTitle(item) {
  if (item.kind === 'series') return item.title;
  if (item.kind === 'episode') {
    const token = item.seasonNumber != null && item.episodeNumber != null
      ? `S${String(item.seasonNumber).padStart(2, '0')}E${String(item.episodeNumber).padStart(2, '0')}` : 'Episodio';
    return `${token} · ${item.title}`;
  }
  if (item.kind === 'music-track') {
    return item.trackNumber == null
      ? item.title
      : `${String(item.trackNumber).padStart(2, '0')} · ${item.title}`;
  }
  if (item.kind === 'music-album') return item.title;
  return item.title;
}
function musicArtistNames(item) {
  return (item.artists || []).map((artist) => artist?.name || artist).filter(Boolean);
}
function renderResults() {
  const hasSearch = Boolean(elements.search.value.trim());
  elements.count.textContent = String(state.items.length);
  if (!state.items.length) {
    elements.results.innerHTML = hasSearch
      ? '<div class="results-empty">Nessun contenuto trovato per questa ricerca.</div>'
      : '<div class="results-empty"> </div>';
    return;
  }
  const fragment = document.createDocumentFragment();
  let activeSeriesTitle = '';
  let activeSeason = null;
  for (const item of state.items) {
    if (item.kind === 'series') {
      activeSeriesTitle = item.title || 'Serie';
      activeSeason = null;
      const heading = document.createElement('div');
      heading.className = 'series-tree-title';
      heading.textContent = activeSeriesTitle;
      fragment.appendChild(heading);
    } else if (item.kind === 'episode') {
      const seasonNumber = Number(item.seasonNumber) || 1;
      if (seasonNumber !== activeSeason) {
        activeSeason = seasonNumber;
        const season = document.createElement('div');
        season.className = 'series-season-label';
        season.textContent = `Stagione ${seasonNumber}`;
        fragment.appendChild(season);
      }
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'result-item';
    button.classList.toggle('active', String(item.id) === String(state.selectedId));
    button.classList.toggle('series-root-item', item.kind === 'series');
    button.classList.toggle('series-episode-item', item.kind === 'episode');
    button.classList.toggle('music-track-item', item.kind === 'music-track');
    button.classList.toggle('music-album-item', item.kind === 'music-album');
    button.dataset.itemId = item.id;
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(String(item.id) === String(state.selectedId)));

    const title = document.createElement('span');
    title.className = 'result-title';
    title.textContent = item.kind === 'series' ? 'Generale' : itemDisplayTitle(item);
    const file = document.createElement('span');
    file.className = 'result-file';
    if (item.kind === 'series') file.textContent = activeSeriesTitle;
    else if (item.kind === 'music-track') file.textContent = item.albumTitle || 'Album non indicato';
    else if (item.kind === 'music-album') file.textContent = `${Number(item.trackCount) || 0} brani`;
    else file.textContent = item.fileName;
    button.append(title, file);

    if (item.kind === 'series' || item.kind === 'music-track' || item.kind === 'music-album') {
      const meta = document.createElement('span');
      meta.className = 'result-meta';
      meta.textContent = item.kind === 'series'
        ? (item.year ? String(item.year) : 'Metadati generali')
        : [musicArtistNames(item).join(', ') || 'Artista non indicato', item.kind === 'music-album' && item.year ? item.year : null]
          .filter(Boolean).join(' · ');
      button.appendChild(meta);
    }
    button.addEventListener('click', () => selectItem(item.id));
    fragment.appendChild(button);
  }
  elements.results.replaceChildren(fragment);
}
async function loadItems() {
  const serial = ++state.requestSerial;
  const search = elements.search.value.trim();

  // L'editor non deve mai caricare il catalogo completo: senza una ricerca
  // esplicita l'elenco resta vuoto e non parte nessuna richiesta /api/metadata/items.
  if (!search) {
    state.items = [];
    clearSelection();
    renderResults();
    return;
  }

  const params = new URLSearchParams({ category: elements.category.value, search, limit: '200' });
  if (elements.category.value === 'music') params.set('musicScope', state.musicScope);
  const payload = await window.BaiaPage.apiRequest(`/api/metadata/items?${params}`);
  if (serial !== state.requestSerial) return;
  state.items = payload.items || [];
  if (!state.items.some((item) => String(item.id) === String(state.selectedId))) clearSelection();
  renderResults();
}
function clearPosterObjectUrl() {
  if (state.posterObjectUrl) URL.revokeObjectURL(state.posterObjectUrl);
  state.posterObjectUrl = null;
}
function clearMusicCoverObjectUrl() {
  if (state.musicCoverObjectUrl) URL.revokeObjectURL(state.musicCoverObjectUrl);
  state.musicCoverObjectUrl = null;
}
function showPoster(url) {
  if (!url) {
    elements.posterPreview.hidden = true;
    elements.posterPreview.removeAttribute('src');
    elements.posterFallback.hidden = false;
    return;
  }
  window.BaiaPage.setMediaSrc(elements.posterPreview, url);
  elements.posterPreview.hidden = false;
  elements.posterFallback.hidden = true;
}
async function showMusicCover(url) {
  const serial = ++state.coverRequestSerial;
  clearMusicCoverObjectUrl();
  elements.posterPreview.hidden = true;
  elements.posterPreview.removeAttribute('src');
  elements.posterFallback.hidden = false;
  elements.posterFallback.textContent = 'Nessuna copertina incorporata';
  if (!url) return;
  try {
    const separator = url.includes('?') ? '&' : '?';
    const response = await window.BaiaPage.apiFetch(`${url}${separator}t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) return;
    const blob = await response.blob();
    if (serial !== state.coverRequestSerial) return;
    state.musicCoverObjectUrl = URL.createObjectURL(blob);
    elements.posterPreview.src = state.musicCoverObjectUrl;
    elements.posterPreview.hidden = false;
    elements.posterFallback.hidden = true;
  } catch {
    if (serial === state.coverRequestSerial) elements.posterFallback.hidden = false;
  }
}
function setPosterMode(item) {
  const musicTrack = item.kind === 'music-track';
  const musicAlbum = item.kind === 'music-album';
  const music = musicTrack || musicAlbum;
  elements.posterEditor.classList.toggle('music-cover-mode', music);
  elements.posterHeading.textContent = music ? 'Copertina incorporata' : 'Copertina';
  elements.posterDescription.hidden = musicTrack;
  elements.posterDescription.textContent = musicAlbum
    ? 'JPEG o PNG, massimo 6 MB e 8000 × 8000 pixel. L’immagine non viene ridimensionata e sarà incorporata in tutti i brani dell’album.'
    : 'JPG, PNG, WebP o AVIF, massimo 6 MB. La nuova immagine viene salvata nella cartella dati del server.';
  elements.posterUploadControls.hidden = musicTrack;
  elements.musicCoverRemove.hidden = !musicAlbum;
  elements.musicCoverNotice.hidden = !musicTrack;
  elements.posterFallback.textContent = music ? 'Nessuna copertina incorporata' : 'Nessuna copertina';
  elements.posterInput.accept = musicAlbum
    ? 'image/jpeg,image/png'
    : 'image/jpeg,image/png,image/webp,image/avif';
}
function setEditorMode(item) {
  const episode = item.kind === 'episode';
  const movie = item.kind === 'movie';
  const reading = item.kind === 'reading';
  const musicTrack = item.kind === 'music-track';
  const musicAlbum = item.kind === 'music-album';
  const music = musicTrack || musicAlbum;
  elements.form.classList.toggle('music-editor-mode', music);
  elements.form.classList.toggle('music-album-editor-mode', musicAlbum);
  elements.titleLabel.textContent = musicAlbum ? 'Album' : 'Titolo';
  elements.yearField.hidden = episode;
  elements.directorField.hidden = !(movie || reading);
  elements.directorLabel.textContent = reading ? 'Autore' : 'Regista';
  elements.genresField.hidden = episode;
  elements.musicFields.hidden = !music;
  elements.posterEditor.hidden = episode;
  elements.seasonField.hidden = !episode;
  elements.episodeField.hidden = !episode;
  elements.year.disabled = episode;
  elements.year.min = music ? '1' : reading ? '1000' : '1888';
  elements.year.max = music ? '9999' : '2200';
  elements.director.disabled = !(movie || reading);
  elements.genres.disabled = episode;
  elements.posterInput.disabled = episode || musicTrack;
  elements.season.disabled = !episode;
  elements.episode.disabled = !episode;
  for (const input of musicInputs) input.disabled = !music;
  elements.musicArtists.disabled = !musicTrack;
  elements.musicAlbum.disabled = !musicTrack;
  elements.musicTrackNumber.disabled = !musicTrack;
  elements.musicDiscNumber.disabled = !musicTrack;
  elements.musicComposers.disabled = !musicTrack;
  elements.musicComment.disabled = !musicTrack;
  elements.musicAlbumArtists.disabled = !music;
  elements.musicDate.disabled = !music;
  elements.musicTrackTotal.disabled = !music;
  elements.musicDiscTotal.disabled = !music;
  elements.musicCompilation.disabled = !music;

  elements.musicArtistsField.hidden = !musicTrack;
  elements.musicAlbumField.hidden = musicAlbum;
  elements.musicTrackNumberField.hidden = !musicTrack;
  elements.musicDiscNumberField.hidden = !musicTrack;
  elements.musicComposersField.hidden = !musicTrack;
  elements.musicCommentField.hidden = !musicTrack;
  elements.musicAlbumArtistsField.hidden = !music;
  elements.musicDateField.hidden = !music;
  elements.musicTrackTotalField.hidden = !music;
  elements.musicDiscTotalField.hidden = !music;
  elements.musicCompilationField.hidden = !music;
  elements.musicAlbumTrackPreview.hidden = !musicAlbum;
  elements.musicPropertiesHeading.textContent = musicAlbum ? 'Modifica collettiva' : 'Proprietà del file';
  elements.genres.placeholder = music ? 'Rock, Heavy Metal' : 'Azione, Avventura, Fantascienza';
  setPosterMode(item);
}
function musicLogicalLocation(item) {
  const albumArtists = item.current?.albumArtists || item.current?.artists || [];
  const artist = albumArtists[0] || 'Artista non indicato';
  const album = item.current?.album || 'Album non indicato';
  return `${artist} / ${album} / ${item.fileName || item.current?.title || 'Brano'}`;
}
function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  const remaining = total % 60;
  return `${minutes}:${String(remaining).padStart(2, '0')}`;
}
function musicPropertiesText(item) {
  const properties = item.properties || {};
  const parts = [];
  const extension = String(item.fileName || '').split('.').pop();
  if (extension && extension !== item.fileName) parts.push(extension.toUpperCase());
  if (properties.codec) parts.push(properties.codec);
  if (Number(properties.durationSeconds) > 0) parts.push(formatDuration(properties.durationSeconds));
  if (Number(properties.bitrateKbps) > 0) parts.push(`${Math.round(properties.bitrateKbps)} kbps`);
  if (Number(properties.sampleRateHz) > 0) parts.push(`${Math.round(properties.sampleRateHz / 100) / 10} kHz`);
  if (Number(properties.channels) > 0) parts.push(`${properties.channels} canali`);
  if (Number(properties.bitsPerSample) > 0) parts.push(`${properties.bitsPerSample} bit`);
  if (properties.isLossless === true) parts.push('lossless');
  return parts.join(' · ') || 'Proprietà tecniche non disponibili.';
}

function musicAlbumLogicalLocation(item) {
  const current = item.current || {};
  const artist = (current.albumArtists || [])[0] || 'Artista non indicato';
  return `${artist} / ${current.album || 'Album non indicato'} · ${Number(item.trackCount) || 0} brani`;
}
function renderMusicAlbumTracks(item) {
  const tracks = Array.isArray(item.tracks) ? item.tracks : [];
  elements.musicAlbumTrackCount.textContent = `${tracks.length} ${tracks.length === 1 ? 'file' : 'file'}`;
  const mixed = Array.isArray(item.mixedFields) ? item.mixedFields : [];
  const mixedLabels = {
    album: 'album', albumArtists: 'artisti album', genres: 'generi', date: 'data',
    year: 'anno', trackTotal: 'totale tracce', discTotal: 'totale dischi', compilation: 'compilation',
  };
  elements.musicAlbumMixedNotice.hidden = mixed.length === 0;
  elements.musicAlbumMixedNotice.textContent = mixed.length
    ? `Valori non uniformi rilevati nei file: ${mixed.map((key) => mixedLabels[key] || key).join(', ')}. Il salvataggio li renderà uguali su tutto l’album.`
    : '';
  const fragment = document.createDocumentFragment();
  for (const track of tracks) {
    const row = document.createElement('div');
    row.className = 'music-album-track-row';
    const number = document.createElement('span');
    number.className = 'music-album-track-number';
    const discPrefix = Number(track.discNumber) > 1 ? `D${track.discNumber} · ` : '';
    number.textContent = `${discPrefix}${track.trackNumber == null ? '—' : String(track.trackNumber).padStart(2, '0')}`;
    const content = document.createElement('span');
    content.className = 'music-album-track-content';
    const title = document.createElement('strong');
    title.textContent = track.title || 'Brano senza titolo';
    const meta = document.createElement('small');
    meta.textContent = (track.artists || []).join(', ') || track.fileName || 'Artista non indicato';
    content.append(title, meta);
    row.append(number, content);
    fragment.appendChild(row);
  }
  elements.musicAlbumTrackList.replaceChildren(fragment);
}
function fillMusicAlbumFields(item) {
  const current = item.current || {};
  elements.musicArtists.value = '';
  elements.musicAlbum.value = current.album || '';
  elements.musicAlbumArtists.value = (current.albumArtists || []).join(', ');
  elements.musicDate.value = current.date || '';
  elements.musicTrackNumber.value = '';
  elements.musicTrackTotal.value = current.trackTotal ?? '';
  elements.musicDiscNumber.value = '';
  elements.musicDiscTotal.value = current.discTotal ?? '';
  elements.musicComposers.value = '';
  elements.musicComment.value = '';
  elements.musicCompilation.checked = current.compilation === true;
  elements.musicProperties.textContent = `${Number(item.trackCount) || 0} file verranno aggiornati in un’unica operazione con rollback completo.`;
  renderMusicAlbumTracks(item);
}
function fillMusicFields(item) {
  const current = item.current || {};
  elements.musicArtists.value = (current.artists || []).join(', ');
  elements.musicAlbum.value = current.album || '';
  elements.musicAlbumArtists.value = (current.albumArtists || []).join(', ');
  elements.musicDate.value = current.date || '';
  elements.musicTrackNumber.value = current.trackNumber ?? '';
  elements.musicTrackTotal.value = current.trackTotal ?? '';
  elements.musicDiscNumber.value = current.discNumber ?? '';
  elements.musicDiscTotal.value = current.discTotal ?? '';
  elements.musicComposers.value = (current.composers || []).join(', ');
  elements.musicComment.value = current.comment || '';
  elements.musicCompilation.checked = current.compilation === true;
  elements.musicProperties.textContent = musicPropertiesText(item);
}
function fillForm(item) {
  state.selected = item;
  state.posterDataUrl = null;
  state.musicCoverAction = 'keep';
  clearPosterObjectUrl();
  state.coverRequestSerial += 1;
  clearMusicCoverObjectUrl();
  elements.posterInput.value = '';
  elements.posterFileName.textContent = 'Nessun nuovo file selezionato';
  elements.musicCoverRemove.disabled = item.kind !== 'music-album' || item.hasCoverArt !== true;
  elements.delete.hidden = item.kind === 'episode' || item.kind === 'music-track';
  elements.delete.disabled = false;
  elements.empty.hidden = true;
  elements.form.hidden = false;
  setEditorMode(item);
  const musicTrack = item.kind === 'music-track';
  const musicAlbum = item.kind === 'music-album';
  const music = musicTrack || musicAlbum;
  elements.selectedCategory.textContent = musicAlbum
    ? 'Musica · album · tag incorporati'
    : musicTrack ? 'Musica · brano · tag incorporati'
      : item.kind === 'episode' ? 'Episodio' : item.kind === 'series' ? 'Serie' : categoryLabel(item.category);
  elements.selectedFile.textContent = musicAlbum
    ? item.current.album
    : item.kind === 'series' ? `Generale · ${item.current.title}` : item.fileName;
  elements.selectedPath.textContent = musicAlbum
    ? musicAlbumLogicalLocation(item)
    : musicTrack ? musicLogicalLocation(item) : (item.relativePath || '—');
  elements.title.value = musicAlbum ? (item.current.album || '') : (item.current.title || '');
  elements.year.value = item.current.year ?? '';
  elements.director.value = item.current.author || item.current.director || '';
  elements.genres.value = (item.current.genres || []).join(', ');
  elements.season.value = item.seasonNumber ?? 1;
  elements.episode.value = item.episodeNumber ?? 1;
  if (music) {
    if (musicAlbum) fillMusicAlbumFields(item);
    else fillMusicFields(item);
    void showMusicCover(item.hasCoverArt ? item.coverUrl : null);
    elements.save.textContent = musicAlbum ? `Salva su ${Number(item.trackCount) || 0} brani` : 'Salva';
  } else {
    updateSaveButtonLabel();
    showPoster(item.current.posterUrl ? `${item.current.posterUrl}${item.current.posterUrl.includes('?') ? '&' : '?'}t=${Date.now()}` : null);
  }
}
function musicEntityFromId(value) {
  const text = String(value || '');
  if (text.startsWith('music-album:')) return { kind: 'album', id: text.slice(12) };
  if (text.startsWith('music:')) return { kind: 'track', id: text.slice(6) };
  return null;
}
async function selectItem(id) {
  state.selectedId = String(id);
  renderResults();
  const musicEntity = musicEntityFromId(state.selectedId);
  const musicTrackId = musicEntity?.kind === 'track' ? musicEntity.id : null;
  const musicAlbumId = musicEntity?.kind === 'album' ? musicEntity.id : null;
  const endpoint = musicAlbumId
    ? `/api/metadata/music/albums/${encodeURIComponent(musicAlbumId)}`
    : musicTrackId
      ? `/api/metadata/music/tracks/${encodeURIComponent(musicTrackId)}`
      : `/api/metadata/items/${encodeURIComponent(state.selectedId)}`;
  const payload = await window.BaiaPage.apiRequest(endpoint);
  if (String(state.selectedId) !== String(id)) return;
  fillForm(payload.item);
}
function clearSelection() {
  state.selectedId = null;
  state.selected = null;
  state.posterDataUrl = null;
  state.musicCoverAction = 'keep';
  state.coverRequestSerial += 1;
  clearPosterObjectUrl();
  clearMusicCoverObjectUrl();
  elements.delete.hidden = true;
  elements.delete.disabled = true;
  elements.form.hidden = true;
  elements.empty.hidden = false;
}
function resetForm() { if (state.selected) fillForm(state.selected); }
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Impossibile leggere la copertina.'));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}
async function handlePosterSelection() {
  const file = elements.posterInput.files?.[0];
  if (!file) return;
  const musicAlbum = state.selected?.kind === 'music-album';
  if (file.size > 6 * 1024 * 1024) {
    elements.posterInput.value = '';
    window.BaiaPage.shellToast('La copertina supera 6 MB');
    return;
  }
  if (musicAlbum && !['image/jpeg', 'image/png'].includes(file.type)) {
    elements.posterInput.value = '';
    window.BaiaPage.shellToast('Per gli album musicali sono ammessi soltanto JPEG e PNG');
    return;
  }
  try {
    state.posterDataUrl = await fileToDataUrl(file);
    if (musicAlbum) state.musicCoverAction = 'replace';
    clearPosterObjectUrl();
    state.posterObjectUrl = URL.createObjectURL(file);
    showPoster(state.posterObjectUrl);
    elements.posterFileName.textContent = musicAlbum
      ? `${file.name} · verrà incorporata al salvataggio`
      : file.name;
    if (musicAlbum) elements.musicCoverRemove.disabled = false;
  } catch (error) { window.BaiaPage.shellToast(error.message); }
}
function handleMusicCoverRemoval() {
  if (state.selected?.kind !== 'music-album') return;
  state.musicCoverAction = 'remove';
  state.posterDataUrl = null;
  elements.posterInput.value = '';
  clearPosterObjectUrl();
  clearMusicCoverObjectUrl();
  showPoster(null);
  elements.posterFallback.textContent = 'La copertina verrà eliminata';
  elements.posterFileName.textContent = 'Eliminazione programmata al prossimo salvataggio';
  elements.musicCoverRemove.disabled = true;
}
function parseSeparatedList(value) {
  return String(value || '').split(/[,;/|]+/).map((item) => item.trim()).filter(Boolean);
}
function parseGenresInput() {
  return parseSeparatedList(elements.genres.value);
}
function nullableInteger(input) {
  return input.value === '' ? null : Number.parseInt(input.value, 10);
}
function musicMetadataBody() {
  return {
    title: elements.title.value,
    artists: parseSeparatedList(elements.musicArtists.value),
    album: elements.musicAlbum.value,
    albumArtists: parseSeparatedList(elements.musicAlbumArtists.value),
    genres: parseGenresInput(),
    composers: parseSeparatedList(elements.musicComposers.value),
    comment: elements.musicComment.value,
    date: elements.musicDate.value,
    year: nullableInteger(elements.year),
    trackNumber: nullableInteger(elements.musicTrackNumber),
    trackTotal: nullableInteger(elements.musicTrackTotal),
    discNumber: nullableInteger(elements.musicDiscNumber),
    discTotal: nullableInteger(elements.musicDiscTotal),
    compilation: elements.musicCompilation.checked,
  };
}
function musicAlbumMetadataBody() {
  return {
    album: elements.title.value,
    albumArtists: parseSeparatedList(elements.musicAlbumArtists.value),
    genres: parseGenresInput(),
    date: elements.musicDate.value,
    year: nullableInteger(elements.year),
    trackTotal: nullableInteger(elements.musicTrackTotal),
    discTotal: nullableInteger(elements.musicDiscTotal),
    compilation: elements.musicCompilation.checked,
    coverAction: state.musicCoverAction,
    coverDataUrl: state.musicCoverAction === 'replace' ? state.posterDataUrl : null,
  };
}
function deleteTargetLabel(item) {
  if (!item) return 'questo contenuto';
  if (item.kind === 'music-album') return `l’album “${item.current?.album || item.current?.title || 'senza titolo'}”`;
  if (item.kind === 'series') return `la serie “${item.current?.title || 'senza titolo'}”`;
  if (item.kind === 'reading') return `${categoryLabel(item.category).toLowerCase()} “${item.current?.title || 'senza titolo'}”`;
  return `il film “${item.current?.title || 'senza titolo'}”`;
}
async function deleteSelectedContent() {
  const item = state.selected;
  if (!state.selectedId || !item || item.kind === 'episode' || item.kind === 'music-track') return;
  const target = deleteTargetLabel(item);
  const confirmed = window.confirm(
    `Eliminare definitivamente ${target}?

Verranno eliminati sia la cartella nella libreria media sia i relativi record nel database. Questa operazione non può essere annullata.`,
  );
  if (!confirmed) return;

  elements.delete.disabled = true;
  elements.cancel.disabled = true;
  elements.save.disabled = true;
  elements.delete.textContent = 'Eliminazione…';
  try {
    const endpoint = item.kind === 'music-album'
      ? `/api/metadata/music/albums/${encodeURIComponent(item.albumId)}`
      : `/api/metadata/items/${encodeURIComponent(state.selectedId)}`;
    const payload = await window.BaiaPage.apiRequest(endpoint, { method: 'DELETE' });
    const deletedCategory = item.kind === 'music-album' ? 'music' : item.category;
    clearSelection();
    await loadItems();
    window.BaiaPage.shellToast(payload.deleted?.cleanupPending
      ? 'Contenuto rimosso. La pulizia finale dei file temporanei sarà completata dal server.'
      : 'Contenuto eliminato definitivamente');
    if (window.parent !== window) {
      window.parent.postMessage({
        type: 'shell-metadata-updated',
        itemId: payload.deleted?.id || null,
        albumId: payload.deleted?.albumId || null,
        category: deletedCategory || null,
        deleted: true,
      }, window.location.origin);
    }
  } catch (error) {
    window.BaiaPage.shellToast(error.message);
  } finally {
    elements.delete.textContent = 'Elimina';
    elements.delete.disabled = !state.selected || state.selected.kind === 'episode' || state.selected.kind === 'music-track';
    elements.cancel.disabled = false;
    elements.save.disabled = false;
  }
}
function updateSaveButtonLabel() {
  elements.save.textContent = state.selected?.kind === 'music-album'
    ? `Salva su ${Number(state.selected.trackCount) || 0} brani`
    : 'Salva';
}
async function saveMetadata(event) {
  event.preventDefault();
  if (!state.selectedId || !elements.form.reportValidity()) return;
  elements.save.disabled = true;
  elements.cancel.disabled = true;
  elements.delete.disabled = true;
  elements.save.textContent = 'Salvataggio…';
  try {
    let body;
    let endpoint = `/api/metadata/items/${encodeURIComponent(state.selectedId)}`;
    if (state.selected?.kind === 'music-album') {
      const count = Number(state.selected.trackCount) || 0;
      const confirmed = window.confirm(`Verranno modificati i tag incorporati di ${count} ${count === 1 ? 'file' : 'file'}. Continuare?`);
      if (!confirmed) return;
      body = musicAlbumMetadataBody();
      endpoint = `/api/metadata/music/albums/${encodeURIComponent(state.selected.albumId)}`;
    } else if (state.selected?.kind === 'music-track') {
      body = musicMetadataBody();
      endpoint = `/api/metadata/music/tracks/${encodeURIComponent(state.selected.trackId)}`;
    } else if (state.selected?.kind === 'episode') {
      body = { title: elements.title.value, seasonNumber: elements.season.value, episodeNumber: elements.episode.value };
    } else if (state.selected?.kind === 'series') {
      body = { title: elements.title.value, year: elements.year.value || null, genres: parseGenresInput(), posterDataUrl: state.posterDataUrl };
    } else if (state.selected?.kind === 'reading') {
      body = { title: elements.title.value, year: elements.year.value || null, genres: parseGenresInput(), author: elements.director.value, posterDataUrl: state.posterDataUrl };
    } else {
      body = { title: elements.title.value, year: elements.year.value || null, genres: parseGenresInput(), director: elements.director.value, posterDataUrl: state.posterDataUrl };
    }
    const payload = await window.BaiaPage.apiRequest(endpoint, {
      method: 'PUT', body: JSON.stringify(body),
    });
    fillForm(payload.item);
    const musicTrack = payload.item?.kind === 'music-track';
    const musicAlbum = payload.item?.kind === 'music-album';
    const music = musicTrack || musicAlbum;
    const message = musicAlbum && payload.item.destinationChanged
      ? 'Metadati dell’album salvati e file ricollocati'
      : musicAlbum ? 'Metadati dell’album salvati su tutti i brani'
        : musicTrack && payload.item.destinationChanged
          ? 'Tag incorporati salvati e file ricollocato'
          : musicTrack ? 'Tag incorporati salvati' : 'Metadati salvati';
    window.BaiaPage.shellToast(message);
    if (window.parent !== window) {
      window.parent.postMessage({
        type: 'shell-metadata-updated',
        itemId: state.selectedId,
        trackId: payload.item?.trackId || null,
        albumId: payload.item?.albumId || null,
        category: music ? 'music' : state.selected?.category || null,
      }, window.location.origin);
    }
    await loadItems();
  } catch (error) { window.BaiaPage.shellToast(error.message); }
  finally {
    elements.save.disabled = false;
    elements.cancel.disabled = false;
    elements.delete.disabled = !state.selected || state.selected.kind === 'episode' || state.selected.kind === 'music-track';
    updateSaveButtonLabel();
  }
}
async function loadCategories() {
  try {
    const payload = await window.BaiaPage.apiRequest('/api/metadata/status');
    renderCategories(payload.categories);
  } catch {}
}
elements.category.addEventListener('change', () => {
  updateSearchPlaceholder();
  clearSelection();
  loadItems().catch((error) => window.BaiaPage.shellToast(error.message));
});
for (const button of elements.musicScopeButtons) {
  button.addEventListener('click', () => {
    const nextScope = button.dataset.musicScope === 'album' ? 'album' : 'track';
    if (nextScope === state.musicScope) return;
    state.musicScope = nextScope;
    updateSearchPlaceholder();
    clearSelection();
    loadItems().catch((error) => window.BaiaPage.shellToast(error.message));
  });
}
elements.search.addEventListener('input', () => {
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => loadItems().catch((error) => window.BaiaPage.shellToast(error.message)), 180);
});
elements.posterInput.addEventListener('change', handlePosterSelection);
elements.musicCoverRemove.addEventListener('click', handleMusicCoverRemoval);
elements.delete.addEventListener('click', deleteSelectedContent);
elements.cancel.addEventListener('click', resetForm);
elements.form.addEventListener('submit', saveMetadata);
window.addEventListener('beforeunload', () => {
  clearPosterObjectUrl();
  clearMusicCoverObjectUrl();
});
suppressInputHistory();
loadCategories().finally(() => loadItems().catch((error) => window.BaiaPage.shellToast(error.message)));
