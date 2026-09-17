import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
  isTauriRuntime: vi.fn(() => false),
  coreBootstrap: vi.fn(),
  pairingStatus: vi.fn(),
}));

vi.mock('../public/_modern/tauri-bridge', () => bridge);

import ShellMigrationIsland from '../public/_modern/ShellMigrationIsland.svelte';

describe('ShellMigrationIsland', () => {
  let component: ReturnType<typeof mount> | null = null;

  beforeEach(() => {
    bridge.isTauriRuntime.mockReturnValue(false);
    bridge.coreBootstrap.mockReset();
    bridge.pairingStatus.mockReset();
  });

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
  });

  it('marca la migrazione incrementale nel browser web', async () => {
    component = mount(ShellMigrationIsland, { target: document.body });
    await tick();

    expect(document.documentElement.dataset.baiaFrontend).toBe('vite-svelte-incremental');
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toContain('Client web Baia pronto');
    expect(bridge.coreBootstrap).not.toHaveBeenCalled();
  });

  it('pubblica stato ed evento quando il Core Tauri è pronto', async () => {
    bridge.isTauriRuntime.mockReturnValue(true);
    bridge.coreBootstrap.mockResolvedValue({ platform: 'windows', transport: 'connector' });
    bridge.pairingStatus.mockResolvedValue({ paired: true });
    const ready = vi.fn();
    window.addEventListener('baia-modern-shell-ready', ready);

    component = mount(ShellMigrationIsland, { target: document.body });
    await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());

    expect(document.documentElement.dataset).toMatchObject({
      baiaPlatform: 'windows',
      baiaTransport: 'connector',
      baiaPaired: 'true',
    });
    expect(document.body.textContent).toContain('Baia Core connesso');
    expect(ready.mock.calls[0][0]).toBeInstanceOf(CustomEvent);
    expect((ready.mock.calls[0][0] as CustomEvent).detail).toEqual({
      platform: 'windows',
      transport: 'connector',
      paired: true,
    });
    window.removeEventListener('baia-modern-shell-ready', ready);
  });

  it('mostra un fallback accessibile quando il Core fallisce', async () => {
    bridge.isTauriRuntime.mockReturnValue(true);
    bridge.coreBootstrap.mockRejectedValue(new Error('offline'));
    bridge.pairingStatus.mockResolvedValue({ paired: false });

    component = mount(ShellMigrationIsland, { target: document.body });
    await vi.waitFor(() => expect(document.body.textContent).toContain('Baia Core non disponibile'));
  });
});
