import { render } from 'svelte/server';
import Launcher from './pages/Launcher.svelte';
import type { LauncherPage } from '../src/dtos/launcher.dto.js';

export function renderPage(page: LauncherPage) {
  return render(Launcher, { props: { page } });
}
