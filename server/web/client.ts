import 'vite/modulepreload-polyfill';
import { hydrate } from 'svelte';
import Prototype from './pages/Prototype.svelte';
import type { PrototypePage } from '../src/dtos/launcher.dto.js';

const target = document.querySelector<HTMLElement>('#launcher-ui');
const data = document.querySelector('#launcher-props');
if (target && data?.textContent) {
  hydrate(Prototype, { target, props: JSON.parse(data.textContent) as PrototypePage });
}
