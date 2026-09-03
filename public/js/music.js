(() => {
  const state = {
    mode: 'home',
    searchReturnMode: 'home',
    searchReturnTitle: 'Musica',
    searchReturnScrollY: 0,
    searchPayload: null,
    detailReturnScrollY: 0,
    activeGenre: '',
    home: { recent: [], latest: [], recommended: [], summary: {} },
    filters: { genres: [], years: [] },
    catalog: [],
    catalogType: 'albums',
    searchTimer: null,
    searchRequest: 0,
    historyRefreshTimer: null,
    selectedAlbum: null,
    selectedArtist: null,
    selectedPlaylist: null,
    playlists: [],
    playlistEditorMode: 'create',
    pendingPlaylistTrack: null,
    detailFavoritesOnly: false,
    player: { currentTrack: null, playing: false, mode: 'normal' },
  };

  const elements = {
    browseView: document.querySelector('#browseView'),
    pageTitle: document.querySelector('#pageTitle'),
    homeButton: document.querySelector('#homeButton'),
    albumsButton: document.querySelector('#albumsButton'),
    artistsButton: document.querySelector('#artistsButton'),
    genreButton: document.querySelector('#genreButton'),
    searchView: document.querySelector('#searchView'),
    searchInput: document.querySelector('#searchInput'),
    searchClearButton: document.querySelector('#searchClearButton'),
    searchCount: document.querySelector('#searchCount'),
    searchEmpty: document.querySelector('#searchEmpty'),
    searchResults: document.querySelector('#searchResults'),
    homeView: document.querySelector('#homeView'),
    librarySummary: document.querySelector('#librarySummary'),
    recentRail: document.querySelector('#recentRail'),
    recentEmpty: document.querySelector('#recentEmpty'),
    latestRail: document.querySelector('#latestRail'),
    latestEmpty: document.querySelector('#latestEmpty'),
    recommendedRail: document.querySelector('#recommendedRail'),
    recommendedEmpty: document.querySelector('#recommendedEmpty'),
    catalogView: document.querySelector('#catalogView'),
    catalogCount: document.querySelector('#catalogCount'),
    clearGenreButton: document.querySelector('#clearGenreButton'),
    newPlaylistButton: document.querySelector('#newPlaylistButton'),
    catalogEmpty: document.querySelector('#catalogEmpty'),
    catalogGrid: document.querySelector('#catalogGrid'),
    trackList: document.querySelector('#trackList'),
    genreGrid: document.querySelector('#genreGrid'),
    albumDetailView: document.querySelector('#albumDetailView'),
    albumBackButton: document.querySelector('#albumBackButton'),
    albumDetailCover: document.querySelector('#albumDetailCover'),
    albumDetailTitle: document.querySelector('#albumDetailTitle'),
    albumDetailArtist: document.querySelector('#albumDetailArtist'),
    albumDetailMeta: document.querySelector('#albumDetailMeta'),
    albumFavoriteButton: document.querySelector('#albumFavoriteButton'),
    albumFavoriteLabel: document.querySelector('#albumFavoriteLabel'),
    albumTrackList: document.querySelector('#albumTrackList'),
    artistDetailView: document.querySelector('#artistDetailView'),
    artistBackButton: document.querySelector('#artistBackButton'),
    artistDetailName: document.querySelector('#artistDetailName'),
    artistDetailMeta: document.querySelector('#artistDetailMeta'),
    artistAlbumGrid: document.querySelector('#artistAlbumGrid'),
    artistTrackList: document.querySelector('#artistTrackList'),
    playlistDetailView: document.querySelector('#playlistDetailView'),
    playlistBackButton: document.querySelector('#playlistBackButton'),
    playlistDetailCover: document.querySelector('#playlistDetailCover'),
    playlistDetailTitle: document.querySelector('#playlistDetailTitle'),
    playlistDetailDescription: document.querySelector('#playlistDetailDescription'),
    playlistDetailMeta: document.querySelector('#playlistDetailMeta'),
    playlistPlayButton: document.querySelector('#playlistPlayButton'),
    playlistEditButton: document.querySelector('#playlistEditButton'),
    playlistDeleteButton: document.querySelector('#playlistDeleteButton'),
    playlistTrackList: document.querySelector('#playlistTrackList'),
    playlistDetailEmpty: document.querySelector('#playlistDetailEmpty'),
    playlistEditorDialog: document.querySelector('#playlistEditorDialog'),
    playlistEditorForm: document.querySelector('#playlistEditorForm'),
    playlistEditorTitle: document.querySelector('#playlistEditorTitle'),
    playlistNameInput: document.querySelector('#playlistNameInput'),
    playlistDescriptionInput: document.querySelector('#playlistDescriptionInput'),
    playlistEditorSubmit: document.querySelector('#playlistEditorSubmit'),
    addToPlaylistDialog: document.querySelector('#addToPlaylistDialog'),
    addToPlaylistTrackTitle: document.querySelector('#addToPlaylistTrackTitle'),
    addToPlaylistList: document.querySelector('#addToPlaylistList'),
    addToPlaylistEmpty: document.querySelector('#addToPlaylistEmpty'),
    createPlaylistFromPickerButton: document.querySelector('#createPlaylistFromPickerButton'),
    loading: document.querySelector('#musicLoading'),
  };


  const coverObjectUrls = new Map();

  async function resolveCoverObjectUrl(coverUrl) {
    const url = String(coverUrl || '').trim();
    if (!url) return null;
    if (!coverObjectUrls.has(url)) {
      coverObjectUrls.set(url, (async () => {
        const response = await window.BaiaPage.apiFetch(url);
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`Impossibile caricare la copertina (${response.status}).`);
        const blob = await response.blob();
        if (!blob.size || !String(blob.type || '').startsWith('image/')) return null;
        return URL.createObjectURL(blob);
      })().catch((error) => {
        coverObjectUrls.delete(url);
        throw error;
      }));
    }
    return coverObjectUrls.get(url);
  }

  function applyMusicCover(element, coverUrl) {
    const requestToken = Symbol('music-cover');
    element.__musicCoverRequest = requestToken;
    element.classList.remove('has-art');
    element.style.removeProperty('background-image');
    if (!coverUrl) return;

    resolveCoverObjectUrl(coverUrl).then((objectUrl) => {
      if (!objectUrl || element.__musicCoverRequest !== requestToken) return;
      element.style.backgroundImage = `url(${JSON.stringify(objectUrl)})`;
      element.classList.add('has-art');
    }).catch((error) => {
      console.error(error);
    });
  }

  function artistInitials(name) {
    return String(name || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toLocaleUpperCase('it') || '')
      .join('');
  }

  function applyCoverCollage(element, coverUrls, fallbackLabel = '') {
    const urls = [...new Set((coverUrls || []).map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 4);
    element.replaceChildren();
    element.classList.toggle('has-collage', urls.length > 0);
    element.dataset.monogram = urls.length ? '' : artistInitials(fallbackLabel);
    for (const coverUrl of urls) {
      const tile = document.createElement('span');
      tile.className = 'music-search-collage-tile';
      element.appendChild(tile);
      applyMusicCover(tile, coverUrl);
    }
  }

  function joinNames(artists) {
    return (artists || []).map((artist) => artist?.name || artist).filter(Boolean).join(', ');
  }

  function formatDuration(seconds) {
    const value = Math.max(0, Math.round(Number(seconds) || 0));
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const remaining = value % 60;
    return hours > 0
      ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
      : `${minutes}:${String(remaining).padStart(2, '0')}`;
  }

  function plural(value, singular, pluralValue) {
    return `${value} ${value === 1 ? singular : pluralValue}`;
  }

  function showLoading(visible) {
    elements.loading.hidden = !visible;
  }

  function setBrowseMode(mode, title) {
    state.mode = mode;
    const searching = mode === 'search';
    const navigationMode = searching ? state.searchReturnMode : mode;
    elements.homeView.hidden = mode !== 'home';
    elements.catalogView.hidden = !['albums', 'artists', 'favorites', 'genres', 'recent', 'playlists', 'genre'].includes(mode);
    elements.searchView.hidden = !searching;
    elements.albumDetailView.hidden = true;
    elements.artistDetailView.hidden = true;
    elements.playlistDetailView.hidden = true;
    elements.browseView.hidden = false;
    elements.newPlaylistButton.hidden = mode !== 'playlists';
    elements.pageTitle.textContent = title || 'Musica';
    elements.homeButton.classList.toggle('active', navigationMode === 'home');
    elements.albumsButton.classList.toggle('active', navigationMode === 'albums');
    elements.artistsButton.classList.toggle('active', navigationMode === 'artists');
    elements.genreButton.classList.toggle('active', navigationMode === 'genres' || navigationMode === 'genre');
    elements.genreButton.classList.toggle('has-filter', Boolean(state.activeGenre));
  }

  function cardMeta(item, type) {
    if (type === 'artist') return `${plural(item.albumCount || 0, 'album', 'album')} · ${plural(item.trackCount || 0, 'brano', 'brani')}`;
    if (type === 'track') return [joinNames(item.artists), item.albumTitle].filter(Boolean).join(' · ');
    if (type === 'playlist') return [plural(item.availableTrackCount || 0, 'brano', 'brani'), formatDuration(item.durationSeconds)].join(' · ');
    return [joinNames(item.artists), item.year].filter(Boolean).join(' · ');
  }

  function musicContext(type, id = null, title = '') {
    return { type, id, title };
  }

  function playTrackQueue(tracks, startTrackId, context) {
    const queue = (tracks || []).filter((track) => track?.trackId && track?.streamUrl);
    if (!queue.length) {
      window.BaiaPage.shellToast('La selezione non contiene brani riproducibili.');
      return;
    }
    window.BaiaPage.shellMusicPlayQueue(queue, startTrackId, context);
  }

  function addTrackToQueue(track) {
    if (!track?.trackId || !track?.streamUrl) {
      window.BaiaPage.shellToast('Il brano non è disponibile per la coda.');
      return false;
    }
    return window.BaiaPage.shellMusicAddToQueue([track]);
  }

  function makeAddToQueueButton(track, className = 'music-track-action music-track-add-queue') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.setAttribute('aria-label', `Aggiungi ${track.title} alla coda`);
    button.title = 'Aggiungi alla coda';
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      addTrackToQueue(track);
    });
    return button;
  }

  function syncPlayingRows() {
    const currentId = state.player?.currentTrack?.trackId || '';
    document.querySelectorAll('.music-track-row[data-track-id], .music-search-track-card[data-track-id]').forEach((row) => {
      const current = row.dataset.trackId === currentId;
      row.classList.toggle('is-current', current);
      row.classList.toggle('is-playing', current && Boolean(state.player.playing));
      const button = row.querySelector('.music-track-play, .music-search-track-main');
      if (button) {
        button.setAttribute('aria-label', current && state.player.playing ? `Pausa ${row.dataset.trackTitle}` : `Riproduci ${row.dataset.trackTitle}`);
        button.title = current && state.player.playing ? 'Pausa' : 'Riproduci';
      }
    });
  }

  function createMusicCard(item, type = 'album', { queue = null, context = null } = {}) {
    const article = document.createElement('article');
    article.className = 'music-card';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'music-card-button';

    const titleValue = type === 'artist' || type === 'playlist' ? item.name : item.title;
    button.setAttribute('aria-label', `${type === 'track' ? 'Riproduci' : 'Apri'} ${titleValue}`);

    const cover = document.createElement('div');
    cover.className = `music-cover${type === 'artist' ? ' music-cover-artist' : ''}${type === 'playlist' ? ' music-playlist-cover' : ''}`;
    if (type === 'artist' || type === 'playlist') applyCoverCollage(cover, item.coverUrls, titleValue);
    else applyMusicCover(cover, item.coverUrl);
    if (type === 'playlist') {
      const badge = document.createElement('span');
      badge.className = 'music-cover-badge';
      badge.textContent = plural(item.availableTrackCount || 0, 'brano', 'brani');
      cover.appendChild(badge);
    }
    if (type === 'album' && item.favorite) {
      const badge = document.createElement('span');
      badge.className = 'music-cover-badge';
      badge.textContent = item.fullyFavorite ? 'Preferito' : `${item.favoriteTrackCount}/${item.trackCount}`;
      cover.appendChild(badge);
    }

    const title = document.createElement('p');
    title.className = 'music-card-title';
    title.textContent = titleValue;
    title.title = titleValue;
    const meta = document.createElement('p');
    meta.className = 'music-card-meta';
    meta.textContent = cardMeta(item, type);

    button.append(cover, title, meta);
    if (type === 'artist') button.addEventListener('click', () => openArtist(item.artistId));
    else if (type === 'track') button.addEventListener('click', () => playTrackQueue(queue || [item], item.trackId, context || musicContext('selection', null, titleValue)));
    else if (type === 'playlist') button.addEventListener('click', () => openPlaylist(item.playlistId));
    else button.addEventListener('click', () => openAlbum(item.albumId));
    article.appendChild(button);
    if (type === 'track') article.appendChild(makeAddToQueueButton(item, 'music-card-queue-button'));
    return article;
  }

  function renderRail(container, empty, items, type, context = null) {
    container.replaceChildren(...items.map((item) => createMusicCard(item, type, { queue: items, context })));
    empty.hidden = items.length !== 0;
    const shell = container.closest('.showcase-shell');
    if (shell) shell.hidden = items.length === 0;
  }

  function syncTrackFavoriteButton(button, favorite, title) {
    button.classList.toggle('active', favorite);
    button.setAttribute('aria-pressed', String(favorite));
    button.setAttribute('aria-label', `${favorite ? 'Rimuovi' : 'Aggiungi'} ${title} ${favorite ? 'dai' : 'ai'} preferiti`);
    button.title = favorite ? 'Rimuovi dai preferiti' : 'Aggiungi ai preferiti';
  }

  function createTrackRow(track, index = 0, {
    showAlbum = true,
    queue = null,
    context = null,
    playlistMode = false,
    playlistId = null,
  } = {}) {
    const row = document.createElement('div');
    row.className = `music-track-row${playlistMode ? ' music-playlist-track-row' : ''}`;
    row.dataset.trackId = track.trackId;
    row.dataset.trackTitle = track.title;

    const playButton = document.createElement('button');
    playButton.type = 'button';
    playButton.className = 'music-track-play';
    const discPrefix = Number(track.discTotal || 0) > 1 && track.discNumber ? `${track.discNumber}.` : '';
    const trackLabel = playlistMode ? String(index + 1) : `${discPrefix}${track.trackNumber || index + 1}`;
    playButton.dataset.trackNumber = trackLabel;
    playButton.setAttribute('aria-label', `Riproduci ${track.title}`);
    playButton.title = 'Riproduci';
    playButton.addEventListener('click', () => {
      const current = state.player?.currentTrack?.trackId === track.trackId;
      if (current) window.BaiaPage.shellMusicCommand('play-pause');
      else playTrackQueue(queue || [track], track.trackId, context || musicContext('selection', null, track.albumTitle));
    });

    const copy = document.createElement('div');
    copy.className = 'music-track-copy';
    const title = document.createElement('strong');
    title.className = 'music-track-title';
    title.textContent = track.title;
    const subtitle = document.createElement('span');
    subtitle.className = 'music-track-subtitle';
    subtitle.textContent = joinNames(track.artists);
    copy.append(title, subtitle);

    const album = document.createElement('span');
    album.className = 'music-track-album';
    album.textContent = showAlbum ? track.albumTitle : '';

    const duration = document.createElement('span');
    duration.className = 'music-track-duration';
    duration.textContent = formatDuration(track.durationSeconds);

    const controls = document.createElement('div');
    controls.className = 'music-track-controls';

    const favoriteButton = document.createElement('button');
    favoriteButton.type = 'button';
    favoriteButton.className = 'music-favorite-button';
    syncTrackFavoriteButton(favoriteButton, Boolean(track.favorite), track.title);
    favoriteButton.addEventListener('click', () => toggleTrackFavorite(track, favoriteButton));
    controls.appendChild(favoriteButton);
    controls.appendChild(makeAddToQueueButton(track));

    if (playlistMode) {
      const moveUp = document.createElement('button');
      moveUp.type = 'button';
      moveUp.className = 'music-track-action music-track-move-up';
      moveUp.setAttribute('aria-label', `Sposta ${track.title} in alto`);
      moveUp.title = 'Sposta in alto';
      moveUp.disabled = index === 0;
      moveUp.addEventListener('click', () => movePlaylistTrack(track.trackId, -1));

      const moveDown = document.createElement('button');
      moveDown.type = 'button';
      moveDown.className = 'music-track-action music-track-move-down';
      moveDown.setAttribute('aria-label', `Sposta ${track.title} in basso`);
      moveDown.title = 'Sposta in basso';
      moveDown.disabled = index >= (queue?.length || 0) - 1;
      moveDown.addEventListener('click', () => movePlaylistTrack(track.trackId, 1));

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'music-track-action music-track-remove';
      remove.setAttribute('aria-label', `Rimuovi ${track.title} dalla playlist`);
      remove.title = 'Rimuovi dalla playlist';
      remove.addEventListener('click', () => removeTrackFromPlaylist(playlistId, track));
      controls.append(moveUp, moveDown, remove);
    } else {
      const addToPlaylist = document.createElement('button');
      addToPlaylist.type = 'button';
      addToPlaylist.className = 'music-track-action music-track-add-playlist';
      addToPlaylist.setAttribute('aria-label', `Aggiungi ${track.title} a una playlist`);
      addToPlaylist.title = 'Aggiungi a playlist';
      addToPlaylist.addEventListener('click', () => openAddToPlaylist(track));
      controls.appendChild(addToPlaylist);
    }

    row.append(playButton, copy, album, duration, controls);
    return row;
  }

  function renderAlbumGrid(albums) {
    elements.catalogGrid.replaceChildren(...albums.map((album) => createMusicCard(album, 'album')));
    elements.catalogGrid.hidden = albums.length === 0;
    elements.trackList.hidden = true;
    elements.genreGrid.hidden = true;
  }

  function renderArtistGrid(artists) {
    elements.catalogGrid.replaceChildren(...artists.map((artist) => createMusicCard(artist, 'artist')));
    elements.catalogGrid.hidden = artists.length === 0;
    elements.trackList.hidden = true;
    elements.genreGrid.hidden = true;
  }

  function renderPlaylistGrid(playlists) {
    elements.catalogGrid.replaceChildren(...playlists.map((playlist) => createMusicCard(playlist, 'playlist')));
    elements.catalogGrid.hidden = playlists.length === 0;
    elements.trackList.hidden = true;
    elements.genreGrid.hidden = true;
  }

  function renderTrackList(tracks, context = musicContext(state.mode, state.activeGenre || null, elements.pageTitle.textContent)) {
    elements.trackList.replaceChildren(...tracks.map((track, index) => createTrackRow(track, index, { queue: tracks, context })));
    syncPlayingRows();
    elements.trackList.hidden = tracks.length === 0;
    elements.catalogGrid.hidden = true;
    elements.genreGrid.hidden = true;
  }

  function renderGenreGrid() {
    const cards = state.filters.genres.map((genre) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'music-genre-card';
      const label = document.createElement('span');
      label.textContent = genre;
      const info = document.createElement('small');
      info.textContent = 'Mostra gli album';
      button.append(label, info);
      button.addEventListener('click', () => loadGenre(genre));
      return button;
    });
    elements.genreGrid.replaceChildren(...cards);
    elements.genreGrid.hidden = cards.length === 0;
    elements.catalogGrid.hidden = true;
    elements.trackList.hidden = true;
  }

  function setCatalogState({ count, emptyMessage, genre = '' }) {
    elements.catalogCount.textContent = count;
    elements.catalogEmpty.textContent = emptyMessage;
    const empty = !state.catalog.length;
    elements.catalogEmpty.hidden = !empty;
    elements.clearGenreButton.hidden = !genre;
    elements.clearGenreButton.textContent = genre;
  }

  function applyMusicHome(home) {
    state.home = home || { recent: [], latest: [], recommended: [], summary: {} };
    renderRail(
      elements.recentRail,
      elements.recentEmpty,
      state.home.recent || [],
      'track',
      musicContext('recent', null, 'Riprodotti di recente'),
    );
    renderRail(elements.latestRail, elements.latestEmpty, state.home.latest || [], 'album');
    renderRail(elements.recommendedRail, elements.recommendedEmpty, state.home.recommended || [], 'album');
    const summary = state.home.summary || {};
    elements.librarySummary.textContent = [
      plural(summary.albumCount || 0, 'album', 'album'),
      plural(summary.artistCount || 0, 'artista', 'artisti'),
      plural(summary.trackCount || 0, 'brano', 'brani'),
    ].join(' · ');
  }

  async function loadHome() {
    showLoading(true);
    try {
      const [home, filters] = await Promise.all([
        window.BaiaPage.apiRequest('/api/music/home'),
        window.BaiaPage.apiRequest('/api/music/filters'),
      ]);
      applyMusicHome(home);
      state.filters = filters;
      setBrowseMode('home', 'Musica');
    } catch (error) {
      window.BaiaPage.shellToast(error.message);
      elements.librarySummary.textContent = 'Impossibile caricare il catalogo musicale.';
    } finally {
      showLoading(false);
    }
  }

  async function refreshMusicHistory() {
    try {
      const home = await window.BaiaPage.apiRequest('/api/music/home');
      applyMusicHome(home);
      if (state.mode === 'recent' && !elements.browseView.hidden) showRecent();
    } catch (error) {
      console.warn(error?.message || 'Cronologia musicale non aggiornata nella pagina.');
    }
  }

  function scheduleMusicHistoryRefresh() {
    clearTimeout(state.historyRefreshTimer);
    state.historyRefreshTimer = setTimeout(refreshMusicHistory, 180);
  }

  async function loadAlbums({ favoritesOnly = false, genre = '' } = {}) {
    showLoading(true);
    try {
      const params = new URLSearchParams({ limit: '250', sort: 'title' });
      if (favoritesOnly) params.set('favoritesOnly', '1');
      if (genre) params.set('genre', genre);
      const payload = await window.BaiaPage.apiRequest(`/api/music/albums?${params}`);
      state.catalog = payload.albums || [];
      state.catalogType = 'albums';
      state.activeGenre = genre;
      renderAlbumGrid(state.catalog);
      const mode = genre ? 'genre' : favoritesOnly ? 'favorites' : 'albums';
      const title = genre || (favoritesOnly ? 'Preferiti' : 'Album');
      setBrowseMode(mode, title);
      setCatalogState({
        count: plural(payload.count || 0, 'album', 'album'),
        emptyMessage: favoritesOnly
          ? 'Non ci sono ancora brani preferiti.'
          : genre
            ? `Nessun album appartiene al genere ${genre}.`
            : 'La libreria non contiene ancora album.',
        genre,
      });
    } catch (error) {
      window.BaiaPage.shellToast(error.message);
    } finally {
      showLoading(false);
    }
  }

  async function loadArtists() {
    showLoading(true);
    try {
      const payload = await window.BaiaPage.apiRequest('/api/music/artists?limit=250');
      state.catalog = payload.artists || [];
      state.catalogType = 'artists';
      state.activeGenre = '';
      renderArtistGrid(state.catalog);
      setBrowseMode('artists', 'Artisti');
      setCatalogState({
        count: plural(payload.count || 0, 'artista', 'artisti'),
        emptyMessage: 'La libreria non contiene ancora artisti.',
      });
    } catch (error) {
      window.BaiaPage.shellToast(error.message);
    } finally {
      showLoading(false);
    }
  }

  function showGenres() {
    state.catalog = state.filters.genres;
    state.activeGenre = '';
    renderGenreGrid();
    setBrowseMode('genres', 'Generi');
    setCatalogState({
      count: plural(state.filters.genres.length, 'genere', 'generi'),
      emptyMessage: 'Nessun genere è presente nei tag musicali.',
    });
  }

  function loadGenre(genre) {
    return loadAlbums({ genre });
  }

  function showRecent() {
    state.catalog = state.home.recent || [];
    state.activeGenre = '';
    renderTrackList(state.catalog, musicContext('recent', null, 'Riprodotti di recente'));
    setBrowseMode('recent', 'Riprodotti di recente');
    setCatalogState({
      count: plural(state.catalog.length, 'brano', 'brani'),
      emptyMessage: 'Non è stato ancora riprodotto alcun brano con questo profilo.',
    });
  }

  async function showPlaylists() {
    showLoading(true);
    try {
      const payload = await window.BaiaPage.apiRequest('/api/music/playlists');
      state.playlists = payload.playlists || [];
      state.catalog = state.playlists;
      state.catalogType = 'playlists';
      state.activeGenre = '';
      renderPlaylistGrid(state.playlists);
      setBrowseMode('playlists', 'Playlist');
      setCatalogState({
        count: plural(payload.count || 0, 'playlist', 'playlist'),
        emptyMessage: 'Non hai ancora creato playlist.',
      });
    } catch (error) {
      window.BaiaPage.shellToast(error.message);
    } finally {
      showLoading(false);
    }
  }

  function openDialog(dialog) {
    if (!dialog) return;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }

  function closeDialog(dialog) {
    if (!dialog) return;
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  }

  function playlistContext(playlist) {
    return musicContext('playlist', playlist.playlistId, playlist.name);
  }

  function renderPlaylistDetail(payload) {
    state.selectedPlaylist = payload;
    const playlist = payload.playlist;
    const tracks = payload.tracks || [];
    applyCoverCollage(elements.playlistDetailCover, playlist.coverUrls, playlist.name);
    elements.playlistDetailTitle.textContent = playlist.name;
    elements.playlistDetailDescription.textContent = playlist.description || '';
    elements.playlistDetailDescription.hidden = !playlist.description;
    elements.playlistDetailMeta.textContent = [
      plural(playlist.availableTrackCount || 0, 'brano', 'brani'),
      formatDuration(playlist.durationSeconds),
      payload.missingTrackCount ? `${payload.missingTrackCount} non disponibile` : '',
    ].filter(Boolean).join(' · ');
    elements.playlistPlayButton.disabled = tracks.length === 0;
    elements.playlistTrackList.replaceChildren(...tracks.map((track, index) => createTrackRow(track, index, {
      queue: tracks,
      context: playlistContext(playlist),
      playlistMode: true,
      playlistId: playlist.playlistId,
    })));
    elements.playlistTrackList.hidden = tracks.length === 0;
    elements.playlistDetailEmpty.hidden = tracks.length !== 0;
    syncPlayingRows();
  }

  async function openPlaylist(playlistId) {
    if (!playlistId) return;
    showLoading(true);
    try {
      const payload = await window.BaiaPage.apiRequest(`/api/music/playlists/${encodeURIComponent(playlistId)}`);
      state.detailReturnScrollY = window.scrollY;
      state.selectedAlbum = null;
      state.selectedArtist = null;
      renderPlaylistDetail(payload);
      elements.browseView.hidden = true;
      elements.albumDetailView.hidden = true;
      elements.artistDetailView.hidden = true;
      elements.playlistDetailView.hidden = false;
    } catch (error) {
      window.BaiaPage.shellToast(error.message);
    } finally {
      showLoading(false);
    }
  }

  async function refreshSelectedPlaylist() {
    const playlistId = state.selectedPlaylist?.playlist?.playlistId;
    if (!playlistId) return null;
    const payload = await window.BaiaPage.apiRequest(`/api/music/playlists/${encodeURIComponent(playlistId)}`);
    renderPlaylistDetail(payload);
    return payload;
  }

  function openPlaylistEditor({ playlist = null, pendingTrack = null } = {}) {
    state.playlistEditorMode = playlist ? 'edit' : 'create';
    state.pendingPlaylistTrack = pendingTrack || null;
    elements.playlistEditorTitle.textContent = playlist ? 'Modifica playlist' : 'Nuova playlist';
    elements.playlistEditorSubmit.textContent = playlist ? 'Salva' : 'Crea playlist';
    elements.playlistNameInput.value = playlist?.name || '';
    elements.playlistDescriptionInput.value = playlist?.description || '';
    openDialog(elements.playlistEditorDialog);
    requestAnimationFrame(() => elements.playlistNameInput.focus());
  }

  async function savePlaylistEditor(event) {
    event.preventDefault();
    const draft = window.BaiaMusicPlaylistState.playlistDraft({
      name: elements.playlistNameInput.value,
      description: elements.playlistDescriptionInput.value,
    });
    if (!draft.name) {
      elements.playlistNameInput.focus();
      return;
    }

    const editing = state.playlistEditorMode === 'edit';
    const currentId = state.selectedPlaylist?.playlist?.playlistId;
    if (editing && !currentId) return;
    elements.playlistEditorSubmit.disabled = true;
    try {
      const payload = await window.BaiaPage.apiRequest(
        editing
          ? `/api/music/playlists/${encodeURIComponent(currentId)}`
          : '/api/music/playlists',
        {
          method: editing ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(draft),
        },
      );
      const pendingTrack = state.pendingPlaylistTrack;
      state.pendingPlaylistTrack = null;
      closeDialog(elements.playlistEditorDialog);

      let finalPayload = payload;
      if (!editing && pendingTrack?.trackId) {
        finalPayload = await window.BaiaPage.apiRequest(
          `/api/music/playlists/${encodeURIComponent(payload.playlist.playlistId)}/tracks`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ trackIds: [pendingTrack.trackId] }),
          },
        );
        window.BaiaPage.shellToast(`${pendingTrack.title} aggiunto a ${finalPayload.playlist.name}.`);
      }

      if (editing && state.selectedPlaylist) renderPlaylistDetail(finalPayload);
      else if (!pendingTrack) await openPlaylist(finalPayload.playlist.playlistId);
      await refreshPlaylistSummaries();
    } catch (error) {
      window.BaiaPage.shellToast(error.message);
    } finally {
      elements.playlistEditorSubmit.disabled = false;
    }
  }

  async function refreshPlaylistSummaries() {
    const payload = await window.BaiaPage.apiRequest('/api/music/playlists');
    state.playlists = payload.playlists || [];
    if (state.mode === 'playlists') {
      state.catalog = state.playlists;
      renderPlaylistGrid(state.playlists);
      setCatalogState({
        count: plural(payload.count || 0, 'playlist', 'playlist'),
        emptyMessage: 'Non hai ancora creato playlist.',
      });
    }
    return payload;
  }

  async function deleteSelectedPlaylist() {
    const playlist = state.selectedPlaylist?.playlist;
    if (!playlist) return;
    if (!window.confirm(`Eliminare la playlist “${playlist.name}”? I file musicali non verranno cancellati.`)) return;
    elements.playlistDeleteButton.disabled = true;
    try {
      await window.BaiaPage.apiRequest(`/api/music/playlists/${encodeURIComponent(playlist.playlistId)}/delete`, {
        method: 'POST',
      });
      state.selectedPlaylist = null;
      elements.playlistDetailView.hidden = true;
      elements.browseView.hidden = false;
      await showPlaylists();
      window.BaiaPage.shellToast('Playlist eliminata.');
    } catch (error) {
      window.BaiaPage.shellToast(error.message);
    } finally {
      elements.playlistDeleteButton.disabled = false;
    }
  }

  function playSelectedPlaylist() {
    const payload = state.selectedPlaylist;
    const tracks = payload?.tracks || [];
    if (!tracks.length) return;
    playTrackQueue(tracks, tracks[0].trackId, playlistContext(payload.playlist));
  }

  async function movePlaylistTrack(trackId, offset) {
    const payload = state.selectedPlaylist;
    if (!payload?.playlist?.playlistId) return;
    const result = window.BaiaMusicPlaylistState.moveTrackIds(
      (payload.tracks || []).map((track) => track.trackId),
      trackId,
      offset,
    );
    if (!result.moved) return;
    showLoading(true);
    try {
      const updated = await window.BaiaPage.apiRequest(
        `/api/music/playlists/${encodeURIComponent(payload.playlist.playlistId)}/tracks/order`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ trackIds: result.trackIds }),
        },
      );
      renderPlaylistDetail(updated);
      await refreshPlaylistSummaries();
    } catch (error) {
      window.BaiaPage.shellToast(error.message);
    } finally {
      showLoading(false);
    }
  }

  async function removeTrackFromPlaylist(playlistId, track) {
    if (!playlistId || !track?.trackId) return;
    showLoading(true);
    try {
      const updated = await window.BaiaPage.apiRequest(
        `/api/music/playlists/${encodeURIComponent(playlistId)}/tracks/${encodeURIComponent(track.trackId)}/remove`,
        { method: 'POST' },
      );
      renderPlaylistDetail(updated);
      await refreshPlaylistSummaries();
      window.BaiaPage.shellToast(`${track.title} rimosso dalla playlist.`);
    } catch (error) {
      window.BaiaPage.shellToast(error.message);
    } finally {
      showLoading(false);
    }
  }

  function renderPlaylistPicker(playlists) {
    const rows = playlists.map((playlist) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'music-playlist-picker-item';
      const copy = document.createElement('span');
      const name = document.createElement('strong');
      name.textContent = playlist.name;
      const meta = document.createElement('small');
      meta.textContent = plural(playlist.availableTrackCount || 0, 'brano', 'brani');
      copy.append(name, meta);
      const action = document.createElement('span');
      action.textContent = 'Aggiungi';
      button.append(copy, action);
      button.addEventListener('click', () => addPendingTrackToPlaylist(playlist.playlistId));
      return button;
    });
    elements.addToPlaylistList.replaceChildren(...rows);
    elements.addToPlaylistList.hidden = rows.length === 0;
    elements.addToPlaylistEmpty.hidden = rows.length !== 0;
  }

  async function openAddToPlaylist(track) {
    state.pendingPlaylistTrack = track;
    elements.addToPlaylistTrackTitle.textContent = track.title;
    showLoading(true);
    try {
      const payload = await refreshPlaylistSummaries();
      renderPlaylistPicker(payload.playlists || []);
      openDialog(elements.addToPlaylistDialog);
    } catch (error) {
      state.pendingPlaylistTrack = null;
      window.BaiaPage.shellToast(error.message);
    } finally {
      showLoading(false);
    }
  }

  async function addPendingTrackToPlaylist(playlistId) {
    const track = state.pendingPlaylistTrack;
    if (!track?.trackId) return;
    showLoading(true);
    try {
      const updated = await window.BaiaPage.apiRequest(
        `/api/music/playlists/${encodeURIComponent(playlistId)}/tracks`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ trackIds: [track.trackId] }),
        },
      );
      closeDialog(elements.addToPlaylistDialog);
      state.pendingPlaylistTrack = null;
      if (state.selectedPlaylist?.playlist?.playlistId === playlistId) renderPlaylistDetail(updated);
      await refreshPlaylistSummaries();
      window.BaiaPage.shellToast(`${track.title} aggiunto a ${updated.playlist.name}.`);
    } catch (error) {
      window.BaiaPage.shellToast(error.message);
    } finally {
      showLoading(false);
    }
  }

  function applyAlbumFavoriteState(update) {
    if (!update?.albumId) return;
    const collections = [
      state.catalog,
      state.home.recommended,
      state.selectedArtist?.albums,
    ];
    for (const collection of collections) {
      const album = collection?.find((item) => item.albumId === update.albumId);
      if (album) Object.assign(album, update);
    }
    if (state.selectedAlbum?.album?.albumId === update.albumId) {
      Object.assign(state.selectedAlbum.album, update);
    }
  }

  function syncAlbumFavoriteButton(album) {
    const fullyFavorite = Boolean(album?.fullyFavorite);
    const partiallyFavorite = Boolean(album?.favorite) && !fullyFavorite;
    elements.albumFavoriteButton.classList.toggle('active', fullyFavorite);
    elements.albumFavoriteButton.classList.toggle('partial', partiallyFavorite);
    elements.albumFavoriteButton.setAttribute('aria-pressed', String(fullyFavorite));
    elements.albumFavoriteLabel.textContent = fullyFavorite
      ? 'Rimuovi album dai preferiti'
      : partiallyFavorite
        ? 'Aggiungi tutto l’album ai preferiti'
        : 'Aggiungi album ai preferiti';
  }

  function albumDetailUrl(albumId) {
    const suffix = state.detailFavoritesOnly ? '?favoritesOnly=1' : '';
    return `/api/music/albums/${encodeURIComponent(albumId)}${suffix}`;
  }

  function renderAlbumDetail(payload) {
    state.selectedAlbum = payload;
    const album = payload.album;
    applyMusicCover(elements.albumDetailCover, album.coverUrl);
    elements.albumDetailTitle.textContent = album.title;
    const primaryArtist = album.artists?.[0] || null;
    elements.albumDetailArtist.textContent = joinNames(album.artists) || 'Artista sconosciuto';
    elements.albumDetailArtist.disabled = !primaryArtist?.artistId;
    elements.albumDetailArtist.dataset.artistId = primaryArtist?.artistId || '';
    elements.albumDetailMeta.textContent = [
      album.year,
      plural(album.trackCount || 0, 'brano', 'brani'),
      formatDuration(album.durationSeconds),
      ...(album.genres || []).slice(0, 3),
    ].filter(Boolean).join(' · ');
    syncAlbumFavoriteButton(album);
    const albumTracks = payload.tracks || [];
    const context = musicContext(state.detailFavoritesOnly ? 'favorites' : 'album', album.albumId, album.title);
    elements.albumTrackList.replaceChildren(...albumTracks.map((track, index) => createTrackRow(track, index, { showAlbum: false, queue: albumTracks, context })));
    syncPlayingRows();
  }

  async function refreshSelectedAlbum() {
    const albumId = state.selectedAlbum?.album?.albumId;
    if (!albumId) return;
    const payload = await window.BaiaPage.apiRequest(albumDetailUrl(albumId));
    if (state.detailFavoritesOnly && !(payload.tracks || []).length) {
      state.selectedAlbum = null;
      elements.albumDetailView.hidden = true;
      elements.browseView.hidden = false;
      await loadAlbums({ favoritesOnly: true });
      return;
    }
    renderAlbumDetail(payload);
  }

  async function toggleTrackFavorite(track, button) {
    if (!track?.trackId || button.disabled) return;
    button.disabled = true;
    try {
      const payload = await window.BaiaPage.apiRequest(`/api/music/tracks/${encodeURIComponent(track.trackId)}/favorite`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ favorite: !track.favorite }),
      });
      track.favorite = payload.favorite;
      applyAlbumFavoriteState(payload.album);
      syncTrackFavoriteButton(button, track.favorite, track.title);
      if (!elements.albumDetailView.hidden && state.selectedAlbum?.album?.albumId === track.albumId) {
        await refreshSelectedAlbum();
      } else if (!elements.artistDetailView.hidden && state.selectedArtist) {
        elements.artistAlbumGrid.replaceChildren(...(state.selectedArtist.albums || []).map((album) => createMusicCard(album, 'album')));
      }
    } catch (error) {
      window.BaiaPage.shellToast(error.message);
    } finally {
      button.disabled = false;
    }
  }

  async function toggleAlbumFavorite() {
    const album = state.selectedAlbum?.album;
    if (!album || elements.albumFavoriteButton.disabled) return;
    elements.albumFavoriteButton.disabled = true;
    try {
      const payload = await window.BaiaPage.apiRequest(`/api/music/albums/${encodeURIComponent(album.albumId)}/favorite`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ favorite: !album.fullyFavorite }),
      });
      applyAlbumFavoriteState(payload);
      await refreshSelectedAlbum();
    } catch (error) {
      window.BaiaPage.shellToast(error.message);
    } finally {
      elements.albumFavoriteButton.disabled = false;
    }
  }

  async function openAlbum(albumId) {
    if (!albumId) return;
    showLoading(true);
    try {
      state.detailReturnScrollY = window.scrollY;
      state.detailFavoritesOnly = state.mode === 'favorites';
      const payload = await window.BaiaPage.apiRequest(albumDetailUrl(albumId));
      renderAlbumDetail(payload);
      state.selectedArtist = null;
      elements.browseView.hidden = true;
      elements.artistDetailView.hidden = true;
      elements.playlistDetailView.hidden = true;
      elements.albumDetailView.hidden = false;
    } catch (error) {
      window.BaiaPage.shellToast(error.message);
    } finally {
      showLoading(false);
    }
  }

  async function openArtist(artistId) {
    if (!artistId) return;
    showLoading(true);
    try {
      const payload = await window.BaiaPage.apiRequest(`/api/music/artists/${encodeURIComponent(artistId)}`);
      state.detailReturnScrollY = window.scrollY;
      state.selectedArtist = payload;
      state.selectedAlbum = null;
      elements.artistDetailName.textContent = payload.artist.name;
      elements.artistDetailMeta.textContent = [
        plural(payload.artist.albumCount || 0, 'album', 'album'),
        plural(payload.artist.trackCount || 0, 'brano', 'brani'),
        formatDuration(payload.artist.durationSeconds),
      ].join(' · ');
      elements.artistAlbumGrid.replaceChildren(...(payload.albums || []).map((album) => createMusicCard(album, 'album')));
      const artistTracks = payload.tracks || [];
      const context = musicContext('artist', payload.artist.artistId, payload.artist.name);
      elements.artistTrackList.replaceChildren(...artistTracks.map((track, index) => createTrackRow(track, index, { queue: artistTracks, context })));
      syncPlayingRows();
      elements.browseView.hidden = true;
      elements.albumDetailView.hidden = true;
      elements.playlistDetailView.hidden = true;
      elements.artistDetailView.hidden = false;
    } catch (error) {
      window.BaiaPage.shellToast(error.message);
    } finally {
      showLoading(false);
    }
  }

  function returnFromDetail() {
    elements.albumDetailView.hidden = true;
    elements.artistDetailView.hidden = true;
    elements.playlistDetailView.hidden = true;
    elements.browseView.hidden = false;
    requestAnimationFrame(() => window.scrollTo({ top: state.detailReturnScrollY || 0, behavior: 'auto' }));
  }

  function searchTypeLabel(type) {
    return ({ track: 'Brano', album: 'Album', artist: 'Artista', genre: 'Genere' })[type] || 'Risultato';
  }

  function searchItemTitle(item, type) {
    return type === 'artist' || type === 'genre' ? item.name : item.title;
  }

  function searchItemMeta(item, type) {
    if (type === 'genre') {
      return `${plural(item.albumCount || 0, 'album', 'album')} · ${plural(item.trackCount || 0, 'brano', 'brani')}`;
    }
    return cardMeta(item, type);
  }

  function createSearchCover(item, type, extraClass = '') {
    const cover = document.createElement('span');
    cover.className = `music-search-cover music-search-cover-${type}${extraClass ? ` ${extraClass}` : ''}`;
    if (type === 'artist' || type === 'genre') applyCoverCollage(cover, item.coverUrls, item.name);
    else applyMusicCover(cover, item.coverUrl);
    return cover;
  }

  function searchContext() {
    return musicContext('search', null, elements.searchInput.value.trim());
  }

  async function playSearchItem(type, item) {
    if (type === 'track') {
      playTrackQueue(state.searchPayload?.tracks || [item], item.trackId, searchContext());
      return;
    }

    showLoading(true);
    try {
      let tracks = [];
      let startTrackId = null;
      let context = searchContext();
      if (type === 'album') {
        const payload = await window.BaiaPage.apiRequest(`/api/music/albums/${encodeURIComponent(item.albumId)}`);
        tracks = payload.tracks || [];
        context = musicContext('album', item.albumId, item.title);
      } else if (type === 'artist') {
        const payload = await window.BaiaPage.apiRequest(`/api/music/artists/${encodeURIComponent(item.artistId)}`);
        tracks = payload.tracks || [];
        context = musicContext('artist', item.artistId, item.name);
      } else if (type === 'genre') {
        const params = new URLSearchParams({ genre: item.name, limit: '250', sort: 'title' });
        const payload = await window.BaiaPage.apiRequest(`/api/music/tracks?${params}`);
        tracks = payload.tracks || [];
        context = musicContext('genre', item.name, item.name);
      }
      startTrackId = tracks[0]?.trackId || null;
      playTrackQueue(tracks, startTrackId, context);
    } catch (error) {
      window.BaiaPage.shellToast(error.message);
    } finally {
      showLoading(false);
    }
  }

  function openSearchItem(type, item) {
    if (type === 'track') playSearchItem(type, item);
    else if (type === 'album') openAlbum(item.albumId);
    else if (type === 'artist') openArtist(item.artistId);
    else if (type === 'genre') {
      clearSearch({ restore: false });
      loadGenre(item.name);
    }
  }

  function createTopSearchResult(topResult) {
    if (!topResult?.item) return null;
    const { type, item } = topResult;
    const section = document.createElement('section');
    section.className = 'music-search-top-section';
    const heading = document.createElement('h2');
    heading.textContent = 'Risultato principale';

    const card = document.createElement('div');
    card.className = `music-search-top-card music-search-top-${type}`;
    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'music-search-top-main';
    main.setAttribute('aria-label', `${type === 'track' ? 'Riproduci' : 'Apri'} ${searchItemTitle(item, type)}`);
    main.addEventListener('click', () => openSearchItem(type, item));

    const cover = createSearchCover(item, type, 'music-search-top-cover');
    const copy = document.createElement('span');
    copy.className = 'music-search-top-copy';
    const kind = document.createElement('small');
    kind.textContent = searchTypeLabel(type);
    const title = document.createElement('strong');
    title.textContent = searchItemTitle(item, type);
    const meta = document.createElement('span');
    meta.textContent = searchItemMeta(item, type);
    copy.append(kind, title, meta);
    main.append(cover, copy);

    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'music-search-play-button';
    play.setAttribute('aria-label', `Riproduci ${searchItemTitle(item, type)}`);
    play.title = 'Riproduci';
    play.addEventListener('click', () => playSearchItem(type, item));

    card.append(main, play);
    section.append(heading, card);
    return section;
  }

  function createSearchTrackCard(track, tracks) {
    const row = document.createElement('article');
    row.className = 'music-search-track-card';
    row.dataset.trackId = track.trackId;
    row.dataset.trackTitle = track.title;

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'music-search-track-main';
    main.setAttribute('aria-label', `Riproduci ${track.title}`);
    main.addEventListener('click', () => {
      const current = state.player?.currentTrack?.trackId === track.trackId;
      if (current) window.BaiaPage.shellMusicCommand('play-pause');
      else playTrackQueue(tracks, track.trackId, searchContext());
    });

    const cover = createSearchCover(track, 'track');
    const copy = document.createElement('span');
    copy.className = 'music-search-track-copy';
    const title = document.createElement('strong');
    title.textContent = track.title;
    const artist = document.createElement('span');
    artist.textContent = joinNames(track.artists) || 'Artista sconosciuto';
    copy.append(title, artist);
    main.append(cover, copy);

    const album = document.createElement('span');
    album.className = 'music-search-track-album';
    album.textContent = track.albumTitle || '';
    const duration = document.createElement('span');
    duration.className = 'music-search-track-duration';
    duration.textContent = formatDuration(track.durationSeconds);

    const controls = document.createElement('div');
    controls.className = 'music-search-track-controls';
    const favorite = document.createElement('button');
    favorite.type = 'button';
    favorite.className = 'music-favorite-button';
    syncTrackFavoriteButton(favorite, Boolean(track.favorite), track.title);
    favorite.addEventListener('click', () => toggleTrackFavorite(track, favorite));
    const addQueue = makeAddToQueueButton(track);
    const addPlaylist = document.createElement('button');
    addPlaylist.type = 'button';
    addPlaylist.className = 'music-track-action music-track-add-playlist';
    addPlaylist.setAttribute('aria-label', `Aggiungi ${track.title} a una playlist`);
    addPlaylist.title = 'Aggiungi a playlist';
    addPlaylist.addEventListener('click', () => openAddToPlaylist(track));
    controls.append(favorite, addQueue, addPlaylist);

    row.append(main, album, duration, controls);
    return row;
  }

  function createSearchMediaCard(item, type) {
    const article = document.createElement('article');
    article.className = `music-search-media-card music-search-media-${type}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'music-search-media-main';
    button.setAttribute('aria-label', `Apri ${searchItemTitle(item, type)}`);
    button.addEventListener('click', () => openSearchItem(type, item));
    const cover = createSearchCover(item, type);
    const title = document.createElement('strong');
    title.textContent = searchItemTitle(item, type);
    title.title = title.textContent;
    const meta = document.createElement('span');
    meta.textContent = searchItemMeta(item, type);
    button.append(cover, title, meta);
    article.appendChild(button);
    return article;
  }

  function createSearchMediaSection(title, items, type) {
    if (!items.length) return null;
    const section = document.createElement('section');
    section.className = `music-search-group music-search-group-${type}`;
    const heading = document.createElement('h2');
    heading.textContent = title;
    const grid = document.createElement('div');
    grid.className = `music-search-card-grid music-search-card-grid-${type}`;
    grid.replaceChildren(...items.map((item) => createSearchMediaCard(item, type)));
    section.append(heading, grid);
    return section;
  }

  function createSearchTrackSection(tracks) {
    if (!tracks.length) return null;
    const section = document.createElement('section');
    section.className = 'music-search-track-section';
    const heading = document.createElement('h2');
    heading.textContent = 'Brani';
    const list = document.createElement('div');
    list.className = 'music-search-track-list';
    list.replaceChildren(...tracks.map((track) => createSearchTrackCard(track, tracks)));
    section.append(heading, list);
    return section;
  }

  function renderSearchPayload(payload) {
    state.searchPayload = payload;
    const total = Number(payload?.counts?.total || 0);
    elements.searchCount.textContent = total
      ? `${plural(total, 'risultato', 'risultati')} per “${payload.query}”`
      : '';
    elements.searchEmpty.hidden = total !== 0;
    if (!total) {
      elements.searchResults.replaceChildren();
      return;
    }

    const hero = document.createElement('div');
    hero.className = 'music-search-hero';
    const top = createTopSearchResult(payload.topResult);
    const tracks = createSearchTrackSection(payload.tracks || []);
    if (top) hero.appendChild(top);
    if (tracks) hero.appendChild(tracks);

    const groups = [
      createSearchMediaSection('Album', payload.albums || [], 'album'),
      createSearchMediaSection('Artisti', payload.artists || [], 'artist'),
      createSearchMediaSection('Generi', payload.genres || [], 'genre'),
    ].filter(Boolean);
    elements.searchResults.replaceChildren(hero, ...groups);
    syncPlayingRows();
  }

  function restoreSearchReturnMode() {
    const mode = state.searchReturnMode || 'home';
    setBrowseMode(mode, state.searchReturnTitle || 'Musica');
    requestAnimationFrame(() => window.scrollTo({ top: state.searchReturnScrollY || 0, behavior: 'auto' }));
  }

  function clearSearch({ restore = true } = {}) {
    clearTimeout(state.searchTimer);
    state.searchRequest += 1;
    state.searchPayload = null;
    elements.searchInput.value = '';
    elements.searchClearButton.hidden = true;
    elements.searchCount.textContent = '';
    elements.searchEmpty.hidden = true;
    elements.searchResults.replaceChildren();
    if (restore && state.mode === 'search') restoreSearchReturnMode();
  }

  async function searchMusic(value) {
    const search = String(value || '').trim();
    elements.searchClearButton.hidden = !search;
    const requestId = ++state.searchRequest;
    if (search.length < 2) {
      state.searchPayload = null;
      elements.searchCount.textContent = '';
      elements.searchEmpty.hidden = true;
      elements.searchResults.replaceChildren();
      if (state.mode === 'search') restoreSearchReturnMode();
      return;
    }

    if (state.mode !== 'search') {
      state.searchReturnMode = state.mode;
      state.searchReturnTitle = elements.pageTitle.textContent || 'Musica';
      state.searchReturnScrollY = window.scrollY;
      setBrowseMode('search', 'Musica');
      window.scrollTo({ top: 0, behavior: 'auto' });
    }

    try {
      const params = new URLSearchParams({ q: search, limit: '8', trackLimit: '10' });
      const payload = await window.BaiaPage.apiRequest(`/api/music/search?${params}`);
      if (requestId !== state.searchRequest) return;
      renderSearchPayload(payload);
    } catch (error) {
      if (requestId === state.searchRequest) window.BaiaPage.shellToast(error.message);
    }
  }

  document.querySelectorAll('[data-music-section]').forEach((button) => {
    button.addEventListener('click', () => {
      const section = button.dataset.musicSection;
      if (section === 'favorites') loadAlbums({ favoritesOnly: true });
      else if (section === 'genres') showGenres();
      else if (section === 'recent') showRecent();
      else if (section === 'playlists') showPlaylists();
    });
  });

  function runNavigation(action) {
    if (elements.searchInput.value || state.mode === 'search') clearSearch({ restore: false });
    action();
  }

  elements.homeButton.addEventListener('click', () => runNavigation(() => setBrowseMode('home', 'Musica')));
  elements.albumsButton.addEventListener('click', () => runNavigation(() => loadAlbums()));
  elements.artistsButton.addEventListener('click', () => runNavigation(() => loadArtists()));
  elements.genreButton.addEventListener('click', () => runNavigation(showGenres));
  elements.clearGenreButton.addEventListener('click', () => loadAlbums());
  elements.newPlaylistButton.addEventListener('click', () => openPlaylistEditor());
  elements.albumBackButton.addEventListener('click', returnFromDetail);
  elements.artistBackButton.addEventListener('click', returnFromDetail);
  elements.playlistBackButton.addEventListener('click', returnFromDetail);
  elements.albumDetailArtist.addEventListener('click', () => openArtist(elements.albumDetailArtist.dataset.artistId));
  elements.albumFavoriteButton.addEventListener('click', toggleAlbumFavorite);
  elements.playlistPlayButton.addEventListener('click', playSelectedPlaylist);
  elements.playlistEditButton.addEventListener('click', () => {
    const playlist = state.selectedPlaylist?.playlist;
    if (playlist) openPlaylistEditor({ playlist });
  });
  elements.playlistDeleteButton.addEventListener('click', deleteSelectedPlaylist);
  elements.playlistEditorForm.addEventListener('submit', savePlaylistEditor);
  elements.createPlaylistFromPickerButton.addEventListener('click', () => {
    const track = state.pendingPlaylistTrack;
    closeDialog(elements.addToPlaylistDialog);
    openPlaylistEditor({ pendingTrack: track });
  });
  document.querySelectorAll('[data-close-dialog]').forEach((button) => {
    button.addEventListener('click', () => {
      const dialog = document.querySelector(`#${button.dataset.closeDialog}`);
      closeDialog(dialog);
      state.pendingPlaylistTrack = null;
    });
  });
  elements.playlistEditorDialog.addEventListener('close', () => {
    state.pendingPlaylistTrack = null;
  });
  elements.addToPlaylistDialog.addEventListener('close', () => {
    if (!elements.playlistEditorDialog.open) state.pendingPlaylistTrack = null;
  });
  elements.searchInput.addEventListener('input', () => {
    clearTimeout(state.searchTimer);
    elements.searchClearButton.hidden = !elements.searchInput.value;
    state.searchTimer = setTimeout(() => searchMusic(elements.searchInput.value), 220);
  });
  elements.searchInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !elements.searchInput.value) return;
    event.preventDefault();
    clearSearch();
    elements.searchInput.focus();
  });
  elements.searchClearButton.addEventListener('click', () => {
    clearSearch();
    elements.searchInput.focus();
  });


  document.querySelectorAll('[data-scroll-target]').forEach((button) => {
    button.addEventListener('click', () => {
      const rail = document.querySelector(`#${button.dataset.scrollTarget}`);
      const direction = Number(button.dataset.direction) || 1;
      rail?.scrollBy({ left: direction * Math.max(300, rail.clientWidth * .82), behavior: 'smooth' });
    });
  });

  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin) return;
    if (event.data?.type === 'shell-music-state') {
      state.player = event.data.state || state.player;
      syncPlayingRows();
      return;
    }
    if (event.data?.type === 'shell-music-history-updated') {
      scheduleMusicHistoryRefresh();
      return;
    }
    if (event.data?.type === 'shell-music-navigate') {
      const id = String(event.data.id || '').trim();
      if (!id) return;
      if (event.data.target === 'album') openAlbum(id);
      if (event.data.target === 'artist') openArtist(id);
    }
  });

  const initialPlayerState = window.BaiaPage.shellMusicRequestState();
  if (initialPlayerState) state.player = initialPlayerState;

  window.addEventListener('pagehide', () => {
    for (const request of coverObjectUrls.values()) {
      Promise.resolve(request).then((objectUrl) => {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      }).catch(() => {});
    }
    coverObjectUrls.clear();
  }, { once: true });

  loadHome();
})();
