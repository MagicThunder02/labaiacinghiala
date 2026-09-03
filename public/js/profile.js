(async () => {
  const elements = {
    accountHeading: document.querySelector('#accountHeading'),
    accountRoleBadge: document.querySelector('#accountRoleBadge'),
    accountMessage: document.querySelector('#accountMessage'),
    accountDetails: document.querySelector('#accountDetails'),
    accountUsername: document.querySelector('#accountUsername'),
    accountRole: document.querySelector('#accountRole'),
    accountSections: document.querySelector('#accountSections'),
    accountBinding: document.querySelector('#accountBinding'),
    passwordForm: document.querySelector('#passwordForm'),
    passwordHeading: document.querySelector('#passwordHeading'),
    passwordDescription: document.querySelector('#passwordDescription'),
    currentPasswordField: document.querySelector('#currentPasswordField'),
    currentPassword: document.querySelector('#currentPassword'),
    newPassword: document.querySelector('#newPassword'),
    confirmPassword: document.querySelector('#confirmPassword'),
    passwordSubmit: document.querySelector('#passwordSubmit'),
    passwordMessage: document.querySelector('#passwordMessage'),
    profileLogout: document.querySelector('#profileLogout'),
    returnToLogin: document.querySelector('#returnToLogin'),
    applicationName: document.querySelector('#applicationName'),
    uiVersion: document.querySelector('#uiVersion'),
    serverVersion: document.querySelector('#serverVersion'),
    coreVersion: document.querySelector('#coreVersion'),
    coreInstallationId: document.querySelector('#coreInstallationId'),
    deviceIdentity: document.querySelector('#deviceIdentity'),
    devicePublicKey: document.querySelector('#devicePublicKey'),
    deviceSecretStorage: document.querySelector('#deviceSecretStorage'),
    pairingStatus: document.querySelector('#pairingStatus'),
    pairingSettings: document.querySelector('#pairingSettings'),
    pairingForm: document.querySelector('#pairingForm'),
    pairingDeviceName: document.querySelector('#pairingDeviceName'),
    pairingInviteToken: document.querySelector('#pairingInviteToken'),
    pairingSubmit: document.querySelector('#pairingSubmit'),
    pairingMessage: document.querySelector('#pairingMessage'),
    coreTransport: document.querySelector('#coreTransport'),
    coreEndpoint: document.querySelector('#coreEndpoint'),
    coreServerStatus: document.querySelector('#coreServerStatus'),
    connectionSettings: document.querySelector('#connectionSettings'),
    serverEndpointForm: document.querySelector('#serverEndpointForm'),
    serverEndpointInput: document.querySelector('#serverEndpointInput'),
    resetServerEndpoint: document.querySelector('#resetServerEndpoint'),
    endpointMessage: document.querySelector('#endpointMessage'),
  };

  const SECTION_LABELS = Object.freeze({
    films: 'Film',
    series: 'Serie',
    music: 'Musica',
    books: 'Libri',
    comics: 'Fumetti',
    manga: 'Manga',
  });

  let accountState = null;

  function setMessage(element, message, isError = false) {
    element.textContent = message || '';
    element.classList.toggle('error', Boolean(isError));
  }

  function showEndpointMessage(message, isError = false) {
    setMessage(elements.endpointMessage, message, isError);
  }

  function showPairingMessage(message, isError = false) {
    setMessage(elements.pairingMessage, message, isError);
  }

  function showPasswordMessage(message, isError = false) {
    setMessage(elements.passwordMessage, message, isError);
  }

  function roleLabel(role) {
    return role === 'admin' ? 'Amministratore' : 'Utente';
  }

  function bindingLabel(state) {
    if (state.localAccess) return 'Browser amministrativo locale';
    const source = state.device?.bindingSource;
    if (source === 'legacy') return 'Accesso migrato · imposta una password';
    if (source === 'login') return `Accesso su ${state.device?.deviceName || 'questo dispositivo'}`;
    if (source === 'admin') return 'Accesso amministrativo';
    return state.device?.deviceName || 'Dispositivo verificato';
  }

  function renderAccountState(state) {
    accountState = state;
    const authenticated = Boolean(state?.authenticated && state.account);
    elements.accountDetails.hidden = !authenticated;
    elements.passwordForm.hidden = !authenticated;
    elements.accountRoleBadge.hidden = !authenticated;
    elements.returnToLogin.hidden = authenticated;

    if (!authenticated) {
      elements.accountHeading.textContent = 'Nessun account attivo';
      elements.accountMessage.textContent = 'Il dispositivo può essere associato al server senza essere collegato a un account.';
      return;
    }

    const { account } = state;
    const sections = (state.sections || []).map((section) => SECTION_LABELS[section] || section);
    elements.accountHeading.textContent = account.username;
    elements.accountRoleBadge.textContent = roleLabel(account.role);
    elements.accountRoleBadge.hidden = false;
    elements.accountMessage.textContent = account.mustChangePassword
      ? 'Completa la configurazione impostando una password personale.'
      : '';
    elements.accountUsername.textContent = account.username || '—';
    elements.accountRole.textContent = roleLabel(account.role);
    elements.accountSections.textContent = sections.length ? sections.join(', ') : 'Nessuna';
    elements.accountBinding.textContent = bindingLabel(state);

    const passwordConfigured = account.passwordConfigured === undefined
      ? !(account.mustChangePassword && (state.localAccess || state.device?.bindingSource === 'legacy'))
      : Boolean(account.passwordConfigured);
    elements.currentPasswordField.hidden = !passwordConfigured;
    elements.currentPassword.required = passwordConfigured;
    elements.passwordHeading.textContent = passwordConfigured ? 'Cambia password' : 'Imposta password';
    elements.passwordDescription.textContent = passwordConfigured
      ? 'La modifica invaliderà gli accessi precedenti sugli altri dispositivi collegati a questo account.'
      : 'Imposta la prima password dell’account. Gli altri dispositivi già associati dovranno poi effettuare il login.';
    elements.profileLogout.hidden = Boolean(state.localAccess);
  }

  async function loadAccountState() {
    try {
      const state = await window.BaiaPage.apiRequest('/api/auth/me');
      renderAccountState(state);
      return state;
    } catch (error) {
      renderAccountState({ authenticated: false });
      elements.accountMessage.textContent = error.message;
      return null;
    }
  }

  async function loadServerInfo() {
    try {
      const payload = await window.BaiaPage.apiRequest('/api/app-info');
      elements.applicationName.textContent = payload.app.name;
      elements.uiVersion.textContent = payload.app.uiVersion;
      elements.serverVersion.textContent = payload.app.serverVersion;
      return true;
    } catch (error) {
      elements.serverVersion.textContent = 'Non raggiungibile';
      window.BaiaPage.shellToast(error.message);
      return false;
    }
  }

  function renderBootstrap(bootstrap) {
    elements.coreVersion.textContent = `${bootstrap.coreVersion} · ${bootstrap.platform}`;
    elements.coreInstallationId.textContent = bootstrap.installationId || '—';
    elements.coreTransport.textContent = bootstrap.transport;
    elements.coreEndpoint.textContent = bootstrap.apiBaseUrl;
    elements.serverEndpointInput.value = bootstrap.apiBaseUrl;
  }

  async function loadDeviceIdentity() {
    elements.deviceIdentity.textContent = 'Caricamento…';
    elements.devicePublicKey.textContent = '—';
    elements.deviceSecretStorage.textContent = '—';
    try {
      const identity = await window.BaiaApi.getDeviceIdentity();
      if (!identity) {
        elements.deviceIdentity.textContent = 'Non disponibile';
        return false;
      }
      elements.deviceIdentity.textContent = `${identity.algorithm} · ${identity.fingerprint}`;
      elements.devicePublicKey.textContent = identity.publicKey;
      elements.deviceSecretStorage.textContent = identity.secretStorage;
      return true;
    } catch (error) {
      elements.deviceIdentity.textContent = 'Errore identità';
      elements.deviceSecretStorage.textContent = error?.message || String(error);
      return false;
    }
  }

  async function refreshProbe() {
    elements.coreServerStatus.textContent = 'Verifica…';
    try {
      const probe = await window.BaiaApi.probeServer();
      elements.coreServerStatus.textContent = probe?.reachable
        ? `Raggiungibile · ${probe.elapsedMs} ms`
        : 'Non raggiungibile';
      return Boolean(probe?.reachable);
    } catch {
      elements.coreServerStatus.textContent = 'Verifica non disponibile';
      return false;
    }
  }

  function renderPairingStatus(status) {
    if (!status?.paired) {
      elements.pairingStatus.textContent = 'Non associato';
      if (!elements.pairingDeviceName.value && status?.suggestedDeviceName) {
        elements.pairingDeviceName.value = status.suggestedDeviceName;
      }
      return;
    }

    if (status.currentServerMatches) {
      elements.pairingStatus.textContent = `${status.deviceName} · dispositivo verificato`;
    } else {
      elements.pairingStatus.textContent = `Associato a ${status.serverBaseUrl}; endpoint corrente diverso`;
    }
    if (status.deviceName) elements.pairingDeviceName.value = status.deviceName;
  }

  async function loadPairingStatus() {
    elements.pairingStatus.textContent = 'Verifica…';
    try {
      const status = await window.BaiaApi.getPairingStatus();
      renderPairingStatus(status);
      return status;
    } catch (error) {
      elements.pairingStatus.textContent = 'Stato pairing non disponibile';
      showPairingMessage(error?.message || String(error), true);
      return null;
    }
  }

  elements.passwordForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!accountState?.authenticated) return;
    if (elements.newPassword.value !== elements.confirmPassword.value) {
      showPasswordMessage('Le due nuove password non coincidono.', true);
      elements.confirmPassword.focus();
      return;
    }

    elements.passwordSubmit.disabled = true;
    showPasswordMessage('Salvataggio…');
    try {
      const updated = await window.BaiaPage.apiRequest('/api/auth/password', {
        method: 'PUT',
        body: JSON.stringify({
          currentPassword: elements.currentPassword.value,
          newPassword: elements.newPassword.value,
        }),
      });
      renderAccountState(updated);
      elements.passwordForm.reset();
      showPasswordMessage('Password aggiornata. Gli altri dispositivi dovranno effettuare nuovamente l’accesso.');
      window.BaiaPage.shellAccountRefresh();
    } catch (error) {
      showPasswordMessage(error.message, true);
    } finally {
      elements.passwordSubmit.disabled = false;
    }
  });

  elements.profileLogout.addEventListener('click', async () => {
    elements.profileLogout.disabled = true;
    showPasswordMessage('Disconnessione…');
    try {
      await window.BaiaPage.apiRequest('/api/auth/logout', { method: 'POST' });
      window.BaiaPage.shellAccountSignedOut();
    } catch (error) {
      showPasswordMessage(error.message, true);
      elements.profileLogout.disabled = false;
    }
  });

  elements.returnToLogin.addEventListener('click', () => window.BaiaPage.shellShowAccountGate());

  await Promise.all([loadServerInfo(), loadAccountState()]);

  if (!window.BaiaApi?.isTauri?.()) {
    elements.coreTransport.textContent = 'Web diretto';
    elements.coreEndpoint.textContent = window.BaiaApi?.getBaseUrl() || window.location.origin;
    elements.coreServerStatus.textContent = 'Gestito dal browser';
    elements.deviceIdentity.textContent = 'Browser amministrativo locale';
    elements.deviceSecretStorage.textContent = 'Non disponibile nel browser';
    elements.pairingStatus.textContent = 'Accesso locale, pairing non necessario';
    return;
  }

  const bootstrap = await window.BaiaApi.getCoreBootstrap();
  if (!bootstrap) {
    elements.coreVersion.textContent = 'Non disponibile';
    elements.coreTransport.textContent = 'Fallback HTTP';
    elements.coreEndpoint.textContent = window.BaiaApi.getBaseUrl() || '—';
    elements.coreServerStatus.textContent = 'Core non inizializzato';
    elements.deviceIdentity.textContent = 'Core non inizializzato';
    return;
  }

  elements.connectionSettings.hidden = false;
  elements.pairingSettings.hidden = false;
  renderBootstrap(bootstrap);
  await Promise.all([loadDeviceIdentity(), refreshProbe(), loadPairingStatus()]);

  elements.pairingForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const inviteToken = elements.pairingInviteToken.value.trim();
    if (!inviteToken) {
      showPairingMessage('Incolla un invito Baia valido.', true);
      return;
    }

    elements.pairingSubmit.disabled = true;
    showPairingMessage('Associazione in corso…');
    try {
      const status = await window.BaiaApi.pairWithInvite(inviteToken, elements.pairingDeviceName.value);
      renderPairingStatus(status);
      elements.pairingInviteToken.value = '';
      showPairingMessage('Dispositivo associato. Ora puoi accedere con un account Baia.');
      window.BaiaPage.shellAccountRefresh();
    } catch (error) {
      showPairingMessage(error?.message || String(error), true);
    } finally {
      elements.pairingSubmit.disabled = false;
    }
  });

  elements.serverEndpointForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    showEndpointMessage('Salvataggio…');
    try {
      const updated = await window.BaiaApi.setServerEndpoint(elements.serverEndpointInput.value);
      renderBootstrap(updated);
      const reachable = await refreshProbe();
      await Promise.all([loadServerInfo(), loadPairingStatus()]);
      showEndpointMessage(reachable
        ? 'Indirizzo salvato nel Baia Core e server raggiungibile.'
        : 'Indirizzo salvato, ma il server non è raggiungibile.');
      window.BaiaPage.shellAccountRefresh();
    } catch (error) {
      showEndpointMessage(error?.message || String(error), true);
    }
  });

  elements.resetServerEndpoint.addEventListener('click', async () => {
    showEndpointMessage('Ripristino…');
    try {
      const updated = await window.BaiaApi.resetServerEndpoint();
      renderBootstrap(updated);
      const reachable = await refreshProbe();
      await Promise.all([loadServerInfo(), loadPairingStatus()]);
      showEndpointMessage(reachable
        ? 'Endpoint locale ripristinato e server raggiungibile.'
        : 'Endpoint locale ripristinato, ma il server non è raggiungibile.');
      window.BaiaPage.shellAccountRefresh();
    } catch (error) {
      showEndpointMessage(error?.message || String(error), true);
    }
  });
})();
