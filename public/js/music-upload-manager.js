(() => {
  'use strict';

  const elements = {
    panel: document.querySelector('#musicUploadPanel'),
    filePicker: document.querySelector('#musicFilePicker'),
    files: document.querySelector('#musicFilesInput'),
    filePickerTitle: document.querySelector('#musicFilePickerTitle'),
    filePickerInfo: document.querySelector('#musicFilePickerInfo'),
    sessionSummary: document.querySelector('#musicSessionSummary'),
    sessionDetail: document.querySelector('#musicSessionDetail'),
    trackList: document.querySelector('#musicTrackList'),
    uploadLayout: document.querySelector('#musicUploadLayout'),
    trackEditor: document.querySelector('#musicTrackEditor'),
    editorCard: document.querySelector('#musicEditorCard'),
    editorTitle: document.querySelector('#musicEditorTitle'),
    editorStatus: document.querySelector('#musicEditorStatus'),
    originalFile: document.querySelector('#musicOriginalFile'),
    title: document.querySelector('#musicTitleInput'),
    artist: document.querySelector('#musicArtistInput'),
    album: document.querySelector('#musicAlbumInput'),
    albumArtist: document.querySelector('#musicAlbumArtistInput'),
    trackNumber: document.querySelector('#musicTrackNumberInput'),
    trackTotal: document.querySelector('#musicTrackTotalInput'),
    discNumber: document.querySelector('#musicDiscNumberInput'),
    discTotal: document.querySelector('#musicDiscTotalInput'),
    year: document.querySelector('#musicYearInput'),
    date: document.querySelector('#musicDateInput'),
    genre: document.querySelector('#musicGenreInput'),
    composer: document.querySelector('#musicComposerInput'),
    comment: document.querySelector('#musicCommentInput'),
    compilation: document.querySelector('#musicCompilationInput'),
    formatFact: document.querySelector('#musicFormatFact'),
    durationFact: document.querySelector('#musicDurationFact'),
    coverFact: document.querySelector('#musicCoverFact'),
    destination: document.querySelector('#musicDestinationPath'),
    validation: document.querySelector('#musicValidationMessage'),
    saveTags: document.querySelector('#musicSaveTagsButton'),
    importTrack: document.querySelector('#musicImportTrackButton'),
    progress: document.querySelector('#musicUploadProgress'),
    progressBar: document.querySelector('#musicProgressBar'),
    progressLabel: document.querySelector('#musicProgressLabel'),
    progressPercent: document.querySelector('#musicProgressPercent'),
    message: document.querySelector('#musicUploadMessage'),
    cancelSession: document.querySelector('#musicCancelSessionButton'),
    importReady: document.querySelector('#musicImportReadyButton'),
  };

  if (!elements.panel) return;

  const editableInputs = [
    elements.title,
    elements.artist,
    elements.album,
    elements.albumArtist,
    elements.trackNumber,
    elements.trackTotal,
    elements.discNumber,
    elements.discTotal,
    elements.year,
    elements.date,
    elements.genre,
    elements.composer,
    elements.comment,
    elements.compilation,
  ];

  const state = {
    session: null,
    selectedTrackId: null,
    busy: false,
    dirty: false,
    maxMusicBytes: 0,
    supportedExtensions: ['.mp3', '.flac', '.wav'],
    capabilitiesReady: false,
  };

  function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (!Number.isFinite(value) || value <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
    return `${(value / (1024 ** index)).toFixed(index >= 3 ? 1 : 0)} ${units[index]}`;
  }

  function formatDuration(seconds) {
    const value = Math.max(0, Math.round(Number(seconds || 0)));
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const remaining = value % 60;
    return hours > 0
      ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
      : `${minutes}:${String(remaining).padStart(2, '0')}`;
  }

  function splitList(value) {
    return String(value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function integerOrEmpty(value) {
    const text = String(value ?? '').trim();
    if (!text) return '';
    const parsed = Number.parseInt(text, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : '';
  }

  function showMessage(message, isError = false) {
    elements.message.textContent = message || '';
    elements.message.classList.toggle('error', Boolean(isError));
    elements.message.hidden = !message;
  }

  function setProgress(loaded, total, label = 'Caricamento dei brani') {
    const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
    elements.progress.hidden = false;
    elements.progressBar.style.width = `${percent}%`;
    elements.progressPercent.textContent = `${percent}%`;
    elements.progressLabel.textContent = percent >= 100
      ? 'Lettura dei tag incorporati…'
      : `${label} · ${formatBytes(loaded)} di ${formatBytes(total)}`;
  }

  function hideProgress() {
    elements.progress.hidden = true;
    elements.progressBar.style.width = '0%';
    elements.progressPercent.textContent = '0%';
    elements.progressLabel.textContent = 'Preparazione caricamento…';
  }

  function currentTrack() {
    return state.session?.tracks?.find((track) => track.trackId === state.selectedTrackId) || null;
  }

  function pendingTracks() {
    return (state.session?.tracks || []).filter((track) => track.status === 'pending');
  }

  function readyTracks() {
    return pendingTracks().filter((track) => track.readyToImport);
  }

  function replaceTrack(updatedTrack) {
    if (!state.session || !updatedTrack?.trackId) return;
    const index = state.session.tracks.findIndex((track) => track.trackId === updatedTrack.trackId);
    if (index >= 0) state.session.tracks[index] = updatedTrack;
  }

  function trackStatus(track) {
    if (track.status === 'imported') return { text: 'Importato', className: 'imported' };
    if (track.readyToImport) return { text: 'Pronto', className: 'ready' };
    return { text: 'Da correggere', className: 'invalid' };
  }

  function setInputsDisabled(disabled) {
    editableInputs.forEach((input) => { input.disabled = disabled; });
  }

  function setBusy(busy) {
    state.busy = Boolean(busy);
    elements.files.disabled = state.busy || Boolean(state.session) || !state.capabilitiesReady;
    elements.filePicker.classList.toggle('is-disabled', elements.files.disabled);
    elements.cancelSession.disabled = state.busy || !state.session;
    const track = currentTrack();
    const editable = Boolean(track && track.status === 'pending');
    setInputsDisabled(state.busy || !editable);
    elements.saveTags.disabled = state.busy || !editable || !state.dirty;
    elements.importTrack.disabled = state.busy || !editable || state.dirty || !track?.readyToImport;
    elements.importReady.disabled = state.busy || state.dirty || readyTracks().length === 0;
  }

  function renderTrackList() {
    elements.trackList.replaceChildren();
    const tracks = state.session?.tracks || [];
    if (!tracks.length) {
      const empty = document.createElement('p');
      empty.className = 'music-empty-list';
      empty.textContent = 'La sessione è vuota.';
      elements.trackList.append(empty);
      return;
    }

    tracks.forEach((track, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'music-track-item';
      button.classList.toggle('active', track.trackId === state.selectedTrackId);
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(track.trackId === state.selectedTrackId));
      button.addEventListener('click', () => {
        if (state.dirty && track.trackId !== state.selectedTrackId) {
          showMessage('Salva o annulla le modifiche del brano corrente prima di cambiare selezione.', true);
          return;
        }
        state.selectedTrackId = track.trackId;
        state.dirty = false;
        renderSession();
      });

      const indexNode = document.createElement('span');
      indexNode.className = 'music-track-index';
      indexNode.textContent = String(index + 1).padStart(2, '0');

      const copy = document.createElement('span');
      copy.className = 'music-track-item-copy';
      const title = document.createElement('strong');
      title.textContent = track.tags?.title || track.imported?.title || track.originalName || 'Brano';
      const subtitle = document.createElement('span');
      subtitle.textContent = track.tags?.album || track.originalName || '';
      copy.append(title, subtitle);

      const status = trackStatus(track);
      const badge = document.createElement('span');
      badge.className = `music-track-status ${status.className}`;
      badge.textContent = status.text;
      button.append(indexNode, copy, badge);
      elements.trackList.append(button);
    });
  }

  function fillEditor(track) {
    if (!track) {
      elements.uploadLayout.classList.remove('has-editor');
      elements.trackEditor.hidden = true;
      elements.editorCard.hidden = true;
      setBusy(state.busy);
      return;
    }

    elements.uploadLayout.classList.add('has-editor');
    elements.trackEditor.hidden = false;
    elements.editorCard.hidden = false;
    const tags = track.tags || {};
    const status = trackStatus(track);
    elements.editorTitle.textContent = tags.title || track.imported?.title || track.originalName || 'Brano';
    elements.editorStatus.textContent = status.text;
    elements.editorStatus.className = `music-track-status ${status.className}`;
    elements.originalFile.textContent = track.originalName || 'File caricato';

    elements.title.value = tags.title || '';
    elements.artist.value = (tags.artists || []).join(', ');
    elements.album.value = tags.album || '';
    elements.albumArtist.value = (tags.albumArtists || []).join(', ');
    elements.trackNumber.value = tags.trackNumber || '';
    elements.trackTotal.value = tags.trackTotal || '';
    elements.discNumber.value = tags.discNumber || '';
    elements.discTotal.value = tags.discTotal || '';
    elements.year.value = tags.year || '';
    elements.date.value = tags.date || '';
    elements.genre.value = (tags.genres || []).join(', ');
    elements.composer.value = (tags.composers || []).join(', ');
    elements.comment.value = tags.comment || '';
    elements.compilation.checked = tags.compilation === true;

    const properties = track.properties || {};
    elements.formatFact.textContent = `Formato: ${String(track.format || track.extension || '—').replace(/^\./, '').toUpperCase()}`;
    elements.durationFact.textContent = `Durata: ${formatDuration(properties.durationSeconds)}`;
    elements.coverFact.textContent = `Copertina: ${track.hasCoverArt ? 'incorporata' : 'assente'}`;
    elements.destination.textContent = track.proposedRelativePath || 'Salva i tag obbligatori per calcolare la destinazione.';
    elements.validation.textContent = track.validation?.message || (track.status === 'imported'
      ? 'Il brano è già stato importato nella libreria.'
      : 'Il file è pronto per essere importato.');
    state.dirty = false;
    setBusy(state.busy);
  }

  function renderSession() {
    const tracks = state.session?.tracks || [];
    const pending = tracks.filter((track) => track.status === 'pending').length;
    const ready = tracks.filter((track) => track.status === 'pending' && track.readyToImport).length;
    const imported = tracks.filter((track) => track.status === 'imported').length;

    if (!state.session) {
      elements.sessionSummary.textContent = 'Nessun brano caricato';
      elements.sessionDetail.textContent = 'Seleziona i file per leggere i tag reali.';
      elements.filePickerTitle.textContent = 'Seleziona uno o più brani';
      elements.filePicker.classList.remove('has-file');
      state.selectedTrackId = null;
    } else {
      elements.sessionSummary.textContent = `${tracks.length} ${tracks.length === 1 ? 'brano' : 'brani'} nella sessione`;
      elements.sessionDetail.textContent = `${ready} pronti · ${pending - ready} da correggere · ${imported} importati`;
      elements.filePickerTitle.textContent = 'Sessione già aperta';
      elements.filePicker.classList.add('has-file');
      if (!tracks.some((track) => track.trackId === state.selectedTrackId)) {
        state.selectedTrackId = tracks.find((track) => track.status === 'pending')?.trackId || tracks[0]?.trackId || null;
      }
    }

    renderTrackList();
    fillEditor(currentTrack());
    setBusy(state.busy);
  }

  function validateFiles(files) {
    const selected = [...files];
    if (!selected.length) throw new Error('Seleziona almeno un file musicale.');
    if (selected.length > 100) throw new Error('È possibile caricare al massimo 100 brani per sessione.');
    const allowed = new Set(state.supportedExtensions.map((extension) => extension.toLowerCase()));
    selected.forEach((file) => {
      const extension = file.name.match(/\.[^.]+$/)?.[0]?.toLowerCase() || '';
      if (!allowed.has(extension)) throw new Error(`“${file.name}” non è un file MP3, FLAC o WAV.`);
      if (state.maxMusicBytes > 0 && file.size > state.maxMusicBytes) {
        throw new Error(`“${file.name}” supera il limite di ${formatBytes(state.maxMusicBytes)}.`);
      }
    });
    return selected;
  }

  async function uploadFiles(files) {
    const target = window.BaiaPage.apiUrl('/api/uploads/music/sessions');
    const authHeaders = await window.BaiaApi.requestAuthHeaders('POST', target);
    const data = new FormData();
    files.forEach((file) => data.append('audio', file));

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', target);
      xhr.responseType = 'json';
      Object.entries(authHeaders).forEach(([name, value]) => xhr.setRequestHeader(name, value));
      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) setProgress(event.loaded, event.total);
      });
      xhr.addEventListener('load', () => {
        const payload = xhr.response || (() => { try { return JSON.parse(xhr.responseText); } catch { return null; } })();
        window.BaiaPage.reportAccountAuthFailure(payload, xhr.status);
        if (xhr.status >= 200 && xhr.status < 300) resolve(payload);
        else reject(new Error(payload?.error || `Errore HTTP ${xhr.status}`));
      });
      xhr.addEventListener('error', () => reject(new Error('Connessione al server interrotta durante il caricamento.')));
      xhr.addEventListener('abort', () => reject(new Error('Caricamento annullato.')));
      xhr.send(data);
    });
  }

  async function uploadFilesNative(files) {
    return window.BaiaPage.nativeUpload({
      kind: 'music',
      fields: {},
      files: { audio: files.map((file) => file.token) },
    }, ({ loaded = 0, total = 0 }) => setProgress(loaded, total));
  }

  async function handleFileSelection(nativeFiles = null) {
    if (state.session) {
      elements.files.value = '';
      if (nativeFiles) {
        void window.BaiaPage.releaseNativeUploadFiles(nativeFiles.map((file) => file.token)).catch(() => {});
      }
      showMessage('Annulla o completa la sessione corrente prima di caricare altri file.', true);
      return;
    }

    let selected;
    try {
      selected = validateFiles(nativeFiles || elements.files.files || []);
    } catch (error) {
      elements.files.value = '';
      if (nativeFiles) {
        void window.BaiaPage.releaseNativeUploadFiles(nativeFiles.map((file) => file.token)).catch(() => {});
      }
      showMessage(error.message, true);
      return;
    }

    state.busy = true;
    setBusy(true);
    showMessage('');
    setProgress(0, selected.reduce((sum, file) => sum + file.size, 0));
    try {
      const payload = nativeFiles
        ? await uploadFilesNative(selected)
        : await uploadFiles(selected);
      state.session = payload.session;
      state.selectedTrackId = state.session?.tracks?.[0]?.trackId || null;
      state.dirty = false;
      showMessage('Tag incorporati letti. Verifica i brani prima dell’importazione.');
      window.BaiaPage.shellToast('Brani pronti per la verifica');
    } catch (error) {
      if (nativeFiles) {
        void window.BaiaPage.releaseNativeUploadFiles(selected?.map((file) => file.token) || []).catch(() => {});
      }
      showMessage(error.message, true);
    } finally {
      elements.files.value = '';
      state.busy = false;
      hideProgress();
      renderSession();
    }
  }

  async function pickNativeMusicFiles(event) {
    if (!window.BaiaPage.nativeUploadAvailable?.()) return;
    event.preventDefault();
    if (state.session) {
      showMessage('Annulla o completa la sessione corrente prima di caricare altri file.', true);
      return;
    }
    try {
      const selections = await window.BaiaPage.pickNativeUploadFiles('music-audio');
      if (selections.length) await handleFileSelection(selections);
    } catch (error) {
      showMessage(error.message, true);
    }
  }

  function editorPatch() {
    return {
      title: elements.title.value.trim(),
      artists: splitList(elements.artist.value),
      album: elements.album.value.trim(),
      albumArtists: splitList(elements.albumArtist.value),
      trackNumber: integerOrEmpty(elements.trackNumber.value),
      trackTotal: integerOrEmpty(elements.trackTotal.value),
      discNumber: integerOrEmpty(elements.discNumber.value),
      discTotal: integerOrEmpty(elements.discTotal.value),
      year: integerOrEmpty(elements.year.value),
      date: elements.date.value.trim(),
      genres: splitList(elements.genre.value),
      composers: splitList(elements.composer.value),
      comment: elements.comment.value.trim(),
      compilation: elements.compilation.checked,
    };
  }

  async function saveSelectedTags() {
    const track = currentTrack();
    if (!state.session || !track || track.status !== 'pending') return;
    state.busy = true;
    setBusy(true);
    showMessage('');
    try {
      const payload = await window.BaiaPage.apiRequest(
        `/api/uploads/music/sessions/${encodeURIComponent(state.session.sessionId)}/tracks/${encodeURIComponent(track.trackId)}/tags`,
        { method: 'PUT', body: JSON.stringify(editorPatch()) },
      );
      replaceTrack(payload.track);
      state.dirty = false;
      showMessage('I tag sono stati scritti realmente nel file temporaneo.');
      renderSession();
    } catch (error) {
      showMessage(error.message, true);
    } finally {
      state.busy = false;
      setBusy(false);
    }
  }

  async function commitTrack(track) {
    const payload = await window.BaiaPage.apiRequest(
      `/api/uploads/music/sessions/${encodeURIComponent(state.session.sessionId)}/tracks/${encodeURIComponent(track.trackId)}/commit`,
      { method: 'POST', body: '{}' },
    );
    const localTrack = currentTrack()?.trackId === track.trackId ? currentTrack() : track;
    replaceTrack({
      ...localTrack,
      status: 'imported',
      readyToImport: false,
      imported: payload.imported,
    });
    return payload;
  }

  async function importSelectedTrack() {
    const track = currentTrack();
    if (!track?.readyToImport || state.dirty || state.busy) return;
    state.busy = true;
    setBusy(true);
    showMessage('');
    try {
      const payload = await commitTrack(track);
      window.BaiaPage.shellToast('Brano importato nella libreria');
      if (payload.sessionComplete) {
        const title = payload.imported?.title || track.tags?.title || 'Brano';
        state.session = null;
        state.selectedTrackId = null;
        showMessage(`“${title}” è stato importato nella libreria musicale.`);
      } else {
        state.selectedTrackId = pendingTracks()[0]?.trackId || null;
        showMessage('Brano importato. La sessione contiene ancora file da verificare.');
      }
      renderSession();
    } catch (error) {
      showMessage(error.message, true);
    } finally {
      state.busy = false;
      setBusy(false);
    }
  }

  async function importAllReadyTracks() {
    if (state.busy || state.dirty) return;
    const queue = readyTracks();
    if (!queue.length) return;
    state.busy = true;
    setBusy(true);
    showMessage('');
    let importedCount = 0;
    try {
      for (const track of queue) {
        if (!state.session) break;
        state.selectedTrackId = track.trackId;
        renderSession();
        elements.progress.hidden = false;
        const current = importedCount + 1;
        elements.progressBar.style.width = `${Math.round(current / queue.length * 100)}%`;
        elements.progressPercent.textContent = `${current}/${queue.length}`;
        elements.progressLabel.textContent = `Importazione di “${track.tags?.title || track.originalName}”…`;
        const payload = await commitTrack(track);
        importedCount += 1;
        if (payload.sessionComplete) {
          state.session = null;
          state.selectedTrackId = null;
          break;
        }
      }
      window.BaiaPage.shellToast(`${importedCount} ${importedCount === 1 ? 'brano importato' : 'brani importati'}`);
      showMessage(`${importedCount} ${importedCount === 1 ? 'brano è stato importato' : 'brani sono stati importati'} nella libreria musicale.`);
      if (state.session) state.selectedTrackId = pendingTracks()[0]?.trackId || null;
      renderSession();
    } catch (error) {
      showMessage(`${importedCount ? `${importedCount} importati. ` : ''}${error.message}`, true);
      renderSession();
    } finally {
      state.busy = false;
      hideProgress();
      setBusy(false);
    }
  }

  async function cancelSession() {
    if (!state.session || state.busy) return;
    state.busy = true;
    setBusy(true);
    showMessage('');
    try {
      await window.BaiaPage.apiRequest(
        `/api/uploads/music/sessions/${encodeURIComponent(state.session.sessionId)}/cancel`,
        { method: 'POST', body: '{}' },
      );
      state.session = null;
      state.selectedTrackId = null;
      state.dirty = false;
      showMessage('Sessione annullata. I file temporanei sono stati eliminati.');
    } catch (error) {
      showMessage(error.message, true);
    } finally {
      state.busy = false;
      renderSession();
    }
  }

  async function loadCapabilities() {
    try {
      const payload = await window.BaiaPage.apiRequest('/api/uploads/status');
      const music = (payload.categories || []).find((category) => category.id === 'music');
      if (music && music.enabled === false) throw new Error('L’upload musicale non è abilitato sul server.');
      const supported = Array.isArray(payload.supportedMusicExtensions)
        ? payload.supportedMusicExtensions.map((extension) => String(extension).toLowerCase())
        : [];
      if (supported.length) state.supportedExtensions = supported;
      state.maxMusicBytes = Number(payload.maxMusicBytes || 0);
      state.capabilitiesReady = true;
      elements.files.accept = state.supportedExtensions.join(',');
      elements.filePickerInfo.textContent = `${state.supportedExtensions.map((extension) => extension.replace(/^\./, '').toUpperCase()).join(', ')} · massimo 100 file${state.maxMusicBytes ? ` · ${formatBytes(state.maxMusicBytes)} per file` : ''}`;
      setBusy(state.busy);
    } catch (error) {
      state.capabilitiesReady = false;
      elements.files.disabled = true;
      elements.filePicker.classList.add('is-disabled');
      showMessage(error.message, true);
    }
  }

  editableInputs.forEach((input) => input.addEventListener('input', () => {
    const track = currentTrack();
    if (!track || track.status !== 'pending' || state.busy) return;
    state.dirty = true;
    showMessage('Le modifiche non sono ancora state scritte nel file.');
    setBusy(false);
  }));
  if (window.BaiaPage.nativeUploadAvailable?.()) {
    elements.files.addEventListener('click', pickNativeMusicFiles);
  }
  elements.files.addEventListener('change', () => {
    if (window.BaiaPage.nativeUploadAvailable?.()) {
      elements.files.value = '';
      return;
    }
    void handleFileSelection();
  });
  elements.saveTags.addEventListener('click', saveSelectedTags);
  elements.importTrack.addEventListener('click', importSelectedTrack);
  elements.importReady.addEventListener('click', importAllReadyTracks);
  elements.cancelSession.addEventListener('click', cancelSession);

  renderSession();
  loadCapabilities();
})();
