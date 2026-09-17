import { afterEach } from 'vitest';

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute('data-baia-frontend');
  document.documentElement.removeAttribute('data-baia-platform');
  document.documentElement.removeAttribute('data-baia-transport');
  document.documentElement.removeAttribute('data-baia-paired');
  delete window.__TAURI__;
});
