(() => {
  const category = document.body.dataset.readingCategory || 'books';
  const categoryLabel = document.body.dataset.readingLabel || 'Libri';
  const utils = window.BaiaReadingReaderUtils;
  const state = {
    mode: 'home',
    genre: '',
    author: '',
    year: 0,
    filters: { genres: [], years: [], authors: [] },
    home: { recent: [], latest: [], recommended: [] },
    catalog: [],
    searchResults: [],
    readerItem: null,
    renderer: null,
    searchTimer: null,
    closingReader: false,
  };

  const elements = {
    browseView: document.querySelector('#browseView'),
    homeView: document.querySelector('#homeView'),
    catalogView: document.querySelector('#catalogView'),
    searchView: document.querySelector('#searchView'),
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
    authorButton: document.querySelector('#authorButton'),
    authorMenu: document.querySelector('#authorMenu'),
    authorFilterSearch: document.querySelector('#authorFilterSearch'),
    authorOptions: document.querySelector('#authorOptions'),
    authorFilterEmpty: document.querySelector('#authorFilterEmpty'),
    clearFiltersButton: document.querySelector('#clearFiltersButton'),
    searchInput: document.querySelector('#searchInput'),
    searchCount: document.querySelector('#searchCount'),
    searchResults: document.querySelector('#searchResults'),
    searchEmpty: document.querySelector('#searchEmpty'),
    recentRail: document.querySelector('#recentRail'),
    latestRail: document.querySelector('#latestRail'),
    recommendedRail: document.querySelector('#recommendedRail'),
    recentEmpty: document.querySelector('#recentEmpty'),
    latestEmpty: document.querySelector('#latestEmpty'),
    recommendedEmpty: document.querySelector('#recommendedEmpty'),
    catalogGrid: document.querySelector('#catalogGrid'),
    catalogCount: document.querySelector('#catalogCount'),
    catalogEmpty: document.querySelector('#catalogEmpty'),
    readerView: document.querySelector('#readerView'),
    readerBackButton: document.querySelector('#readerBackButton'),
    bookmarkButton: document.querySelector('#bookmarkButton'),
    readerTitle: document.querySelector('#readerTitle'),
    readerFrame: document.querySelector('#readerFrame'),
    readerStage: document.querySelector('#readerStage'),
    readerSurfaceViewport: document.querySelector('#readerSurfaceViewport'),
    readerSurface: document.querySelector('#readerSurface'),
    readerCanvas: document.querySelector('#readerCanvas'),
    readerImage: document.querySelector('#readerImage'),
    readerLoading: document.querySelector('#readerLoading'),
    readerError: document.querySelector('#readerError'),
    readerPrevButton: document.querySelector('#readerPrevButton'),
    readerNextButton: document.querySelector('#readerNextButton'),
    readerPageStatus: document.querySelector('#readerPageStatus'),
    readerZoomOutButton: document.querySelector('#readerZoomOutButton'),
    readerZoomInButton: document.querySelector('#readerZoomInButton'),
    readerZoomValue: document.querySelector('#readerZoomValue'),
    bookmarkRibbon: document.querySelector('#bookmarkRibbon'),
    closingCover: document.querySelector('#closingCover'),
    closingCoverImage: document.querySelector('#closingCoverImage'),
    closingCoverFallback: document.querySelector('#closingCoverFallback'),
  };

  function metaLabel(item) {
    return [item.author, item.year].filter(Boolean).join(' · ');
  }

  function createCard(item) {
    const article = document.createElement('article');
    article.className = 'reading-card';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'reading-card-button';
    button.setAttribute('aria-label', `Apri ${item.title}`);

    const cover = document.createElement('div');
    cover.className = 'reading-cover';
    const fallback = document.createElement('div');
    fallback.className = 'reading-cover-fallback';
    fallback.setAttribute('aria-hidden', 'true');
    cover.appendChild(fallback);
    if (item.coverUrl) {
      const image = document.createElement('img');
      image.alt = '';
      image.addEventListener('load', () => { fallback.hidden = true; }, { once: true });
      image.addEventListener('error', () => { image.remove(); fallback.hidden = false; }, { once: true });
      cover.appendChild(image);
      window.BaiaPage.setMediaSrc(image, item.coverUrl);
    }
    if (item.bookmark) {
      const marker = document.createElement('span');
      marker.className = 'reading-bookmark-dot';
      marker.setAttribute('aria-hidden', 'true');
      cover.appendChild(marker);
    }

    const title = document.createElement('p');
    title.className = 'reading-card-title';
    title.textContent = item.title;
    title.title = item.title;
    const meta = document.createElement('p');
    meta.className = 'reading-card-meta';
    meta.textContent = metaLabel(item) || String(item.extension || '').replace('.', '').toUpperCase();
    button.append(cover, title, meta);
    button.addEventListener('click', () => openReader(item));
    article.appendChild(button);
    return article;
  }

  function renderRail(container, empty, items) {
    container.replaceChildren(...items.map(createCard));
    empty.hidden = items.length !== 0;
    const shell = container.closest('.showcase-shell');
    if (shell) shell.hidden = items.length === 0;
  }

  function renderCatalog() {
    elements.catalogGrid.replaceChildren(...state.catalog.map(createCard));
    elements.catalogCount.textContent = state.catalog.length === 1 ? '1 titolo' : `${state.catalog.length} titoli`;
    elements.catalogEmpty.hidden = state.catalog.length !== 0;
    elements.catalogGrid.hidden = state.catalog.length === 0;
  }

  function createSearchResult(item) {
    const row = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'search-result-button';
    const title = document.createElement('span');
    title.className = 'search-result-title';
    title.textContent = item.title;
    const meta = document.createElement('span');
    meta.className = 'search-result-meta';
    meta.textContent = [item.author, item.year, ...(item.genres || []).slice(0, 2)].filter(Boolean).join(' · ');
    button.append(title, meta);
    button.addEventListener('click', () => openReader(item));
    row.appendChild(button);
    return row;
  }

  function renderSearchResults() {
    elements.searchResults.replaceChildren(...state.searchResults.map(createSearchResult));
    elements.searchCount.textContent = state.searchResults.length === 1 ? '1 titolo' : `${state.searchResults.length} titoli`;
    elements.searchEmpty.hidden = state.searchResults.length !== 0;
  }

  function closeMenus() {
    for (const [button, menu] of [
      [elements.genreButton, elements.genreMenu],
      [elements.yearButton, elements.yearMenu],
      [elements.authorButton, elements.authorMenu],
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

  function setBrowseMode(mode) {
    state.mode = mode;
    const searchOpen = mode === 'search';
    const activeFilterCount = [state.genre, state.author, state.year].filter(Boolean).length;
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
    elements.authorButton.classList.toggle('has-filter', Boolean(state.author));
    elements.pageTitle.textContent = state.genre || state.author || categoryLabel;
    elements.yearButton.textContent = state.year ? String(state.year) : 'Anno';
    elements.authorButton.title = state.author || 'Filtra per autore';
    elements.clearFiltersButton.disabled = !(state.genre || state.author || state.year);
    if (searchOpen) closeFiltersPanel();
    else closeMenus();
  }

  function toggleMenu(name) {
    const controls = {
      genre: [elements.genreButton, elements.genreMenu, elements.genreFilterSearch],
      year: [elements.yearButton, elements.yearMenu, elements.yearFilterSearch],
      author: [elements.authorButton, elements.authorMenu, elements.authorFilterSearch],
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
    renderFilterMenu({
      container: elements.authorOptions,
      emptyElement: elements.authorFilterEmpty,
      values: state.filters.authors,
      query: elements.authorFilterSearch.value,
      allLabel: 'Tutti gli autori',
      allValue: '',
      selectedValue: state.author,
      onSelect: selectAuthor,
    });
  }

  function renderFilters(filters) {
    state.filters = {
      genres: Array.isArray(filters.genres) ? filters.genres : [],
      years: Array.isArray(filters.years) ? filters.years : [],
      authors: Array.isArray(filters.authors) ? filters.authors : [],
    };
    renderFilterMenus();
  }

  async function loadFilters() {
    const params = new URLSearchParams({ category });
    if (state.genre) params.set('genre', state.genre);
    if (state.author) params.set('author', state.author);
    if (state.year) params.set('year', String(state.year));
    const payload = await window.BaiaPage.apiRequest(`/api/reading/filters?${params}`);
    renderFilters(payload);
  }

  async function loadHome() {
    const payload = await window.BaiaPage.apiRequest(`/api/reading/home?category=${encodeURIComponent(category)}`);
    state.home = payload;
    renderRail(elements.recentRail, elements.recentEmpty, payload.recent || []);
    renderRail(elements.latestRail, elements.latestEmpty, payload.latest || []);
    renderRail(elements.recommendedRail, elements.recommendedEmpty, payload.recommended || []);
  }

  async function loadCatalog() {
    const params = new URLSearchParams({ category, limit: '250' });
    if (state.genre) params.set('genre', state.genre);
    if (state.author) params.set('author', state.author);
    if (state.year) params.set('year', String(state.year));
    const payload = await window.BaiaPage.apiRequest(`/api/reading?${params}`);
    state.catalog = payload.items || [];
    renderCatalog();
  }

  async function loadSearch() {
    const params = new URLSearchParams({
      category,
      limit: '250',
      search: elements.searchInput.value.trim(),
    });
    const payload = await window.BaiaPage.apiRequest(`/api/reading?${params}`);
    state.searchResults = payload.items || [];
    renderSearchResults();
  }

  async function showHome() {
    state.genre = '';
    state.author = '';
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

  async function selectYear(value) {
    state.year = Number(value) || 0;
    setBrowseMode('catalog');
    await Promise.all([loadCatalog(), loadFilters()]);
  }

  async function selectAuthor(value) {
    state.author = String(value || '');
    setBrowseMode('catalog');
    await Promise.all([loadCatalog(), loadFilters()]);
  }

  async function clearAllFilters() {
    if (!(state.genre || state.author || state.year)) return;
    state.genre = '';
    state.author = '';
    state.year = 0;
    setBrowseMode('catalog');
    await Promise.all([loadCatalog(), loadFilters()]);
  }

  async function rawReaderFetch(url) {
    const response = await window.BaiaPage.apiFetch(url);
    if (response.ok) return response;
    let message = `Errore HTTP ${response.status}`;
    try {
      const payload = await response.json();
      if (payload?.error) message = payload.error;
    } catch {}
    throw new Error(message);
  }

  async function fetchEntry(itemId, entryId) {
    return rawReaderFetch(`/api/reading/${itemId}/reader/entry/${entryId}`);
  }

  function setReaderLoading(active) {
    elements.readerLoading.hidden = !active;
    if (active) elements.readerError.hidden = true;
  }

  function showReaderError(error) {
    setReaderLoading(false);
    elements.readerError.textContent = error?.message || 'Impossibile aprire il contenuto.';
    elements.readerError.hidden = false;
  }

  function resetReaderSurfaces() {
    elements.readerFrame.hidden = true;
    elements.readerFrame.classList.remove('pdf-reader-frame', 'epub-reader-frame');
    elements.readerFrame.style.removeProperty('width');
    elements.readerFrame.style.removeProperty('height');
    elements.readerFrame.removeAttribute('src');
    elements.readerFrame.removeAttribute('srcdoc');
    elements.readerFrame.removeAttribute('sandbox');
    elements.readerCanvas.hidden = true;
    const canvasContext = elements.readerCanvas.getContext('2d');
    canvasContext?.clearRect(0, 0, elements.readerCanvas.width, elements.readerCanvas.height);
    elements.readerCanvas.width = 0;
    elements.readerCanvas.height = 0;
    elements.readerCanvas.style.removeProperty('width');
    elements.readerCanvas.style.removeProperty('height');
    elements.readerImage.hidden = true;
    elements.readerImage.removeAttribute('src');
    elements.readerImage.style.removeProperty('width');
    elements.readerImage.style.removeProperty('height');
    elements.readerError.hidden = true;
    elements.readerSurfaceViewport.scrollLeft = 0;
    elements.readerSurfaceViewport.scrollTop = 0;
    elements.closingCover.style.removeProperty('left');
    elements.closingCover.style.removeProperty('top');
    elements.closingCover.style.removeProperty('width');
    elements.closingCover.style.removeProperty('height');
  }

  function centerReaderSurface() {
    requestAnimationFrame(() => {
      const viewport = elements.readerSurfaceViewport;
      viewport.scrollLeft = Math.max(0, (viewport.scrollWidth - viewport.clientWidth) / 2);
      viewport.scrollTop = Math.max(0, (viewport.scrollHeight - viewport.clientHeight) / 2);
    });
  }

  function zoomLabel(renderer) {
    return `${Math.round((renderer?.zoom || 1) * 100)}%`;
  }

  function syncClosingCoverGeometry() {
    const pageElement = state.renderer?.pageElement?.();
    if (!pageElement) return false;
    const pageRect = pageElement.getBoundingClientRect();
    const stageRect = elements.readerStage.getBoundingClientRect();
    if (pageRect.width < 2 || pageRect.height < 2) return false;
    elements.closingCover.style.left = `${pageRect.left - stageRect.left}px`;
    elements.closingCover.style.top = `${pageRect.top - stageRect.top}px`;
    elements.closingCover.style.width = `${pageRect.width}px`;
    elements.closingCover.style.height = `${pageRect.height}px`;
    return true;
  }

  function syncBookmarkGeometry() {
    const pageElement = state.renderer?.pageElement?.();
    if (!pageElement || !elements.bookmarkRibbon) return false;
    const pageRect = pageElement.getBoundingClientRect();
    const stageRect = elements.readerStage.getBoundingClientRect();
    if (pageRect.width < 2 || pageRect.height < 2) return false;

    const ribbonWidth = Math.round(Math.max(70, Math.min(86, pageRect.width * .14)));
    const ribbonHeight = Math.round(ribbonWidth * 1.86);
    const rightInset = Math.round(Math.max(18, Math.min(34, pageRect.width * .06)));
    const left = pageRect.right - stageRect.left - ribbonWidth - rightInset;
    const pageTop = pageRect.top - stageRect.top;
    const startTop = pageTop - ribbonHeight - 18;
    const endTop = pageTop - Math.round(ribbonHeight * .27);

    elements.bookmarkRibbon.style.setProperty('--bookmark-width', `${ribbonWidth}px`);
    elements.bookmarkRibbon.style.setProperty('--bookmark-height', `${ribbonHeight}px`);
    elements.bookmarkRibbon.style.setProperty('--bookmark-left', `${Math.round(left)}px`);
    elements.bookmarkRibbon.style.setProperty('--bookmark-start-top', `${Math.round(startTop)}px`);
    elements.bookmarkRibbon.style.setProperty('--bookmark-end-top', `${Math.round(endTop)}px`);
    return true;
  }

  function syncReaderControls() {
    const renderer = state.renderer;
    if (!renderer) {
      elements.readerPrevButton.disabled = true;
      elements.readerNextButton.disabled = true;
      elements.readerPageStatus.textContent = '';
      elements.readerZoomOutButton.disabled = true;
      elements.readerZoomInButton.disabled = true;
      elements.readerZoomValue.textContent = '100%';
      return;
    }
    elements.readerPrevButton.disabled = !renderer.canPrev();
    elements.readerNextButton.disabled = !renderer.canNext();
    elements.readerPageStatus.textContent = renderer.status();
    elements.readerZoomOutButton.disabled = renderer.canZoomOut ? !renderer.canZoomOut() : true;
    elements.readerZoomInButton.disabled = renderer.canZoomIn ? !renderer.canZoomIn() : true;
    elements.readerZoomValue.textContent = zoomLabel(renderer);
  }

  let pdfJsPromise = null;

  async function loadPdfJs() {
    if (!pdfJsPromise) {
      pdfJsPromise = import('/vendor/pdfjs/pdf.min.mjs').then((pdfjsLib) => {
        pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
        return pdfjsLib;
      });
    }
    return pdfJsPromise;
  }

  class PdfRenderer {
    constructor(item, manifest) {
      this.item = item;
      this.manifest = manifest;
      const bookmarked = manifest.bookmark?.kind === 'page' ? Number(manifest.bookmark.page) : 1;
      this.page = Math.max(1, bookmarked || 1);
      this.pageCount = null;
      this.document = null;
      this.loadingTask = null;
      this.renderTask = null;
      this.renderToken = 0;
      this.fileUrl = '';
      this.zoom = 1;
      this.minZoom = .7;
      this.maxZoom = 1.6;
      this.zoomStep = .1;
    }

    async init() {
      const pdfjsLib = await loadPdfJs();
      this.fileUrl = await window.BaiaPage.mediaUrl(this.manifest.fileUrl || this.item.fileUrl);
      this.loadingTask = pdfjsLib.getDocument({
        url: this.fileUrl,
        rangeChunkSize: 256 * 1024,
        disableAutoFetch: false,
        disableStream: false,
      });
      this.document = await this.loadingTask.promise;
      this.pageCount = this.document.numPages;
      this.page = utils.clamp(this.page, 1, this.pageCount);
      elements.readerCanvas.hidden = false;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await this.renderPage();
      setReaderLoading(false);
    }

    async renderPage() {
      if (!this.document) return;
      const token = ++this.renderToken;
      setReaderLoading(true);
      this.renderTask?.cancel();
      const pdfPage = await this.document.getPage(this.page);
      if (token !== this.renderToken) return;

      const baseViewport = pdfPage.getViewport({ scale: 1 });
      const stage = elements.readerStage;
      if (!stage) throw new Error('Area del reader PDF non disponibile.');
      const stageRect = stage.getBoundingClientRect();
      const availableWidth = Math.max(1, stageRect.width - 156);
      const availableHeight = Math.max(1, stageRect.height - 72);
      const fitScale = Math.min(availableWidth / baseViewport.width, availableHeight / baseViewport.height);
      const cssScale = fitScale * this.zoom;
      const viewport = pdfPage.getViewport({ scale: cssScale });
      const outputScale = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = elements.readerCanvas;
      const context = canvas.getContext('2d', { alpha: false });
      canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
      canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      this.renderTask = pdfPage.render({
        canvasContext: context,
        viewport,
        transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0],
        background: '#ffffff',
      });
      try {
        await this.renderTask.promise;
      } catch (error) {
        if (error?.name !== 'RenderingCancelledException') throw error;
        return;
      }
      if (token !== this.renderToken) return;
      setReaderLoading(false);
      centerReaderSurface();
      syncReaderControls();
    }

    async prev() { if (this.canPrev()) { this.page -= 1; await this.renderPage(); } }
    async next() { if (this.canNext()) { this.page += 1; await this.renderPage(); } }
    canPrev() { return this.page > 1; }
    canNext() { return Boolean(this.pageCount && this.page < this.pageCount); }
    canZoomOut() { return this.zoom > this.minZoom + .001; }
    canZoomIn() { return this.zoom < this.maxZoom - .001; }
    async zoomOut() {
      if (!this.canZoomOut()) return;
      this.zoom = Math.max(this.minZoom, Number((this.zoom - this.zoomStep).toFixed(2)));
      await this.renderPage();
    }
    async zoomIn() {
      if (!this.canZoomIn()) return;
      this.zoom = Math.min(this.maxZoom, Number((this.zoom + this.zoomStep).toFixed(2)));
      await this.renderPage();
    }
    async resetZoom() {
      if (Math.abs(this.zoom - 1) < .001) return;
      this.zoom = 1;
      await this.renderPage();
    }
    status() { return this.pageCount ? `Pagina ${this.page} / ${this.pageCount}` : `Pagina ${this.page}`; }
    locator() { return utils.pageLocator(this.page, this.pageCount); }
    pageElement() { return elements.readerCanvas; }
    async resize() { await this.renderPage(); }
    destroy() {
      this.renderToken += 1;
      this.renderTask?.cancel();
      this.loadingTask?.destroy();
      this.document?.destroy();
      elements.readerCanvas.hidden = true;
    }
  }

  class CbzRenderer {
    constructor(item, manifest) {
      this.item = item;
      this.pages = manifest.pages || [];
      const bookmarkPage = manifest.bookmark?.kind === 'page' ? Number(manifest.bookmark.page) : 1;
      this.index = utils.clamp((bookmarkPage || 1) - 1, 0, Math.max(0, this.pages.length - 1));
      this.objectUrl = '';
      this.loadingToken = 0;
      this.zoom = 1;
      this.minZoom = .7;
      this.maxZoom = 1.6;
      this.zoomStep = .1;
    }

    async init() {
      if (!this.pages.length) throw new Error('Il CBZ non contiene pagine leggibili.');
      elements.readerImage.hidden = false;
      await this.renderPage();
      setReaderLoading(false);
    }

    async renderPage() {
      const token = ++this.loadingToken;
      setReaderLoading(true);
      const response = await fetchEntry(this.item.id, this.pages[this.index].entryId);
      const blob = await response.blob();
      if (token !== this.loadingToken) return;
      const nextUrl = URL.createObjectURL(blob);
      const oldUrl = this.objectUrl;
      this.objectUrl = nextUrl;
      elements.readerImage.src = nextUrl;
      elements.readerImage.alt = `${this.item.title}, pagina ${this.index + 1}`;
      try { await elements.readerImage.decode(); } catch {}
      if (token !== this.loadingToken) return;
      this.applyGeometry();
      if (oldUrl) URL.revokeObjectURL(oldUrl);
      setReaderLoading(false);
      syncReaderControls();
    }

    applyGeometry() {
      const stageRect = elements.readerStage.getBoundingClientRect();
      const naturalWidth = Math.max(1, elements.readerImage.naturalWidth || 1);
      const naturalHeight = Math.max(1, elements.readerImage.naturalHeight || 1);
      const availableWidth = Math.max(1, stageRect.width - 156);
      const availableHeight = Math.max(1, stageRect.height - 72);
      const fitScale = Math.min(availableWidth / naturalWidth, availableHeight / naturalHeight);
      const scale = fitScale * this.zoom;
      elements.readerImage.style.width = `${Math.max(1, Math.round(naturalWidth * scale))}px`;
      elements.readerImage.style.height = `${Math.max(1, Math.round(naturalHeight * scale))}px`;
      centerReaderSurface();
    }

    async prev() { if (this.canPrev()) { this.index -= 1; await this.renderPage(); } }
    async next() { if (this.canNext()) { this.index += 1; await this.renderPage(); } }
    canPrev() { return this.index > 0; }
    canNext() { return this.index < this.pages.length - 1; }
    canZoomOut() { return this.zoom > this.minZoom + .001; }
    canZoomIn() { return this.zoom < this.maxZoom - .001; }
    async zoomOut() {
      if (!this.canZoomOut()) return;
      this.zoom = Math.max(this.minZoom, Number((this.zoom - this.zoomStep).toFixed(2)));
      this.applyGeometry();
      syncReaderControls();
    }
    async zoomIn() {
      if (!this.canZoomIn()) return;
      this.zoom = Math.min(this.maxZoom, Number((this.zoom + this.zoomStep).toFixed(2)));
      this.applyGeometry();
      syncReaderControls();
    }
    async resetZoom() {
      if (Math.abs(this.zoom - 1) < .001) return;
      this.zoom = 1;
      this.applyGeometry();
      syncReaderControls();
    }
    status() { return `Pagina ${this.index + 1} / ${this.pages.length}`; }
    locator() { return utils.pageLocator(this.index + 1, this.pages.length); }
    pageElement() { return elements.readerImage; }
    async resize() { this.applyGeometry(); }
    destroy() {
      this.loadingToken += 1;
      if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = '';
      elements.readerImage.removeAttribute('src');
    }
  }

  function elementsByLocalName(documentValue, localName) {
    return [...documentValue.getElementsByTagName('*')].filter((element) => element.localName === localName);
  }

  function copyEpubAttributes(sourceElement, targetElement) {
    if (!sourceElement || !targetElement) return;
    for (const attribute of sourceElement.attributes || []) {
      // xmlns e gli attributi XML con namespace non servono nel documento HTML
      // finale e non tutti possono essere impostati con setAttribute su HTML.
      if (attribute.name === 'xmlns' || attribute.name.includes(':')) continue;
      targetElement.setAttribute(attribute.name, attribute.value);
    }
  }

  function parseEpubDocument(source) {
    const parser = new DOMParser();
    const xhtmlDocument = parser.parseFromString(String(source || ''), 'application/xhtml+xml');
    const parseFailed = elementsByLocalName(xhtmlDocument, 'parsererror').length > 0;
    const sourceHtml = elementsByLocalName(xhtmlDocument, 'html')[0];
    const sourceHead = elementsByLocalName(xhtmlDocument, 'head')[0];
    const sourceBody = elementsByLocalName(xhtmlDocument, 'body')[0];

    if (!parseFailed && sourceHtml && sourceHead && sourceBody) {
      // Gli EPUB sono XHTML: elementi come <div ... /> sono realmente vuoti.
      // Se il sorgente viene passato direttamente al parser HTML, quei tag
      // possono invece inglobare tutto il capitolo seguente. Normalizziamo
      // quindi prima l'XHTML in un vero HTMLDocument, che serializzerà i tag
      // non-void con la relativa chiusura esplicita.
      const htmlDocument = document.implementation.createHTMLDocument('');
      copyEpubAttributes(sourceHtml, htmlDocument.documentElement);
      copyEpubAttributes(sourceHead, htmlDocument.head);
      copyEpubAttributes(sourceBody, htmlDocument.body);
      for (const node of [...sourceHead.childNodes]) htmlDocument.head.appendChild(htmlDocument.importNode(node, true));
      for (const node of [...sourceBody.childNodes]) htmlDocument.body.appendChild(htmlDocument.importNode(node, true));
      return { documentValue: htmlDocument, xhtmlSafe: true };
    }

    // Fallback conservativo per EPUB non conformi: il contenuto rimane
    // leggibile, ma non rimuoviamo genericamente elementi nascosti perché un
    // tag XHTML autochiuso interpretato come HTML potrebbe contenere il testo.
    return {
      documentValue: parser.parseFromString(String(source || ''), 'text/html'),
      xhtmlSafe: false,
    };
  }

  class EpubRenderer {
    constructor(item, manifest) {
      this.item = item;
      this.entries = manifest.entries || [];
      this.entryByName = new Map();
      this.entryByLowerName = new Map();
      for (const entry of this.entries) {
        const normalized = utils.normalizeArchivePath(entry.name);
        this.entryByName.set(normalized, entry);
        this.entryByLowerName.set(normalized.toLocaleLowerCase('en'), entry);
      }
      this.spine = [];
      this.spineIndex = 0;
      this.pageIndex = 0;
      this.pageCount = 1;
      this.pageStride = 1;
      this.resourceUrls = new Map();
      this.ownedUrls = new Set();
      this.busy = false;
      this.resume = utils.parseBaiaEpubLocator(manifest.bookmark);
      this.resizeTimer = null;
      this.zoom = 1;
      this.minZoom = .75;
      this.maxZoom = 1.5;
      this.zoomStep = .1;
    }

    entry(pathValue) {
      const normalized = utils.normalizeArchivePath(pathValue);
      return this.entryByName.get(normalized) || this.entryByLowerName.get(normalized.toLocaleLowerCase('en')) || null;
    }

    async entryText(entry) {
      const response = await fetchEntry(this.item.id, entry.entryId);
      return response.text();
    }

    async init() {
      const containerEntry = this.entry('META-INF/container.xml');
      if (!containerEntry) throw new Error('EPUB non valido: container.xml mancante.');
      const containerText = await this.entryText(containerEntry);
      const containerDocument = new DOMParser().parseFromString(containerText, 'application/xml');
      const rootfile = elementsByLocalName(containerDocument, 'rootfile')[0];
      const packagePath = utils.normalizeArchivePath(rootfile?.getAttribute('full-path'));
      const packageEntry = this.entry(packagePath);
      if (!packagePath || !packageEntry) throw new Error('EPUB non valido: package OPF non trovato.');

      const packageText = await this.entryText(packageEntry);
      const packageDocument = new DOMParser().parseFromString(packageText, 'application/xml');
      const manifestById = new Map();
      for (const manifestItem of elementsByLocalName(packageDocument, 'item')) {
        const id = manifestItem.getAttribute('id');
        const href = manifestItem.getAttribute('href');
        if (!id || !href) continue;
        const resolvedPath = utils.resolveArchivePath(packagePath, href);
        const entry = this.entry(resolvedPath);
        if (entry) manifestById.set(id, {
          id,
          path: resolvedPath,
          entry,
          mediaType: manifestItem.getAttribute('media-type') || entry.mimeType,
          properties: manifestItem.getAttribute('properties') || '',
        });
      }
      for (const itemref of elementsByLocalName(packageDocument, 'itemref')) {
        const item = manifestById.get(itemref.getAttribute('idref'));
        if (item) this.spine.push(item);
      }
      if (!this.spine.length) {
        this.spine = [...manifestById.values()].filter((entry) => /html|xhtml/i.test(entry.mediaType || ''));
      }
      if (!this.spine.length) throw new Error('EPUB non valido: contenuto di lettura assente.');

      const resumeIndex = this.resume ? utils.clamp(this.resume.spineIndex, 0, this.spine.length - 1) : 0;
      const resumeProgression = this.resume?.progressionWithinSpine || 0;
      elements.readerFrame.setAttribute('sandbox', 'allow-same-origin');
      elements.readerFrame.classList.add('epub-reader-frame');
      elements.readerFrame.hidden = false;
      await this.loadSpine(resumeIndex, resumeProgression);
      setReaderLoading(false);
    }

    async resourceUrl(pathValue) {
      const normalized = utils.normalizeArchivePath(pathValue);
      if (!normalized) return '';
      if (this.resourceUrls.has(normalized)) return this.resourceUrls.get(normalized);
      const entry = this.entry(normalized);
      if (!entry) return '';
      const response = await fetchEntry(this.item.id, entry.entryId);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      this.resourceUrls.set(normalized, url);
      this.ownedUrls.add(url);
      return url;
    }

    async rewriteCss(cssText, basePath) {
      let output = String(cssText || '').replace(/@import\s+(?:url\()?['\"]?[^;\)]+['\"]?\)?\s*;/gi, '');
      const matches = [...output.matchAll(/url\(\s*(['\"]?)([^'\")]+)\1\s*\)/gi)];
      for (const match of matches) {
        const reference = match[2].trim();
        if (reference.toLowerCase().startsWith('data:')) continue;
        const resolved = utils.resolveArchivePath(basePath, reference);
        if (!resolved) {
          output = output.replace(match[0], 'url("")');
          continue;
        }
        const url = await this.resourceUrl(resolved);
        output = output.replace(match[0], url ? `url("${url}")` : 'url("")');
      }
      return output;
    }

    async prepareDocument(source, sectionPath) {
      const { documentValue, xhtmlSafe } = parseEpubDocument(source);
      documentValue.querySelectorAll('script, iframe, object, embed, form, base, meta[http-equiv]').forEach((node) => node.remove());
      documentValue.querySelectorAll('link').forEach((node) => node.remove());

      // Il layout Baia rimuove gli stili inline dell'EPUB. Prima di farlo deve
      // rispettare la semantica originale degli elementi nascosti: altrimenti
      // blocchi tecnici display:none (per esempio i parametri dei template
      // Wikisource "IncludiIntestazione") diventerebbero testo visibile.
      // La rimozione generica è sicura soltanto dopo la normalizzazione XHTML:
      // nel fallback HTML un <div ... /> potrebbe inglobare il capitolo intero.
      if (xhtmlSafe) {
        for (const node of documentValue.querySelectorAll('[hidden], [aria-hidden="true"], [style]')) {
          const styleValue = String(node.getAttribute('style') || '');
          const hiddenByStyle = utils.epubStyleHidesElement(styleValue);
          if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true' || hiddenByStyle) node.remove();
        }
      }

      // Alcuni EPUB esportati da Wikisource incorporano banner tecnici sullo
      // stato di revisione (per esempio "Questo testo è completo"). Non sono
      // parte dell'opera: Baia nasconde soltanto i contenitori strutturali
      // specifici dell'export Wikisource, senza filtrare frasi del libro.
      documentValue
        .querySelectorAll(`${xhtmlSafe ? '[id^="textquality"], ' : ''}.quality-ns0, table.quality-msg, .tl-testo-quality`)
        .forEach((node) => node.remove());

      // Gli EPUB reali portano spesso CSS editoriali pensati per altri reader
      // (page-break, colonne, dimensioni fisse, writing mode, ecc.). Il reader
      // Baia mantiene il markup semantico ma possiede interamente il layout:
      // in questo modo uno spine item reflowable non può creare colonne vuote.
      documentValue.querySelectorAll('style').forEach((node) => node.remove());
      for (const node of documentValue.querySelectorAll('[style]')) node.removeAttribute('style');

      const assetAttributes = [
        ['img[src]', 'src'], ['source[src]', 'src'], ['audio[src]', 'src'], ['video[src]', 'src'],
        ['video[poster]', 'poster'], ['image[href]', 'href'],
      ];
      for (const [selector, attribute] of assetAttributes) {
        for (const node of documentValue.querySelectorAll(selector)) {
          const original = node.getAttribute(attribute);
          if (original && original.trim().toLowerCase().startsWith('data:')) continue;
          const resolved = utils.resolveArchivePath(sectionPath, original);
          const url = resolved ? await this.resourceUrl(resolved) : '';
          if (url) node.setAttribute(attribute, url);
          else node.removeAttribute(attribute);
        }
      }
      for (const node of documentValue.querySelectorAll('image')) {
        const attribute = 'xlink:href';
        const original = node.getAttribute(attribute);
        if (!original || original.trim().toLowerCase().startsWith('data:')) continue;
        const resolved = utils.resolveArchivePath(sectionPath, original);
        const url = resolved ? await this.resourceUrl(resolved) : '';
        if (url) node.setAttribute(attribute, url);
        else node.removeAttribute(attribute);
      }
      for (const node of documentValue.querySelectorAll('[srcset]')) node.removeAttribute('srcset');
      for (const anchor of documentValue.querySelectorAll('a[href]')) {
        anchor.removeAttribute('href');
        anchor.style.cursor = 'default';
      }

      // Il flusso EPUB usa colonne larghe esattamente quanto la viewport.
      // I margini della pagina sono applicati a un wrapper frammentabile e
      // clonati in ogni colonna: non servono gap artificiali fra le pagine.
      const contentRoot = documentValue.createElement('main');
      contentRoot.className = 'baia-epub-content';
      while (documentValue.body.firstChild) contentRoot.appendChild(documentValue.body.firstChild);
      documentValue.body.appendChild(contentRoot);

      const csp = documentValue.createElement('meta');
      csp.setAttribute('http-equiv', 'Content-Security-Policy');
      csp.setAttribute('content', "default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data: blob:; style-src 'unsafe-inline' data: blob:; connect-src 'none'; object-src 'none'; frame-src 'none'");
      documentValue.head.prepend(csp);

      const paginationStyle = documentValue.createElement('style');
      paginationStyle.textContent = `
        :root {
          color-scheme: light;
          --baia-page-gutter: clamp(38px, 6vw, 86px);
          --baia-page-gap: clamp(76px, 12vw, 172px);
          --baia-font-size: ${Math.round(18 * this.zoom * 100) / 100}px;
        }
        html {
          width: 100%;
          height: 100%;
          margin: 0 !important;
          padding: 0 !important;
          overflow: hidden !important;
          background: #f5f1e7 !important;
        }
        body {
          box-sizing: border-box !important;
          width: 100vw !important;
          height: 100vh !important;
          min-width: 0 !important;
          min-height: 0 !important;
          margin: 0 !important;
          padding: 0 !important;
          overflow: visible !important;
          column-width: 100vw !important;
          column-gap: 0 !important;
          column-fill: auto !important;
          column-rule: none !important;
          background: #f5f1e7 !important;
          color: #171717 !important;
          font-family: Georgia, 'Times New Roman', serif !important;
          font-size: var(--baia-font-size) !important;
          line-height: 1.55 !important;
          orphans: 2;
          widows: 2;
          visibility: visible !important;
          opacity: 1 !important;
        }
        .baia-epub-content {
          box-sizing: border-box !important;
          width: 100% !important;
          min-width: 0 !important;
          margin: 0 !important;
          padding: 32px var(--baia-page-gutter) !important;
          -webkit-box-decoration-break: clone;
          box-decoration-break: clone;
        }
        body, body * { box-sizing: border-box; }
        body * {
          max-width: 100%;
          color: inherit !important;
          writing-mode: horizontal-tb !important;
          break-before: auto !important;
          break-after: auto !important;
          page-break-before: auto !important;
          page-break-after: auto !important;
        }
        p, li, blockquote { overflow-wrap: break-word; }
        h1, h2, h3, h4, h5, h6 { break-after: avoid !important; page-break-after: avoid !important; }
        img, svg, video {
          display: block;
          width: auto !important;
          height: auto !important;
          max-width: 100% !important;
          max-height: calc(100vh - 64px) !important;
          margin-left: auto;
          margin-right: auto;
          object-fit: contain !important;
          break-inside: avoid !important;
        }
        table { width: 100% !important; border-collapse: collapse; }
        table, pre { max-width: 100% !important; overflow-wrap: anywhere !important; }
        pre { white-space: pre-wrap !important; }
        a { color: inherit !important; text-decoration: none !important; }
      `;
      documentValue.head.appendChild(paginationStyle);
      return `<!doctype html>${documentValue.documentElement.outerHTML}`;
    }

    updateFrameGeometry() {
      const stageRect = elements.readerStage.getBoundingClientRect();
      const availableWidth = Math.max(220, stageRect.width - 156);
      const availableHeight = Math.max(320, stageRect.height - 72);
      const pageAspect = .68;
      let height = availableHeight;
      let width = height * pageAspect;
      if (width > availableWidth) {
        width = availableWidth;
        height = width / pageAspect;
      }
      elements.readerFrame.style.width = `${Math.floor(width)}px`;
      elements.readerFrame.style.height = `${Math.floor(height)}px`;
    }

    viewportWidth(documentValue = elements.readerFrame.contentDocument) {
      // innerWidth/clientWidth sono interi. Con scaling Windows frazionario
      // (per esempio 125%) il CSS 100vw usato dalle colonne può invece valere
      // 403.2 o 445.6 px. Usare la misura arrotondata crea una deriva opposta
      // tra Edge e WebView2 che cresce a ogni pagina della sezione.
      const measurementHost = documentValue?.body || documentValue?.documentElement;
      if (measurementHost && documentValue?.createElement) {
        const probe = documentValue.createElement('div');
        probe.setAttribute('aria-hidden', 'true');
        probe.style.cssText = [
          'position:fixed',
          'left:0',
          'top:0',
          'width:100vw',
          'height:0',
          'margin:0',
          'padding:0',
          'border:0',
          'visibility:hidden',
          'pointer-events:none',
          'contain:strict',
        ].join(';');
        measurementHost.appendChild(probe);
        const measuredWidth = probe.getBoundingClientRect().width;
        probe.remove();
        if (Number.isFinite(measuredWidth) && measuredWidth > 0) return measuredWidth;
      }

      const candidates = [
        elements.readerFrame.contentWindow?.innerWidth,
        documentValue?.documentElement?.clientWidth,
        elements.readerFrame.clientWidth,
      ];
      const width = candidates.find((value) => Number.isFinite(Number(value)) && Number(value) > 0);
      return Math.max(1, Number(width) || 1);
    }

    async loadSpine(index, progression = 0) {
      if (this.busy) return;
      this.busy = true;
      setReaderLoading(true);
      try {
        const nextIndex = utils.clamp(index, 0, this.spine.length - 1);
        const section = this.spine[nextIndex];
        const source = await this.entryText(section.entry);
        const prepared = await this.prepareDocument(source, section.path);
        this.spineIndex = nextIndex;
        this.pageIndex = 0;
        this.updateFrameGeometry();
        elements.readerFrame.srcdoc = prepared;
        await new Promise((resolve) => elements.readerFrame.addEventListener('load', resolve, { once: true }));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const documentValue = elements.readerFrame.contentDocument;
        if (!documentValue?.body) throw new Error('EPUB non valido: sezione senza contenuto HTML.');
        await this.waitForSectionLayout(documentValue);
        elements.readerFrame.contentWindow?.scrollTo(0, 0);
        const viewportWidth = this.viewportWidth(documentValue);
        const scrollWidth = Math.max(
          documentValue.documentElement?.scrollWidth || 0,
          documentValue.body?.scrollWidth || 0,
          viewportWidth,
        );
        this.pageCount = utils.epubPageCount(scrollWidth, viewportWidth);
        this.pageStride = viewportWidth;
        this.pageIndex = this.pageCount > 1
          ? Math.round(utils.clamp(progression, 0, 1) * (this.pageCount - 1))
          : 0;
        this.scrollToPage();
        centerReaderSurface();
      } finally {
        this.busy = false;
        setReaderLoading(false);
        syncReaderControls();
      }
    }

    async waitForSectionLayout(documentValue) {
      try { await documentValue.fonts?.ready; } catch {}
      const images = [...documentValue.images];
      await Promise.all(images.map((image) => {
        if (image.complete) return Promise.resolve();
        return new Promise((resolve) => {
          image.addEventListener('load', resolve, { once: true });
          image.addEventListener('error', resolve, { once: true });
          setTimeout(resolve, 1200);
        });
      }));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }

    scrollToPage() {
      const documentValue = elements.readerFrame.contentDocument;
      const offset = this.pageIndex * this.pageStride;
      const scroller = documentValue?.scrollingElement || documentValue?.documentElement;

      // Le colonne EPUB sono larghe esattamente 100vw e non hanno gap.
      // Lo scroll nativo può quindi raggiungere ogni pagina con un multiplo
      // esatto della viewport, inclusa l'ultima, senza trasformazioni GPU o
      // correzioni cumulative che dipendano dal numero di pagina.
      if (documentValue?.body) documentValue.body.style.removeProperty('transform');
      if (scroller) {
        scroller.scrollTop = 0;
        scroller.scrollLeft = offset;
      }
      syncReaderControls();
    }

    async prev() {
      if (this.busy || !this.canPrev()) return;
      if (this.pageIndex > 0) {
        this.pageIndex -= 1;
        this.scrollToPage();
        return;
      }
      await this.loadSpine(this.spineIndex - 1, 1);
    }

    async next() {
      if (this.busy || !this.canNext()) return;
      if (this.pageIndex < this.pageCount - 1) {
        this.pageIndex += 1;
        this.scrollToPage();
        return;
      }
      await this.loadSpine(this.spineIndex + 1, 0);
    }

    canPrev() { return this.spineIndex > 0 || this.pageIndex > 0; }
    canNext() { return this.spineIndex < this.spine.length - 1 || this.pageIndex < this.pageCount - 1; }
    canZoomOut() { return this.zoom > this.minZoom + .001; }
    canZoomIn() { return this.zoom < this.maxZoom - .001; }
    async zoomOut() {
      if (this.busy || !this.canZoomOut()) return;
      const within = this.pageCount > 1 ? this.pageIndex / (this.pageCount - 1) : 0;
      this.zoom = Math.max(this.minZoom, Number((this.zoom - this.zoomStep).toFixed(2)));
      await this.loadSpine(this.spineIndex, within);
    }
    async zoomIn() {
      if (this.busy || !this.canZoomIn()) return;
      const within = this.pageCount > 1 ? this.pageIndex / (this.pageCount - 1) : 0;
      this.zoom = Math.min(this.maxZoom, Number((this.zoom + this.zoomStep).toFixed(2)));
      await this.loadSpine(this.spineIndex, within);
    }
    async resetZoom() {
      if (this.busy || Math.abs(this.zoom - 1) < .001) return;
      const within = this.pageCount > 1 ? this.pageIndex / (this.pageCount - 1) : 0;
      this.zoom = 1;
      await this.loadSpine(this.spineIndex, within);
    }
    status() {
      if (this.spine.length === 1) return `Pagina ${this.pageIndex + 1} / ${this.pageCount}`;
      return `Sezione ${this.spineIndex + 1} di ${this.spine.length} · pagina ${this.pageIndex + 1} di ${this.pageCount}`;
    }
    locator() {
      const within = this.pageCount > 1 ? this.pageIndex / (this.pageCount - 1) : 0;
      const overall = (this.spineIndex + within) / Math.max(1, this.spine.length);
      return utils.makeBaiaEpubLocator(this.spineIndex, within, overall);
    }
    pageElement() { return elements.readerFrame; }
    async resize() {
      const within = this.pageCount > 1 ? this.pageIndex / (this.pageCount - 1) : 0;
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.loadSpine(this.spineIndex, within).catch(showReaderError), 180);
    }
    destroy() {
      clearTimeout(this.resizeTimer);
      for (const url of this.ownedUrls) URL.revokeObjectURL(url);
      this.ownedUrls.clear();
      this.resourceUrls.clear();
      elements.readerFrame.removeAttribute('srcdoc');
      elements.readerFrame.classList.remove('epub-reader-frame');
    }
  }

  async function buildRenderer(item, manifest) {
    if (manifest.format === 'pdf') return new PdfRenderer(item, manifest);
    if (manifest.format === 'cbz') return new CbzRenderer(item, manifest);
    if (manifest.format === 'epub') return new EpubRenderer(item, manifest);
    throw new Error('Formato non supportato dal reader.');
  }

  async function prepareClosingCover(item) {
    elements.closingCoverImage.hidden = true;
    elements.closingCoverImage.removeAttribute('src');
    elements.closingCoverFallback.textContent = '';
    elements.closingCoverFallback.style.display = 'block';
    if (!item.coverUrl) return;
    try {
      const url = await window.BaiaPage.mediaUrl(item.coverUrl);
      elements.closingCoverImage.src = url;
      elements.closingCoverImage.hidden = false;
      elements.closingCoverFallback.style.display = 'none';
    } catch {}
  }

  async function openReader(item) {
    if (state.readerItem) return;
    state.readerItem = item;
    state.closingReader = false;
    elements.readerTitle.textContent = item.title;
    elements.readerView.classList.remove('is-bookmarking');
    elements.bookmarkRibbon.hidden = true;
    elements.closingCover.hidden = true;
    elements.readerView.hidden = false;
    elements.browseView.hidden = true;
    elements.bookmarkButton.disabled = false;
    resetReaderSurfaces();
    setReaderLoading(true);
    window.BaiaPage.shellImmersive(true);
    prepareClosingCover(item);
    try {
      const manifest = await window.BaiaPage.apiRequest(`/api/reading/${item.id}/reader/manifest`);
      const renderer = await buildRenderer(item, manifest);
      state.renderer = renderer;
      await renderer.init();
      syncReaderControls();
    } catch (error) {
      console.error(error);
      showReaderError(error);
      window.BaiaPage.shellToast(error.message);
    }
  }

  async function closeReader({ refresh = false } = {}) {
    if (!state.readerItem || state.closingReader) return;
    state.closingReader = true;
    try { state.renderer?.destroy(); } catch (error) { console.error(error); }
    state.renderer = null;
    state.readerItem = null;
    resetReaderSurfaces();
    elements.readerView.classList.remove('is-bookmarking');
    elements.closingCover.hidden = true;
    elements.readerView.hidden = true;
    elements.browseView.hidden = false;
    elements.bookmarkButton.disabled = false;
    window.BaiaPage.shellImmersive(false);
    state.closingReader = false;
    if (refresh) {
      const tasks = [loadHome(), loadFilters()];
      if (state.mode === 'catalog') tasks.push(loadCatalog());
      if (state.mode === 'search') tasks.push(loadSearch());
      await Promise.all(tasks).catch((error) => window.BaiaPage.shellToast(error.message));
    }
  }

  async function saveBookmark() {
    if (!state.readerItem || !state.renderer || elements.bookmarkButton.disabled) return;
    elements.bookmarkButton.disabled = true;
    try {
      const payload = await window.BaiaPage.apiRequest(`/api/reading/${state.readerItem.id}/bookmark`, {
        method: 'PUT',
        body: JSON.stringify({ locator: state.renderer.locator() }),
      });
      state.readerItem.bookmark = payload.bookmark;
      state.readerItem.bookmarkedAt = payload.updatedAt;
      syncClosingCoverGeometry();
      syncBookmarkGeometry();
      elements.bookmarkRibbon.hidden = false;
      elements.closingCover.hidden = false;
      elements.readerView.classList.add('is-bookmarking');
      setTimeout(() => closeReader({ refresh: true }), 1240);
    } catch (error) {
      elements.bookmarkButton.disabled = false;
      window.BaiaPage.shellToast(error.message);
    }
  }

  function handleError(error) {
    window.BaiaPage.shellToast(error?.message || 'Operazione non riuscita.');
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
  elements.authorButton.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleMenu('author');
  });
  elements.genreMenu.addEventListener('click', (event) => event.stopPropagation());
  elements.yearMenu.addEventListener('click', (event) => event.stopPropagation());
  elements.authorMenu.addEventListener('click', (event) => event.stopPropagation());
  for (const input of [elements.genreFilterSearch, elements.yearFilterSearch, elements.authorFilterSearch]) {
    input.addEventListener('input', renderFilterMenus);
    input.addEventListener('keydown', (event) => event.stopPropagation());
  }
  elements.clearFiltersButton.addEventListener('click', () => clearAllFilters().catch(handleError));
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

  elements.readerBackButton.addEventListener('click', () => closeReader());
  elements.bookmarkButton.addEventListener('click', saveBookmark);
  elements.readerPrevButton.addEventListener('click', () => state.renderer?.prev().catch(showReaderError));
  elements.readerNextButton.addEventListener('click', () => state.renderer?.next().catch(showReaderError));
  elements.readerZoomOutButton.addEventListener('click', () => Promise.resolve(state.renderer?.zoomOut?.()).catch(showReaderError));
  elements.readerZoomValue.addEventListener('click', () => Promise.resolve(state.renderer?.resetZoom?.()).catch(showReaderError));
  elements.readerZoomInButton.addEventListener('click', () => Promise.resolve(state.renderer?.zoomIn?.()).catch(showReaderError));

  document.addEventListener('keydown', (event) => {
    if (state.readerItem && !elements.readerView.hidden) {
      if (elements.readerView.classList.contains('is-bookmarking')) return;
      if (event.key === 'ArrowLeft') { event.preventDefault(); state.renderer?.prev().catch(showReaderError); }
      if (event.key === 'ArrowRight') { event.preventDefault(); state.renderer?.next().catch(showReaderError); }
      if (event.key === 'Escape') { event.preventDefault(); closeReader(); }
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
    }
  });

  window.addEventListener('resize', () => {
    Promise.resolve(state.renderer?.resize?.()).catch(showReaderError);
  });
  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin) return;
    if (event.data?.type === 'shell-page-visibility' && event.data.active === false && state.readerItem) closeReader();
    if (event.data?.type === 'library-metadata-updated') {
      const tasks = [loadHome(), loadFilters()];
      if (state.mode === 'catalog') tasks.push(loadCatalog());
      if (state.mode === 'search') tasks.push(loadSearch());
      Promise.all(tasks).catch(handleError);
    }
  });
  window.addEventListener('beforeunload', () => window.BaiaPage.shellImmersive(false));

  setBrowseMode('home');
  Promise.all([loadHome(), loadFilters()]).catch((error) => window.BaiaPage.shellToast(`${categoryLabel}: ${error.message}`));
})();
