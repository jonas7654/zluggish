import 'vite/modulepreload-polyfill';
import { hydrate, mount } from 'svelte';
import Launcher from './pages/Launcher.svelte';
import type { LauncherPage } from '../src/dtos/launcher.dto.js';

const target = document.querySelector<HTMLElement>('#launcher-ui');
const data = document.querySelector('#launcher-props');

if (target && data?.textContent) {
  // SAFETY: props are serialized by the same-origin Svelte render adapter.
  const page = JSON.parse(data.textContent) as LauncherPage;

  if (['login', 'add', 'dashboard'].includes(page.kind)) {
    hydrate(Launcher, { target, props: { page } });
  } else {
    target.replaceChildren();
    mount(Launcher, { target, props: { page } });
  }
}
