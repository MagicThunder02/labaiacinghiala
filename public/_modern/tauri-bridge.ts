import {
  parseApiTransportResponse,
  parseAppUpdateProgress,
  parseAppUpdateStatus,
  parseCoreBootstrap,
  parsePairingStatus,
  type ApiTransportRequest,
  type ApiTransportResponse,
  type AppUpdateProgress,
  type AppUpdateStatus,
  type CoreBootstrap,
  type PairingStatus,
} from '../../shared/api-contracts.js';

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

type ChannelMessage = (message: unknown) => void;

interface ChannelLike {
  onmessage: ChannelMessage;
}

type ChannelConstructor = new () => ChannelLike;

interface TauriCoreApi {
  invoke?: Invoke;
  Channel?: ChannelConstructor;
}

interface TauriGlobal {
  core?: TauriCoreApi;
}

declare global {
  interface Window {
    __TAURI__?: TauriGlobal;
  }
}

function coreApi(): TauriCoreApi | null {
  try {
    if (window.parent !== window && window.parent.__TAURI__?.core) return window.parent.__TAURI__.core;
    return window.__TAURI__?.core ?? null;
  } catch {
    return null;
  }
}

function requireInvoke(): Invoke {
  const invoke = coreApi()?.invoke;
  if (!invoke) throw new Error('Baia Core non disponibile.');
  return invoke;
}

export function isTauriRuntime(): boolean {
  return Boolean(coreApi()?.invoke);
}

export async function coreBootstrap(): Promise<CoreBootstrap> {
  return parseCoreBootstrap(await requireInvoke()('baia_core_bootstrap'));
}

export async function pairingStatus(): Promise<PairingStatus> {
  return parsePairingStatus(await requireInvoke()('baia_core_pairing_status'));
}

export async function coreApiRequest(request: ApiTransportRequest): Promise<ApiTransportResponse> {
  return parseApiTransportResponse(await requireInvoke()('baia_core_api_request', { request }));
}

export async function appUpdateStatus(): Promise<AppUpdateStatus> {
  return parseAppUpdateStatus(await requireInvoke()('baia_core_update_status'));
}

export async function installAppUpdate(
  onProgress?: (progress: AppUpdateProgress) => void,
): Promise<void> {
  const api = coreApi();
  const invoke = api?.invoke;
  const ChannelCtor = api?.Channel;
  if (!invoke || !ChannelCtor) throw new Error('Baia Core non disponibile.');

  const channel = new ChannelCtor();
  channel.onmessage = (message) => {
    if (!onProgress) return;
    // Un avanzamento malformato non deve interrompere un'installazione in corso.
    try {
      onProgress(parseAppUpdateProgress(message));
    } catch {}
  };
  await invoke('baia_core_update_install', { onProgress: channel });
}

// Il bridge espone soltanto comandi di dominio noti. Non esiste alcun metodo
// generico per firmare byte o invocare nomi di comando forniti dal chiamante.
