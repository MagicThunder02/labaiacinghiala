<script lang="ts">
  import { onMount } from 'svelte';
  import { coreBootstrap, isTauriRuntime, pairingStatus } from './tauri-bridge';

  let announcement = 'Client web Baia pronto.';

  onMount(() => {
    document.documentElement.dataset.baiaFrontend = 'vite-svelte-incremental';
    if (!isTauriRuntime()) return;

    void Promise.all([coreBootstrap(), pairingStatus()])
      .then(([runtime, pairing]) => {
        document.documentElement.dataset.baiaPlatform = runtime.platform;
        document.documentElement.dataset.baiaTransport = runtime.transport;
        document.documentElement.dataset.baiaPaired = String(pairing.paired);
        announcement = pairing.paired
          ? 'Baia Core connesso tramite Host Connector.'
          : 'Baia Core pronto per il pairing.';
        window.dispatchEvent(new CustomEvent('baia-modern-shell-ready', {
          detail: { platform: runtime.platform, transport: runtime.transport, paired: pairing.paired },
        }));
      })
      .catch(() => {
        announcement = 'Baia Core non disponibile.';
      });
  });
</script>

<div class="baia-modern-shell-status" aria-live="polite">{announcement}</div>

<style>
  .baia-modern-shell-status {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
