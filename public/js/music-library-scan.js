'use strict';

(() => {
  const elements = {
    panel: document.querySelector('#musicLibraryScanPanel'),
    button: document.querySelector('#musicLibraryScanButton'),
    availability: document.querySelector('#musicLibraryScanAvailability'),
    message: document.querySelector('#musicLibraryScanMessage'),
    results: document.querySelector('#musicLibraryScanResults'),
    created: document.querySelector('#musicScanCreated'),
    updated: document.querySelector('#musicScanUpdated'),
    reactivated: document.querySelector('#musicScanReactivated'),
    missing: document.querySelector('#musicScanMissing'),
    unchanged: document.querySelector('#musicScanUnchanged'),
    ignored: document.querySelector('#musicScanIgnored'),
    errors: document.querySelector('#musicScanErrors'),
    summary: document.querySelector('#musicScanSummary'),
    duration: document.querySelector('#musicScanDuration'),
    issuesPanel: document.querySelector('#musicScanIssuesPanel'),
    issues: document.querySelector('#musicScanIssues'),
    issuesNote: document.querySelector('#musicScanIssuesNote'),
  };

  if (!elements.button) return;

  const state = {
    available: false,
    scanning: false,
  };

  function setMessage(message, isError = false) {
    elements.message.hidden = !message;
    elements.message.textContent = message || '';
    elements.message.classList.toggle('error', Boolean(isError));
  }

  function updateButton() {
    elements.button.disabled = state.scanning || !state.available;
    elements.button.textContent = state.scanning
      ? 'Scansione in corso…'
      : 'Scansiona libreria musicale';
  }

  function formatDuration(milliseconds) {
    const value = Math.max(0, Number(milliseconds || 0));
    if (value < 1000) return `${value} ms`;
    return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} s`;
  }

  function renderReport(report) {
    const counts = report?.counts || {};
    elements.created.textContent = counts.created ?? 0;
    elements.updated.textContent = counts.updated ?? 0;
    elements.reactivated.textContent = counts.reactivated ?? 0;
    elements.missing.textContent = counts.missing ?? 0;
    elements.unchanged.textContent = counts.unchanged ?? 0;
    elements.ignored.textContent = counts.ignored ?? 0;
    elements.errors.textContent = counts.errors ?? 0;
    elements.summary.textContent = `${counts.supported ?? 0} file musicali controllati su ${counts.visited ?? 0} file trovati.`;
    elements.duration.textContent = `Completata in ${formatDuration(report?.durationMs)}.`;

    const issues = Array.isArray(report?.issues) ? report.issues : [];
    elements.issues.replaceChildren(...issues.map((issue) => {
      const item = document.createElement('li');
      const path = document.createElement('strong');
      path.textContent = issue.relativePath || 'File sconosciuto';
      const message = document.createElement('span');
      message.textContent = issue.message || 'File ignorato.';
      item.append(path, message);
      return item;
    }));
    elements.issuesPanel.hidden = issues.length === 0;
    elements.issuesNote.textContent = report?.issuesTruncated
      ? 'L’elenco è stato limitato ai primi 100 problemi.'
      : '';
    elements.results.hidden = false;
  }

  async function loadAvailability() {
    try {
      const payload = await window.BaiaPage.apiRequest('/api/uploads/status');
      state.available = payload.musicLibraryScanAvailable === true;
      elements.availability.textContent = state.available
        ? 'Disponibile dal browser amministrativo locale. La scansione aggiorna soltanto SQLite e non modifica i file.'
        : 'La scansione è disponibile soltanto dal browser amministrativo aperto sul PC server.';
      elements.availability.classList.toggle('library-info-error', !state.available);
    } catch (error) {
      state.available = false;
      elements.availability.textContent = error.message;
      elements.availability.classList.add('library-info-error');
    }
    updateButton();
  }

  async function runScan() {
    if (state.scanning || !state.available) return;
    state.scanning = true;
    updateButton();
    setMessage('Scansione della cartella Musica in corso…');
    try {
      const payload = await window.BaiaPage.apiRequest('/api/uploads/music/scan-library', {
        method: 'POST',
      });
      renderReport(payload.report);
      setMessage('Scansione completata. Il catalogo musicale è stato aggiornato.');
      window.BaiaPage.shellToast('Scansione libreria musicale completata');
      window.dispatchEvent(new CustomEvent('baia-library-scan-complete', {
        detail: payload.report,
      }));
    } catch (error) {
      setMessage(error.message, true);
    } finally {
      state.scanning = false;
      updateButton();
    }
  }

  elements.button.addEventListener('click', runScan);
  loadAvailability();
})();
