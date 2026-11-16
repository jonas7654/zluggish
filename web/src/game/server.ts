import { render } from 'svelte/server';
import Launcher from './pages/Launcher.svelte';
import type { LauncherPage } from '../lib/game-app.dto';

export function renderPage(page: LauncherPage) {
  return render(Launcher, { props: { page } });
}
