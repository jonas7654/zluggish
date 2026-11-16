import { render } from 'svelte/server';
import Game from './pages/Game.svelte';
import type { GamePageModel } from '../lib/game-app.dto';

export function renderGamePage(page: GamePageModel) {
  return render(Game, { props: { page } });
}
