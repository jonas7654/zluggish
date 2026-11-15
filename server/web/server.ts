import { render } from 'svelte/server';
import Prototype from './pages/Prototype.svelte';
import type { PrototypePage } from '../src/dtos/launcher.dto.js';

export function renderPrototype(props: PrototypePage) {
  return render(Prototype, { props });
}
