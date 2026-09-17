import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const projectRoot = __dirname;
const publicRoot = resolve(projectRoot, 'public');
const outputRoot = resolve(projectRoot, 'dist');

function filesWithExtension(root: string, extension: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) files.push(...filesWithExtension(absolute, extension));
    else if (entry.isFile() && extname(entry.name) === extension) files.push(absolute);
  }
  return files;
}

function copyLegacyStaticTree(): Plugin {
  return {
    name: 'baia-copy-legacy-static-tree',
    closeBundle() {
      const copy = (directory: string): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const source = join(directory, entry.name);
          const relativePath = relative(publicRoot, source);
          const segments = relativePath.split(sep);
          if (segments[0] === '_modern' || extname(entry.name) === '.html') continue;
          const destination = join(outputRoot, relativePath);
          if (entry.isDirectory()) {
            mkdirSync(destination, { recursive: true });
            copy(source);
          } else if (entry.isFile()) {
            mkdirSync(resolve(destination, '..'), { recursive: true });
            cpSync(source, destination);
          }
        }
      };
      if (existsSync(publicRoot)) copy(publicRoot);
    },
  };
}

const tauriDevHost = process.env.TAURI_DEV_HOST;

export default defineConfig({
  root: publicRoot,
  publicDir: false,
  clearScreen: false,
  plugins: [
    svelte(),
    {
      name: 'baia-inject-svelte-shell-island',
      transformIndexHtml: {
        order: 'pre',
        handler(html, context) {
          if (context.path !== '/' && context.path !== '/index.html') return html;
          return {
            html,
            tags: [{
              tag: 'script',
              attrs: { type: 'module', src: '/_modern/main.ts' },
              injectTo: 'body',
            }],
          };
        },
      },
    },
    copyLegacyStaticTree(),
  ],
  build: {
    outDir: outputRoot,
    emptyOutDir: true,
    rollupOptions: {
      input: filesWithExtension(publicRoot, '.html'),
    },
  },
  server: {
    port: 1430,
    strictPort: true,
    host: tauriDevHost || '127.0.0.1',
    hmr: tauriDevHost ? { protocol: 'ws', host: tauriDevHost, port: 1431 } : undefined,
    proxy: {
      '/api': 'http://127.0.0.1:3000',
    },
    watch: {
      ignored: ['**/src-tauri/**', '**/host-connector/**', '**/relay/**'],
    },
  },
});
