import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  coreApiRequest,
  coreBootstrap,
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

  it('fallisce esplicitamente fuori da Tauri', async () => {
    delete window.__TAURI__;
    expect(isTauriRuntime()).toBe(false);
    await expect(coreBootstrap()).rejects.toThrow('Baia Core non disponibile');
  });
});
