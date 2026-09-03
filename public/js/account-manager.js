'use strict';

(() => {
  const SECTION_KEYS = Object.freeze(['films', 'series', 'music', 'books', 'comics', 'manga']);
  const SECTION_LABELS = Object.freeze({
    films: 'Film',
    series: 'Serie',
    music: 'Musica',
    books: 'Libri',
    comics: 'Fumetti',
    manga: 'Manga',
  });

  const INVITE_HISTORY_BATCH_SIZE = 10;

  const elements = {
    pageMessage: document.querySelector('#pageMessage'),
    accountToolbar: document.querySelector('#accountToolbar'),
    inviteToolbar: document.querySelector('#inviteToolbar'),
    accountsTab: document.querySelector('#accountsTab'),
    invitesTab: document.querySelector('#invitesTab'),
    devicesTab: document.querySelector('#devicesTab'),
    accountsPanel: document.querySelector('#accountsPanel'),
    invitesPanel: document.querySelector('#invitesPanel'),
    devicesPanel: document.querySelector('#devicesPanel'),
    refreshAccounts: document.querySelector('#refreshAccounts'),
    newAccount: document.querySelector('#newAccount'),
    accountCount: document.querySelector('#accountCount'),
    accountSearch: document.querySelector('#accountSearch'),
    accountList: document.querySelector('#accountList'),
    accountEmpty: document.querySelector('#accountEmpty'),
    editorContent: document.querySelector('#editorContent'),
    editorEyebrow: document.querySelector('#editorEyebrow'),
    editorTitle: document.querySelector('#editorTitle'),
    editorSubtitle: document.querySelector('#editorSubtitle'),
    editorStatus: document.querySelector('#editorStatus'),
    accountForm: document.querySelector('#accountForm'),
    username: document.querySelector('#username'),
    role: document.querySelector('#role'),
    disabledField: document.querySelector('#disabledField'),
    disabled: document.querySelector('#disabled'),
    sectionsHint: document.querySelector('#sectionsHint'),
    sectionChoices: document.querySelector('#sectionChoices'),
    initialPasswordSection: document.querySelector('#initialPasswordSection'),
    initialPassword: document.querySelector('#initialPassword'),
    initialPasswordConfirm: document.querySelector('#initialPasswordConfirm'),
    initialMustChange: document.querySelector('#initialMustChange'),
    cancelEdit: document.querySelector('#cancelEdit'),
    saveAccount: document.querySelector('#saveAccount'),
    existingAccountSecurity: document.querySelector('#existingAccountSecurity'),
    passwordResetForm: document.querySelector('#passwordResetForm'),
    resetPassword: document.querySelector('#resetPassword'),
    resetPasswordConfirm: document.querySelector('#resetPasswordConfirm'),
    resetMustChange: document.querySelector('#resetMustChange'),
    resetPasswordSubmit: document.querySelector('#resetPasswordSubmit'),
    selfPasswordNotice: document.querySelector('#selfPasswordNotice'),
    activeDevicesText: document.querySelector('#activeDevicesText'),
    logoutDevices: document.querySelector('#logoutDevices'),
    deleteAccount: document.querySelector('#deleteAccount'),
    refreshInvites: document.querySelector('#refreshInvites'),
    newInviteShortcut: document.querySelector('#newInviteShortcut'),
    deviceToolbar: document.querySelector('#deviceToolbar'),
    refreshDevices: document.querySelector('#refreshDevices'),
    inviteCreateCard: document.querySelector('#inviteCreateCard'),
    inviteForm: document.querySelector('#inviteForm'),
    inviteTtlMinutes: document.querySelector('#inviteTtlMinutes'),
    createInvite: document.querySelector('#createInvite'),
    createdInvitePanel: document.querySelector('#createdInvitePanel'),
    createdInviteToken: document.querySelector('#createdInviteToken'),
    createdInviteExpiry: document.querySelector('#createdInviteExpiry'),
    copyCreatedInvite: document.querySelector('#copyCreatedInvite'),
    dismissCreatedInvite: document.querySelector('#dismissCreatedInvite'),
    inviteCount: document.querySelector('#inviteCount'),
    inviteStatusFilter: document.querySelector('#inviteStatusFilter'),
    inviteList: document.querySelector('#inviteList'),
    inviteEmpty: document.querySelector('#inviteEmpty'),
    inviteLoadMore: document.querySelector('#inviteLoadMore'),
    deviceCount: document.querySelector('#deviceCount'),
    deviceStatusFilter: document.querySelector('#deviceStatusFilter'),
    deviceList: document.querySelector('#deviceList'),
    deviceEmpty: document.querySelector('#deviceEmpty'),
  };

  let accounts = [];
  let selectedAccountId = '';
  let creating = false;
  let userSectionDraft = [];
  let localPairingManagement = false;
  let activeView = 'accounts';
  let invites = [];
  let invitesLoaded = false;
  let visibleInviteCount = INVITE_HISTORY_BATCH_SIZE;
  let devices = [];
  let devicesLoaded = false;

  function setMessage(message, isError = false) {
    elements.pageMessage.textContent = message || '';
    elements.pageMessage.classList.toggle('error', Boolean(isError));
  }

  function roleLabel(role) {
    return role === 'admin' ? 'Amministratore' : 'Utente';
  }


  const INVITE_STATUS_LABELS = Object.freeze({
    active: 'Attivo',
    used: 'Usato',
    expired: 'Scaduto',
    revoked: 'Revocato',
  });

  function formatDateTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('it-IT', {
      dateStyle: 'short',
      timeStyle: 'short',
    });
  }

  function setActiveView(view, { load = true } = {}) {
    const localViewRequested = view === 'invites' || view === 'devices';
    const nextView = localViewRequested && localPairingManagement ? view : 'accounts';
    activeView = nextView;

    const accountsActive = nextView === 'accounts';
    const invitesActive = nextView === 'invites';
    const devicesActive = nextView === 'devices';

    elements.accountsTab.classList.toggle('active', accountsActive);
    elements.accountsTab.setAttribute('aria-selected', String(accountsActive));
    elements.invitesTab.classList.toggle('active', invitesActive);
    elements.invitesTab.setAttribute('aria-selected', String(invitesActive));
    elements.devicesTab.classList.toggle('active', devicesActive);
    elements.devicesTab.setAttribute('aria-selected', String(devicesActive));

    elements.accountsPanel.hidden = !accountsActive;
    elements.invitesPanel.hidden = !invitesActive;
    elements.devicesPanel.hidden = !devicesActive;
    elements.accountToolbar.hidden = !accountsActive;
    elements.inviteToolbar.hidden = !invitesActive;
    elements.deviceToolbar.hidden = !devicesActive;

    setMessage('');
    if (invitesActive && load && !invitesLoaded) void loadInvites();
    if (devicesActive && load && !devicesLoaded) void loadDevices();
  }

  async function resolveLocalPairingManagementAccess() {
    try {
      const state = await window.BaiaPage.apiRequest('/api/auth/me');
      localPairingManagement = Boolean(
        state?.authenticated
        && state?.localAccess
        && state?.account?.role === 'admin',
      );
    } catch {
      localPairingManagement = false;
    }

    elements.invitesTab.hidden = !localPairingManagement;
    elements.devicesTab.hidden = !localPairingManagement;
    if (!localPairingManagement && (activeView === 'invites' || activeView === 'devices')) {
      setActiveView('accounts', { load: false });
    }
  }

  function accountById(accountId) {
    return accounts.find((account) => account.id === accountId) || null;
  }

  function selectedSections() {
    return [...elements.sectionChoices.querySelectorAll('input[type="checkbox"]:checked')]
      .map((input) => input.value)
      .filter((value) => SECTION_KEYS.includes(value));
  }

  function setSelectedSections(sections) {
    const selected = new Set(Array.isArray(sections) ? sections : []);
    for (const input of elements.sectionChoices.querySelectorAll('input[type="checkbox"]')) {
      input.checked = selected.has(input.value);
    }
  }

  function syncRoleSections({ preserveUserSelection = true } = {}) {
    const admin = elements.role.value === 'admin';
    const inputs = [...elements.sectionChoices.querySelectorAll('input[type="checkbox"]')];
    if (admin) {
      if (preserveUserSelection) userSectionDraft = selectedSections();
      for (const input of inputs) {
        input.checked = true;
        input.disabled = true;
      }
      elements.sectionsHint.textContent = 'Gli amministratori accedono sempre a tutte le sezioni.';
      return;
    }
    for (const input of inputs) input.disabled = false;
    if (preserveUserSelection && userSectionDraft.length) setSelectedSections(userSectionDraft);
    elements.sectionsHint.textContent = 'Seleziona i cataloghi disponibili per questo account.';
  }

  function accountMatchesSearch(account) {
    const query = elements.accountSearch.value.trim().toLocaleLowerCase('it');
    if (!query) return true;
    return `${account.username} ${roleLabel(account.role)}`
      .toLocaleLowerCase('it')
      .includes(query);
  }

  function makeAccountListItem(account) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'account-list-item';
    button.classList.toggle('active', !creating && selectedAccountId === account.id);
    button.classList.toggle('disabled', account.disabled);
    button.dataset.accountId = account.id;
    button.setAttribute('role', 'listitem');

    const name = document.createElement('span');
    name.className = 'account-list-name';
    name.textContent = account.username;

    const meta = document.createElement('span');
    meta.className = 'account-list-meta';
    const role = document.createElement('span');
    role.className = `account-role-chip ${account.role}`;
    role.textContent = account.disabled ? 'Disabilitato' : roleLabel(account.role);
    const devices = document.createElement('span');
    devices.className = 'account-list-devices';
    devices.textContent = `${account.activeDeviceCount} ${account.activeDeviceCount === 1 ? 'dispositivo' : 'dispositivi'}`;
    meta.append(role, devices);

    if (account.current) name.textContent += ' · account corrente';
    button.append(name, meta);
    button.addEventListener('click', () => selectAccount(account.id));
    return button;
  }

  function renderAccountList() {
    const filtered = accounts.filter(accountMatchesSearch);
    elements.accountCount.textContent = `${accounts.length} ${accounts.length === 1 ? 'account' : 'account'}`;
    elements.accountList.replaceChildren(...filtered.map(makeAccountListItem));
    elements.accountEmpty.hidden = filtered.length > 0;
  }

  function showEditor() {
    elements.editorContent.hidden = false;
  }

  function renderSecurityState(account) {
    const self = Boolean(account.current);
    elements.passwordResetForm.hidden = self;
    elements.selfPasswordNotice.hidden = !self;
    elements.logoutDevices.disabled = self || account.activeDeviceCount === 0;
    elements.deleteAccount.disabled = self;
    elements.activeDevicesText.textContent = account.activeDeviceCount === 0
      ? 'Nessun dispositivo con sessione valida.'
      : `${account.activeDeviceCount} ${account.activeDeviceCount === 1 ? 'dispositivo collegato' : 'dispositivi collegati'}.`;
  }

  function renderExistingAccount(account) {
    creating = false;
    selectedAccountId = account.id;
    showEditor();
    elements.editorEyebrow.textContent = account.current ? 'Account corrente' : 'Account';
    elements.editorTitle.textContent = account.username;
    elements.editorSubtitle.textContent = `Creato ${new Date(account.createdAt).toLocaleDateString('it-IT')}`;
    elements.editorStatus.hidden = false;
    elements.editorStatus.textContent = account.disabled ? 'Disabilitato' : 'Attivo';
    elements.editorStatus.className = `account-status ${account.disabled ? 'disabled' : 'active'}`;

    elements.username.value = account.username;
    elements.role.value = account.role;
    elements.role.disabled = account.current;
    elements.disabledField.hidden = false;
    elements.disabled.checked = account.disabled;
    elements.disabled.disabled = account.current;
    userSectionDraft = account.role === 'user' ? [...account.sections] : [];
    setSelectedSections(account.sections);
    syncRoleSections({ preserveUserSelection: false });

    elements.initialPasswordSection.hidden = true;
    elements.initialPassword.required = false;
    elements.initialPasswordConfirm.required = false;
    elements.existingAccountSecurity.hidden = false;
    elements.saveAccount.textContent = 'Salva modifiche';
    elements.cancelEdit.textContent = 'Annulla modifiche';
    renderSecurityState(account);
    renderAccountList();
  }

  function renderCreateAccount() {
    creating = true;
    selectedAccountId = '';
    showEditor();
    elements.accountForm.reset();
    elements.passwordResetForm.reset();
    elements.editorEyebrow.textContent = 'Nuovo account';
    elements.editorTitle.textContent = 'Crea un account';
    elements.editorSubtitle.textContent = 'L’account potrà essere usato su più dispositivi verificati.';
    elements.editorStatus.hidden = true;
    elements.role.disabled = false;
    elements.role.value = 'user';
    elements.disabledField.hidden = true;
    elements.disabled.disabled = false;
    elements.disabled.checked = false;
    userSectionDraft = [];
    setSelectedSections([]);
    syncRoleSections({ preserveUserSelection: false });
    elements.initialPasswordSection.hidden = false;
    elements.initialPassword.required = true;
    elements.initialPasswordConfirm.required = true;
    elements.initialMustChange.checked = true;
    elements.existingAccountSecurity.hidden = true;
    elements.saveAccount.textContent = 'Crea account';
    elements.cancelEdit.textContent = 'Annulla';
    renderAccountList();
    elements.username.focus();
  }

  function selectAccount(accountId) {
    const account = accountById(accountId);
    if (!account) return;
    elements.accountForm.reset();
    elements.passwordResetForm.reset();
    renderExistingAccount(account);
  }

  async function loadAccounts({ preferredId = selectedAccountId, showStatus = false } = {}) {
    elements.refreshAccounts.disabled = true;
    if (showStatus) setMessage('Aggiornamento account…');
    try {
      const payload = await window.BaiaPage.apiRequest('/api/admin/accounts');
      accounts = Array.isArray(payload?.accounts) ? payload.accounts : [];
      renderAccountList();
      if (creating) return;
      const next = accountById(preferredId) || accounts[0] || null;
      if (next) renderExistingAccount(next);
      else renderCreateAccount();
      if (showStatus) setMessage('Elenco account aggiornato.');
    } catch (error) {
      setMessage(error.message, true);
    } finally {
      elements.refreshAccounts.disabled = false;
    }
  }


  function inviteMatchesFilter(invite) {
    const filter = elements.inviteStatusFilter.value;
    return filter === 'all' || invite.status === filter;
  }

  function inviteStatusLabel(status) {
    return INVITE_STATUS_LABELS[status] || status || 'Sconosciuto';
  }

  function makeInviteDetail(label, value) {
    const row = document.createElement('div');
    row.className = 'invite-detail';
    const key = document.createElement('span');
    key.textContent = label;
    const content = document.createElement('strong');
    content.textContent = value;
    row.append(key, content);
    return row;
  }

  function makeInviteListItem(invite) {
    const card = document.createElement('article');
    card.className = `invite-list-item ${invite.status || ''}`;
    card.setAttribute('role', 'listitem');

    const heading = document.createElement('header');
    heading.className = 'invite-list-heading';
    const title = document.createElement('div');
    const eyebrow = document.createElement('span');
    eyebrow.className = 'invite-id';
    eyebrow.textContent = `Invito ${String(invite.id || '').slice(0, 8)}`;
    const name = document.createElement('h3');
    name.textContent = invite.device?.deviceName || 'Nuovo dispositivo';
    title.append(eyebrow, name);

    const status = document.createElement('span');
    status.className = `invite-status ${invite.status || ''}`;
    status.textContent = inviteStatusLabel(invite.status);
    heading.append(title, status);

    const details = document.createElement('div');
    details.className = 'invite-details';
    details.append(
      makeInviteDetail('Creato', formatDateTime(invite.createdAt)),
      makeInviteDetail('Scadenza', formatDateTime(invite.expiresAt)),
    );
    if (invite.status === 'used') {
      details.append(makeInviteDetail('Usato', formatDateTime(invite.usedAt)));
    } else if (invite.status === 'revoked') {
      details.append(makeInviteDetail('Revocato', formatDateTime(invite.revokedAt)));
    }

    card.append(heading, details);
    if (invite.status === 'active') {
      const actions = document.createElement('div');
      actions.className = 'invite-actions';
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'danger-button compact';
      revoke.textContent = 'Revoca invito';
      revoke.addEventListener('click', () => revokeInvite(invite, revoke));
      actions.append(revoke);
      card.append(actions);
    }
    return card;
  }

  function renderInviteList() {
    const filtered = invites.filter(inviteMatchesFilter);
    const visible = filtered.slice(0, visibleInviteCount);
    const activeCount = invites.filter((invite) => invite.status === 'active').length;
    const totalLabel = `${invites.length} ${invites.length === 1 ? 'invito' : 'inviti'}`;
    elements.inviteCount.textContent = activeCount > 0
      ? `${totalLabel} · ${activeCount} ${activeCount === 1 ? 'attivo' : 'attivi'}`
      : totalLabel;
    elements.inviteList.replaceChildren(...visible.map(makeInviteListItem));
    elements.inviteEmpty.hidden = filtered.length > 0;
    elements.inviteLoadMore.hidden = visible.length >= filtered.length;
  }

  async function loadInvites({ showStatus = false } = {}) {
    if (!localPairingManagement) return;
    elements.refreshInvites.disabled = true;
    if (showStatus) setMessage('Aggiornamento inviti…');
    try {
      const payload = await window.BaiaPage.apiRequest('/api/admin/pairing-invites');
      invites = Array.isArray(payload?.invites) ? payload.invites : [];
      invitesLoaded = true;
      visibleInviteCount = INVITE_HISTORY_BATCH_SIZE;
      renderInviteList();
      if (showStatus) setMessage('Elenco inviti aggiornato.');
    } catch (error) {
      setMessage(error.message, true);
    } finally {
      elements.refreshInvites.disabled = false;
    }
  }

  function showCreatedInvite(invite) {
    const shareValue = invite.directBootstrap || invite.token || '';
    elements.createdInviteToken.textContent = shareValue;
    elements.createdInviteExpiry.textContent = `Scade ${formatDateTime(invite.expiresAt)}.`;
    elements.createdInvitePanel.hidden = false;
    elements.copyCreatedInvite.textContent = invite.directBootstrap ? 'Copia invito Baia' : 'Copia token';
    elements.createdInvitePanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function copyText(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    if (!copied) throw new Error('Copia non disponibile in questo browser.');
  }

  async function revokeInvite(invite, button) {
    if (!invite?.id || invite.status !== 'active') return;
    if (!window.confirm('Revocare questo invito? Il token non potrà più essere utilizzato.')) return;
    button.disabled = true;
    setMessage('Revoca invito…');
    try {
      await window.BaiaPage.apiRequest(`/api/admin/pairing-invites/${invite.id}/revoke`, {
        method: 'POST',
      });
      await loadInvites();
      setMessage('Invito revocato.');
    } catch (error) {
      setMessage(error.message, true);
      button.disabled = false;
    }
  }

  function deviceStatus(device) {
    return device?.revokedAt ? 'revoked' : 'active';
  }

  function deviceMatchesFilter(device) {
    const filter = elements.deviceStatusFilter.value;
    return filter === 'all' || deviceStatus(device) === filter;
  }

  function makeDeviceDetail(label, value, { mono = false } = {}) {
    const row = document.createElement('div');
    row.className = 'device-detail';
    const key = document.createElement('span');
    key.textContent = label;
    const content = document.createElement('strong');
    content.textContent = value || '—';
    if (mono) content.classList.add('mono');
    row.append(key, content);
    return row;
  }

  function makeDeviceListItem(device) {
    const statusValue = deviceStatus(device);
    const card = document.createElement('article');
    card.className = `device-list-item ${statusValue}`;
    card.setAttribute('role', 'listitem');

    const heading = document.createElement('header');
    heading.className = 'device-list-heading';

    const title = document.createElement('div');
    const eyebrow = document.createElement('span');
    eyebrow.className = 'device-id';
    eyebrow.textContent = `Dispositivo ${String(device.id || '').slice(0, 8)}`;
    const name = document.createElement('h3');
    name.textContent = device.deviceName || 'Dispositivo Baia';
    title.append(eyebrow, name);

    const status = document.createElement('span');
    status.className = `device-status ${statusValue}`;
    status.textContent = statusValue === 'revoked' ? 'Revocato' : 'Attivo';
    heading.append(title, status);

    const details = document.createElement('div');
    details.className = 'device-details';
    details.append(
      makeDeviceDetail('ID dispositivo', device.id, { mono: true }),
      makeDeviceDetail('Associato', formatDateTime(device.pairedAt)),
      makeDeviceDetail('Ultima attività', formatDateTime(device.lastSeenAt)),
      makeDeviceDetail('Fingerprint', device.fingerprint, { mono: true }),
      makeDeviceDetail('Installazione', device.installationId, { mono: true }),
    );
    if (statusValue === 'revoked') {
      details.append(makeDeviceDetail('Revocato', formatDateTime(device.revokedAt)));
    }

    card.append(heading, details);

    if (statusValue === 'active') {
      const actions = document.createElement('div');
      actions.className = 'device-actions';
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'danger-button compact';
      revoke.textContent = 'Revoca dispositivo';
      revoke.addEventListener('click', () => revokeDevice(device, revoke));
      actions.append(revoke);
      card.append(actions);
    }

    return card;
  }

  function renderDeviceList() {
    const filtered = devices.filter(deviceMatchesFilter);
    const activeCount = devices.filter((device) => deviceStatus(device) === 'active').length;
    const totalLabel = `${devices.length} ${devices.length === 1 ? 'dispositivo' : 'dispositivi'}`;
    elements.deviceCount.textContent = activeCount > 0
      ? `${totalLabel} · ${activeCount} ${activeCount === 1 ? 'attivo' : 'attivi'}`
      : totalLabel;
    elements.deviceList.replaceChildren(...filtered.map(makeDeviceListItem));
    elements.deviceEmpty.hidden = filtered.length > 0;
  }

  async function loadDevices({ showStatus = false } = {}) {
    if (!localPairingManagement) return;
    elements.refreshDevices.disabled = true;
    if (showStatus) setMessage('Aggiornamento dispositivi…');
    try {
      const payload = await window.BaiaPage.apiRequest('/api/admin/paired-devices');
      devices = Array.isArray(payload?.devices) ? payload.devices : [];
      devicesLoaded = true;
      renderDeviceList();
      if (showStatus) setMessage('Elenco dispositivi aggiornato.');
    } catch (error) {
      setMessage(error.message, true);
    } finally {
      elements.refreshDevices.disabled = false;
    }
  }

  async function revokeDevice(device, button) {
    if (!device?.id || deviceStatus(device) !== 'active') return;
    const name = device.deviceName || 'questo dispositivo';
    const confirmed = window.confirm(
      `Revocare ${name}? Il server bloccherà immediatamente le nuove richieste firmate da questo dispositivo. Per riutilizzarlo sarà necessario un nuovo pairing con un nuovo invito.`,
    );
    if (!confirmed) return;

    button.disabled = true;
    setMessage('Revoca dispositivo…');
    try {
      await window.BaiaPage.apiRequest(`/api/admin/paired-devices/${device.id}/revoke`, {
        method: 'POST',
      });
      await loadDevices();
      setMessage(`Dispositivo ${name} revocato.`);
    } catch (error) {
      setMessage(error.message, true);
      button.disabled = false;
    }
  }

  function validateMatchingPasswords(password, confirmation) {
    if (password !== confirmation) {
      throw new Error('Le due password non coincidono.');
    }
  }

  function validatedUsername(value) {
    const username = String(value ?? '').normalize('NFKC');
    if (username !== username.trim()
      || username.length < 3
      || username.length > 64
      || !/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(username)) {
      throw new Error('Lo username deve contenere da 3 a 64 caratteri: lettere, numeri, punto, trattino o underscore, senza spazi.');
    }
    return username;
  }

  elements.accountForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!elements.accountForm.reportValidity()) return;
    elements.saveAccount.disabled = true;
    setMessage(creating ? 'Creazione account…' : 'Salvataggio modifiche…');

    try {
      const username = validatedUsername(elements.username.value);
      if (creating) {
        validateMatchingPasswords(elements.initialPassword.value, elements.initialPasswordConfirm.value);
        const payload = await window.BaiaPage.apiRequest('/api/admin/accounts', {
          method: 'POST',
          body: JSON.stringify({
            username,
            password: elements.initialPassword.value,
            role: elements.role.value,
            sections: selectedSections(),
            mustChangePassword: elements.initialMustChange.checked,
          }),
        });
        await loadAccounts({ preferredId: payload.account.id });
        setMessage(`Account ${payload.account.username} creato.`);
        return;
      }

      const selected = accountById(selectedAccountId);
      if (!selected) throw new Error('Account non più disponibile.');
      const payload = await window.BaiaPage.apiRequest(`/api/admin/accounts/${selected.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          username,
          role: elements.role.value,
          sections: selectedSections(),
          disabled: elements.disabled.checked,
        }),
      });
      await loadAccounts({ preferredId: payload.account.id });
      if (selected.current) window.BaiaPage.shellAccountRefresh();
      setMessage(`Account ${payload.account.username} aggiornato.`);
    } catch (error) {
      setMessage(error.message, true);
    } finally {
      elements.saveAccount.disabled = false;
    }
  });

  elements.passwordResetForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const account = accountById(selectedAccountId);
    if (!account || account.current || !elements.passwordResetForm.reportValidity()) return;
    elements.resetPasswordSubmit.disabled = true;
    setMessage('Reimpostazione password…');
    try {
      validateMatchingPasswords(elements.resetPassword.value, elements.resetPasswordConfirm.value);
      const payload = await window.BaiaPage.apiRequest(`/api/admin/accounts/${account.id}/password`, {
        method: 'PUT',
        body: JSON.stringify({
          password: elements.resetPassword.value,
          mustChangePassword: elements.resetMustChange.checked,
        }),
      });
      elements.passwordResetForm.reset();
      elements.resetMustChange.checked = true;
      await loadAccounts({ preferredId: payload.account.id });
      setMessage(`Password di ${payload.account.username} reimpostata. Tutti i dispositivi sono stati disconnessi.`);
    } catch (error) {
      setMessage(error.message, true);
    } finally {
      elements.resetPasswordSubmit.disabled = false;
    }
  });

  elements.logoutDevices.addEventListener('click', async () => {
    const account = accountById(selectedAccountId);
    if (!account || account.current) return;
    if (!window.confirm(`Disconnettere tutti i dispositivi collegati a ${account.username}?`)) return;
    elements.logoutDevices.disabled = true;
    setMessage('Disconnessione dispositivi…');
    try {
      const payload = await window.BaiaPage.apiRequest(`/api/admin/accounts/${account.id}/logout-devices`, {
        method: 'POST',
      });
      await loadAccounts({ preferredId: account.id });
      setMessage(`${payload.loggedOutDevices} ${payload.loggedOutDevices === 1 ? 'dispositivo disconnesso' : 'dispositivi disconnessi'}.`);
    } catch (error) {
      setMessage(error.message, true);
    }
  });

  elements.deleteAccount.addEventListener('click', async () => {
    const account = accountById(selectedAccountId);
    if (!account || account.current) return;
    if (!window.confirm(`Eliminare l’account ${account.username}? I dati personali saranno conservati, ma l’account non potrà più accedere.`)) return;
    elements.deleteAccount.disabled = true;
    setMessage('Eliminazione account…');
    try {
      await window.BaiaPage.apiRequest(`/api/admin/accounts/${account.id}/delete`, { method: 'POST' });
      selectedAccountId = '';
      await loadAccounts();
      setMessage(`Account ${account.username} eliminato.`);
    } catch (error) {
      setMessage(error.message, true);
      elements.deleteAccount.disabled = false;
    }
  });

  elements.role.addEventListener('change', () => syncRoleSections());
  elements.accountSearch.addEventListener('input', renderAccountList);
  elements.newAccount.addEventListener('click', renderCreateAccount);
  elements.refreshAccounts.addEventListener('click', () => loadAccounts({ showStatus: true }));
  elements.cancelEdit.addEventListener('click', () => {
    if (creating) {
      const next = accounts[0];
      if (next) selectAccount(next.id);
      else renderCreateAccount();
      return;
    }
    const account = accountById(selectedAccountId);
    if (account) renderExistingAccount(account);
  });

  elements.accountsTab.addEventListener('click', () => setActiveView('accounts'));
  elements.invitesTab.addEventListener('click', () => setActiveView('invites'));
  elements.devicesTab.addEventListener('click', () => setActiveView('devices'));
  elements.refreshInvites.addEventListener('click', () => loadInvites({ showStatus: true }));
  elements.refreshDevices.addEventListener('click', () => loadDevices({ showStatus: true }));
  elements.deviceStatusFilter.addEventListener('change', renderDeviceList);
  elements.newInviteShortcut.addEventListener('click', () => {
    elements.inviteCreateCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    elements.inviteTtlMinutes.focus();
  });
  elements.inviteStatusFilter.addEventListener('change', () => {
    visibleInviteCount = INVITE_HISTORY_BATCH_SIZE;
    renderInviteList();
  });
  elements.inviteLoadMore.addEventListener('click', () => {
    visibleInviteCount += INVITE_HISTORY_BATCH_SIZE;
    renderInviteList();
  });
  elements.dismissCreatedInvite.addEventListener('click', () => {
    elements.createdInvitePanel.hidden = true;
    elements.createdInviteToken.textContent = '';
    elements.createdInviteExpiry.textContent = '';
  });
  elements.copyCreatedInvite.addEventListener('click', async () => {
    const token = elements.createdInviteToken.textContent;
    if (!token) return;
    elements.copyCreatedInvite.disabled = true;
    try {
      await copyText(token);
      elements.copyCreatedInvite.textContent = 'Copiato';
      setMessage('Token copiato negli appunti.');
    } catch (error) {
      setMessage(error.message, true);
    } finally {
      elements.copyCreatedInvite.disabled = false;
    }
  });
  elements.inviteForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!localPairingManagement || !elements.inviteForm.reportValidity()) return;
    const ttlMinutes = Number(elements.inviteTtlMinutes.value);
    if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 1440) {
      setMessage('La durata deve essere compresa tra 1 e 1440 minuti.', true);
      return;
    }
    elements.createInvite.disabled = true;
    setMessage('Creazione invito…');
    try {
      const payload = await window.BaiaPage.apiRequest('/api/admin/pairing-invites', {
        method: 'POST',
        body: JSON.stringify({ ttlMinutes }),
      });
      showCreatedInvite(payload.invite || {});
      await loadInvites();
      setMessage('Invito creato. Copialo subito: verrà mostrato una sola volta.');
    } catch (error) {
      setMessage(error.message, true);
    } finally {
      elements.createInvite.disabled = false;
    }
  });

  setActiveView('accounts', { load: false });
  void Promise.all([
    resolveLocalPairingManagementAccess(),
    loadAccounts(),
  ]);
})();
