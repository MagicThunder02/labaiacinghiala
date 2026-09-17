import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appUpdateStatus,
  coreApiRequest,
  coreBootstrap,
  installAppUpdate,
  isTauriRuntime,
  pairingStatus,
} from '../public/_modern/tauri-bridge';

const bootstrap = {
  coreVersion: '1.0.0',
  platform: 'windows',
  apiBaseUrl: 'http://127.0.0.1:3000',
  transport: 'connector',
  installationId: 'installation-1',
};

const pairing = {
  paired: true,
  currentServerMatches: true,
  suggestedDeviceName: 'PC test',
  serverBaseUrl: 'https://baia.test',
  deviceId: 'device-1',
  deviceName: 'PC test',
  fingerprint: 'fingerprint',
  pairedAt: '2026-01-01T00:00:00.000Z',
};

describe('Tauri bridge', () => {
  const invoke = vi.fn();

  beforeEach(() => {
    invoke.mockReset();
    window.__TAURI__ = { core: { invoke } };
  });

  it('rileva il runtime ed espone solo i comandi di dominio', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === 'baia_core_bootstrap') return bootstrap;
      if (command === 'baia_core_pairing_status') return pairing;
      throw new Error(`unexpected command: ${command}`);
    });

    expect(isTauriRuntime()).toBe(true);
    await expect(coreBootstrap()).resolves.toEqual(bootstrap);
    await expect(pairingStatus()).resolves.toEqual(pairing);
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      'baia_core_bootstrap',
      'baia_core_pairing_status',
    ]);
  });

  it('valida la risposta del trasporto API', async () => {
    invoke.mockResolvedValue({ status: 200, ok: true, headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const request = { path: '/api/health', method: 'GET' as const, headers: {}, body: null };

    await expect(coreApiRequest(request)).resolves.toEqual({
      status: 200,
      ok: true,
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(invoke).toHaveBeenCalledWith('baia_core_api_request', { request });

    invoke.mockResolvedValueOnce({ status: '200', ok: true, headers: {}, body: '{}' });
    await expect(coreApiRequest(request)).rejects.toThrow('Risposta del trasporto');
  });

  it('valida lo stato aggiornamento del client', async () => {
    const status = {
      supported: true,
      available: true,
      currentVersion: '0.5.0',
      latestVersion: '0.6.0',
      notes: 'Correzioni',
      publishedAt: '2026-09-18T10:00:00Z',
      unsupportedReason: null,
    };
    invoke.mockResolvedValueOnce(status);
    await expect(appUpdateStatus()).resolves.toEqual(status);
    expect(invoke).toHaveBeenCalledWith('baia_core_update_status');

    invoke.mockResolvedValueOnce({ supported: true, available: true, currentVersion: '0.5.0' });
    await expect(appUpdateStatus()).rejects.toThrow('senza versione utilizzabile');
  });

  it('inoltra l avanzamento valido e ignora i messaggi malformati', async () => {
    const messages: unknown[] = [];
    class FakeChannel {
      onmessage: (message: unknown) => void = () => {};
    }
    const created: FakeChannel[] = [];
    window.__TAURI__ = {
      core: {
        invoke,
        Channel: class extends FakeChannel {
          constructor() {
            super();
            created.push(this);
          }
        },
      },
    };
    invoke.mockImplementation(async (_command: string, args?: Record<string, unknown>) => {
      const channel = args?.onProgress as FakeChannel;
      channel.onmessage({ phase: 'download', downloaded: 10, total: 100 });
      channel.onmessage({ phase: 'riavvio-non-previsto' });
      channel.onmessage({ phase: 'install', downloaded: 100, total: 100 });
      return undefined;
    });

    await expect(installAppUpdate((progress) => messages.push(progress))).resolves.toBeUndefined();
    expect(created).toHaveLength(1);
    expect(messages).toEqual([
      { phase: 'download', downloaded: 10, total: 100 },
      { phase: 'install', downloaded: 100, total: 100 },
    ]);
    expect(invoke.mock.calls[0]?.[0]).toBe('baia_core_update_install');
  });

  it('senza canale di avanzamento l installazione non parte', async () => {
    window.__TAURI__ = { core: { invoke } };
    await expect(installAppUpdate()).rejects.toThrow('Baia Core non disponibile');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('fallisce esplicitamente fuori da Tauri', async () => {
    delete window.__TAURI__;
    expect(isTauriRuntime()).toBe(false);
    await expect(coreBootstrap()).rejects.toThrow('Baia Core non disponibile');
  });
});
