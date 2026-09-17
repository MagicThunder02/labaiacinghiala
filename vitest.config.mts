import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    conditions: ['browser'],
  },
  test: {
    environment: 'jsdom',
    include: ['frontend-tests/**/*.vitest.ts'],
    setupFiles: ['./frontend-tests/setup.ts'],
    restoreMocks: true,
    clearMocks: true,
    unstubGlobals: true,
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: './coverage/frontend',
      include: [
        'public/_modern/api-client.ts',
        'public/_modern/tauri-bridge.ts',
        'public/_modern/ShellMigrationIsland.svelte',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 70,
      },
    },
  },
});
