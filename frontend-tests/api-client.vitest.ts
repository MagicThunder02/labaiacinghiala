import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
  isTauriRuntime: vi.fn(() => false),
  coreApiRequest: vi.fn(),
}));

vi.mock('../public/_modern/tauri-bridge', () => bridge);

import { requestJson } from '../public/_modern/api-client';

describe('requestJson', () => {
  beforeEach(() => {
    bridge.isTauriRuntime.mockReturnValue(false);
    bridge.coreApiRequest.mockReset();
  });

  it('usa fetch nel browser e normalizza il metodo', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(requestJson('/api/health', { method: 'get' })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/health', expect.objectContaining({ method: 'GET' }));
  });

  it('propaga gli errori applicativi tipizzati', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      '{"error":"Accesso negato","code":"FORBIDDEN"}',
      { status: 403 },
    )));

    await expect(requestJson('/api/private')).rejects.toMatchObject({
      name: 'ApiClientError',
      message: 'Accesso negato',
      status: 403,
      code: 'FORBIDDEN',
    });
  });

  it('rifiuta URL, metodi, header e body non ammessi prima del trasporto', async () => {
    await expect(requestJson('https://example.test/api/data')).rejects.toThrow('path relativi');
    await expect(requestJson('/api/data', { method: 'PATCH' })).rejects.toThrow('Metodo API');
    bridge.isTauriRuntime.mockReturnValue(true);
    await expect(requestJson('/api/data', { headers: { authorization: 'secret' } })).rejects.toThrow('Header API');
    await expect(requestJson('/api/data', { body: new Blob(['x']) })).rejects.toThrow('stringa JSON');
  });

  it('delega al Core Tauri soltanto il contratto normalizzato', async () => {
    bridge.isTauriRuntime.mockReturnValue(true);
    bridge.coreApiRequest.mockResolvedValue({
      status: 200,
      ok: true,
      headers: { 'content-type': 'application/json' },
      body: '{"paired":true}',
    });

    await expect(requestJson('/api/status', {
      method: 'post',
      headers: { 'Content-Type': 'application/json' },
      body: '{"probe":true}',
    })).resolves.toEqual({ paired: true });
    expect(bridge.coreApiRequest).toHaveBeenCalledWith({
      path: '/api/status',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"probe":true}',
    });
  });

  it('segnala una risposta non JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not-json', { status: 200 })));
    await expect(requestJson('/api/data')).rejects.toMatchObject({
      name: 'ApiClientError',
      status: 200,
    });
  });
});
